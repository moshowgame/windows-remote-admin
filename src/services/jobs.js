'use strict';

// PowerShell 后台长任务管理器（Job 模型：执行与 HTTP 响应解耦）
// - 每任务独立一次性 powershell.exe 进程，不占用交互会话（user:<username>）串行队列
// - 输出环形缓冲 8MB，SSE 实时推送（150ms / 4KB 聚合），断开重连 / 页面刷新可回放
// - 状态机 running → done | failed | timeout | cancelled；超时与终止统一 taskkill /T /F
// - 每用户并发 ≤ 3（不排队直接拒绝）；任务级超时硬上限 24h
// - data/jobs.json 持久化最近 100 条元数据（不含输出正文）；启动时遗留 running 标记
//   failed（进程树已随重启消亡）+ 孤儿 .ps1 脚本清扫
// - 命令体经 stdin（Base64 → Invoke-Expression）或 -File 脚本文件执行，
//   绝不经 argv 插值；脚本文件 UTF-8 BOM 落盘（PowerShell 5.1 无 BOM 按 ANSI 解析）
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { cleanClixml } = require('./powershell');

const JOBS_DIR = path.join(__dirname, '..', '..', 'data', 'jobs');
const JOBS_FILE = path.join(__dirname, '..', '..', 'data', 'jobs.json');
const MAX_PER_USER = 3;                       // 每用户运行中并发上限
const DEFAULT_TIMEOUT = 30 * 60 * 1000;       // 默认超时预算 30min
const MIN_TIMEOUT = 10 * 1000;                // 最小 10s
const MAX_TIMEOUT = 24 * 60 * 60 * 1000;      // 硬上限 24h
const RING_MAX = 8 * 1024 * 1024;             // 输出环形缓冲 8MB（保留最近）
const SCRIPT_MAX = 256 * 1024;                // 脚本文本限额 256KB
const COMMAND_MAX = 256 * 1024;               // 命令文本限额 256KB
const KEEP = 100;                             // 持久化保留条数
const RETAIN_MS = 24 * 60 * 60 * 1000;        // 结束任务保留查看时长
const FLUSH_MS = 150;                         // SSE 输出聚合窗口
const FLUSH_BYTES = 4 * 1024;                 // 聚合字节阈值
const ERRBUF_MAX = 2 * 1024 * 1024;           // stderr 累积上限
const HEARTBEAT_MS = 5000;                    // 运行中任务状态心跳
const PING_MS = 15 * 1000;                    // SSE 保活注释帧
const STDOUT_CAP = 64 * 1024 * 1024;          // 单任务 stdout 累计上限（防失控）

const jobs = new Map();        // id -> job
const outputSubs = new Map();  // id -> Set<res>（单任务输出 SSE 订阅者）
const eventSubs = new Map();   // username -> Set<res>（用户级事件流订阅者）

// ---- 持久化 ----
function persistJobs() {
  const plain = [...jobs.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, KEEP)
    .map((j) => ({
      id: j.id, user: j.user, kind: j.kind,
      command: j.commandPreview, state: j.state,
      createdAt: j.createdAt, startedAt: j.startedAt, endedAt: j.endedAt,
      timeoutMs: j.timeoutMs, exitCode: j.exitCode,
      error: j.error, truncated: j.truncated, lines: j.lines,
    }));
  try {
    fs.mkdirSync(path.dirname(JOBS_FILE), { recursive: true });
    fs.writeFileSync(JOBS_FILE, JSON.stringify({ jobs: plain }, null, 2));
  } catch { /* 磁盘异常不阻断任务 */ }
}

function restoreJobs() {
  try {
    if (!fs.existsSync(JOBS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
    for (const p of (Array.isArray(data.jobs) ? data.jobs : []).slice(0, KEEP)) {
      if (!p || !p.id || !p.user) continue;
      // 重启后进程树已消亡：遗留 running 一律标记 failed
      if (p.state === 'running' || p.state === 'queued') {
        p.state = 'failed';
        p.error = '服务重启中断';
        p.endedAt = Date.now();
      }
      jobs.set(p.id, {
        id: p.id, user: p.user, kind: p.kind || 'command',
        command: p.command || '', commandPreview: p.command || '',
        state: p.state, createdAt: p.createdAt || Date.now(),
        startedAt: p.startedAt || null, endedAt: p.endedAt || null,
        timeoutMs: p.timeoutMs || DEFAULT_TIMEOUT, exitCode: p.exitCode ?? null,
        error: p.error || '', truncated: !!p.truncated,
        lines: p.lines || 0, output: '', // 输出正文不持久化，重启后不可回放
        child: null, hbTimer: null,
      });
    }
  } catch { /* 快照损坏时按空恢复 */ }
  // 孤儿脚本清扫（对应任务进程已不存在）
  try {
    if (fs.existsSync(JOBS_DIR)) {
      for (const f of fs.readdirSync(JOBS_DIR)) {
        if (f.endsWith('.ps1')) { try { fs.unlinkSync(path.join(JOBS_DIR, f)); } catch { /* 忽略 */ } }
      }
    }
  } catch { /* 忽略 */ }
}

// ---- SSE 帧工具 ----
function sseWrite(res, text) {
  try { res.write(text); } catch { /* 连接已断 */ }
}
function frameEvent(res, event, obj) {
  sseWrite(res, `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`);
}
function frameData(res, str) {
  sseWrite(res, `data: ${JSON.stringify(String(str))}\n\n`);
}
// 订阅者通用收尾：保活 + 断开自动退订
function watchConnection(res, onclose) {
  const ping = setInterval(() => sseWrite(res, ': ping\n\n'), PING_MS);
  if (ping.unref) ping.unref();
  res.on('close', () => {
    clearInterval(ping);
    if (onclose) onclose();
  });
}

// ---- 用户级事件流（任务面板刷新源）----
function subscribeEvents(username, res) {
  let set = eventSubs.get(username);
  if (!set) { set = new Set(); eventSubs.set(username, set); }
  set.add(res);
  watchConnection(res, () => set.delete(res));
  return () => set.delete(res);
}
function broadcastUser(username, event, data) {
  const set = eventSubs.get(username);
  if (!set || !set.size) return;
  for (const res of set) frameEvent(res, event, data);
}

// ---- 单任务输出订阅 ----
// 订阅即回放：先冲刷未推送的 pending（避免回放快照与实时流重叠重复），
// 再注册订阅者、发送截断标记 + 快照；已结束任务回放后发 eof 终帧并结束连接
function subscribeOutput(job, res) {
  if (job.flushTimer) flushOutput(job);
  const set = outputSubs.get(job.id) || new Set();
  outputSubs.set(job.id, set);
  set.add(res);
  watchConnection(res, () => set.delete(res));

  if (job.truncated) frameData(res, '[输出已截断，仅保留最近 8MB]');
  if (job.output) frameData(res, job.output);
  if (job.state !== 'running' && job.state !== 'queued') {
    frameEvent(res, 'eof', { id: job.id, state: job.state, exitCode: job.exitCode, lines: job.lines });
    try { res.end(); } catch { /* 忽略 */ }
    set.delete(res);
  }
  return () => set.delete(res);
}
function sendEofToSubscribers(job) {
  const set = outputSubs.get(job.id);
  if (!set) return;
  for (const res of set) {
    frameEvent(res, 'eof', { id: job.id, state: job.state, exitCode: job.exitCode, lines: job.lines });
    try { res.end(); } catch { /* 忽略 */ }
  }
  outputSubs.delete(job.id);
}

// ---- 输出缓冲与节流推送 ----
function appendOutput(job, chunk) {
  if (!chunk) return;
  job.lines += (chunk.match(/\n/g) || []).length;
  job.output += chunk;
  if (job.output.length > RING_MAX) {
    job.output = job.output.slice(job.output.length - RING_MAX);
    job.truncated = true;
  }
}
function flushOutput(job) {
  if (job.flushTimer) { clearTimeout(job.flushTimer); job.flushTimer = null; }
  const pending = job.pendingOut;
  job.pendingOut = '';
  if (pending) {
    const set = outputSubs.get(job.id);
    if (set) for (const res of set) frameData(res, pending);
  }
  broadcastUser(job.user, 'job-updated', {
    id: job.id, state: job.state, lines: job.lines,
    elapsedMs: job.startedAt ? Date.now() - job.startedAt : 0,
  });
}
function scheduleFlush(job) {
  if (job.pendingOut.length >= FLUSH_BYTES) return flushOutput(job);
  if (!job.flushTimer) {
    job.flushTimer = setTimeout(() => { job.flushTimer = null; flushOutput(job); }, FLUSH_MS);
    if (job.flushTimer.unref) job.flushTimer.unref();
  }
}

// ---- 进程管理 ----
function killTree(job, reason, state) {
  if (job.state !== 'running') return;
  job.state = state;
  job.error = reason;
  try {
    if (job.child && job.child.exitCode === null) {
      spawn('taskkill', ['/PID', String(job.child.pid), '/T', '/F'], { windowsHide: true });
    }
  } catch { /* 进程可能已退出 */ }
  finishJob(job);
}

function finishJob(job) {
  if (job.hbTimer) { clearInterval(job.hbTimer); job.hbTimer = null; }
  if (job.timeoutTimer) { clearTimeout(job.timeoutTimer); job.timeoutTimer = null; }
  job.endedAt = Date.now();
  // stderr 清洗后并入输出尾部（对齐控制台"合并"口径）；同时并入待推送块，
  // 保证实时订阅者收到——切勿清空 pendingOut，否则最后 150ms 内的 stdout 尾块会丢
  if (job.errbuf) {
    const cleaned = cleanClixml(job.errbuf);
    job.errbuf = '';
    if (cleaned) {
      const block = (job.output && !job.output.endsWith('\n') ? '\n' : '') + cleaned;
      appendOutput(job, block);
      job.pendingOut += block;
    }
  }
  if (job.state === 'running') {
    job.state = job.exitCode === 0 ? 'done' : 'failed';
  }
  flushOutput(job);
  sendEofToSubscribers(job);
  broadcastUser(job.user, 'job-updated', {
    id: job.id, state: job.state, exitCode: job.exitCode,
    durationMs: job.endedAt - (job.startedAt || job.createdAt), lines: job.lines,
  });
  persistJobs();
}

function startProcess(job) {
  job.startedAt = Date.now();
  job.state = 'running';

  let child;
  if (job.kind === 'script') {
    // 脚本模式：落盘 data/jobs/<id>.ps1（UTF-8 BOM，PS 5.1 无 BOM 按 ANSI 解析）
    // 经 -Command 包装器执行（& 调用保留 param() 与多行语义）：包装器前置
    // [Console]::OutputEncoding=UTF8——纯 -File 模式输出编码跟随控制台代码页，中文必乱码
    const ps1 = path.join(JOBS_DIR, `${job.id}.ps1`);
    fs.writeFileSync(ps1, '\ufeff' + job.script, 'utf8');
    job.scriptFile = ps1;
    const ps1Arg = ps1.replace(/'/g, "''");
    child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command',
      `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$ProgressPreference='SilentlyContinue';& '${ps1Arg}'`,
    ], { windowsHide: true, env: process.env });
  } else {
    // 命令模式：-Command - 从 stdin 读取；Base64 → Invoke-Expression 规避转义，
    // 末行 exit 回传 $? 退出码（兼容逐行/整段两种 stdin 语义）
    const b64 = Buffer.from(job.command, 'utf8').toString('base64');
    child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', '-',
    ], { windowsHide: true, env: process.env });
    child.stdin.write(
      `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$ProgressPreference='SilentlyContinue'\n` +
      `Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))\n` +
      `exit $(if ($?) {0} else {1})\n`
    );
    child.stdin.end();
  }
  child.stdin.on('error', () => { /* EPIPE：由 close/超时路径收敛 */ });
  job.child = child;
  job.pid = child.pid;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    if (job.totalOut > STDOUT_CAP) return; // 失控兜底：不再累积
    job.totalOut += d.length;
    appendOutput(job, d);
    job.pendingOut += d;
    scheduleFlush(job);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { if (job.errbuf.length < ERRBUF_MAX) job.errbuf += d; });

  child.on('error', (err) => {
    if (job.state !== 'running') return;
    job.state = 'failed';
    job.error = String(err.message);
    job.exitCode = -1;
    finishJob(job);
  });

  child.on('close', (code) => {
    if (job.state !== 'running') return; // timeout/cancelled 已在 killTree 收敛
    job.exitCode = code === null ? -1 : code;
    finishJob(job);
    // 脚本用后即删
    if (job.scriptFile) {
      try { fs.unlinkSync(job.scriptFile); } catch { /* 忽略 */ }
      job.scriptFile = null;
    }
  });

  // 超时强杀 → timeout
  job.timeoutTimer = setTimeout(() => {
    if (job.state !== 'running') return;
    job.exitCode = -1;
    killTree(job, `任务执行超时（${job.timeoutMs}ms），已强制终止`, 'timeout');
    if (job.scriptFile) { try { fs.unlinkSync(job.scriptFile); } catch { /* 忽略 */ } job.scriptFile = null; }
  }, job.timeoutMs);
  if (job.timeoutTimer.unref) job.timeoutTimer.unref();

  // 运行中心跳：驱动面板耗时刷新
  job.hbTimer = setInterval(() => {
    if (job.state !== 'running') return;
    broadcastUser(job.user, 'job-updated', {
      id: job.id, state: 'running', lines: job.lines,
      elapsedMs: Date.now() - job.startedAt,
    });
  }, HEARTBEAT_MS);
  if (job.hbTimer.unref) job.hbTimer.unref();
}

// ---- 对外 API ----
// 提交长任务：command（ad-hoc 命令）或 script（.ps1 文本，-File 执行）
// 校验失败抛 Error（err.statusCode）
function submit({ username, command, script, timeoutMs }) {
  const kind = script != null && String(script).trim() !== '' ? 'script' : 'command';
  const text = String(kind === 'script' ? script : command || '').trim();
  if (!text) {
    const e = new Error('任务内容不能为空'); e.statusCode = 400; throw e;
  }
  if (Buffer.byteLength(text, 'utf8') > (kind === 'script' ? SCRIPT_MAX : COMMAND_MAX)) {
    const e = new Error('任务内容超过 256KB 限额'); e.statusCode = 400; throw e;
  }
  let budget = Number(timeoutMs);
  if (!Number.isFinite(budget) || budget <= 0) budget = DEFAULT_TIMEOUT;
  budget = Math.min(Math.max(budget, MIN_TIMEOUT), MAX_TIMEOUT);

  let running = 0;
  for (const j of jobs.values()) {
    if (j.user === username && (j.state === 'running' || j.state === 'queued')) running++;
  }
  if (running >= MAX_PER_USER) {
    const e = new Error(`运行中任务已达上限（${MAX_PER_USER}），请先终止部分任务`); e.statusCode = 400; throw e;
  }

  const id = 'j_' + crypto.randomBytes(5).toString('hex');
  const job = {
    id, user: username, kind,
    command: kind === 'command' ? text : '',
    script: kind === 'script' ? text : '',
    commandPreview: text.replace(/\s+/g, ' ').slice(0, 100),
    state: 'queued', createdAt: Date.now(), startedAt: null, endedAt: null,
    timeoutMs: budget, exitCode: null, error: '',
    truncated: false, lines: 0, output: '', errbuf: '',
    totalOut: 0, pendingOut: '', flushTimer: null,
    child: null, pid: null, scriptFile: null,
    timeoutTimer: null, hbTimer: null,
  };
  jobs.set(id, job);
  persistJobs();
  broadcastUser(username, 'job-created', {
    id, command: job.commandPreview, kind, state: 'running', timeoutMs: budget, createdAt: job.createdAt,
  });
  try {
    fs.mkdirSync(JOBS_DIR, { recursive: true });
    startProcess(job);
  } catch (err) {
    job.state = 'failed';
    job.error = `无法启动 PowerShell：${err.message}`;
    job.exitCode = -1;
    finishJob(job);
  }
  return job;
}

// 终止任务（返回是否找到属于该用户的运行中任务）
function cancel(jobId, username) {
  const job = jobs.get(jobId);
  if (!job || job.user !== username) return null;
  if (job.state !== 'running' && job.state !== 'queued') return job; // 已结束：幂等返回
  job.exitCode = -1;
  killTree(job, '被用户手动终止', 'cancelled');
  if (job.scriptFile) { try { fs.unlinkSync(job.scriptFile); } catch { /* 忽略 */ } job.scriptFile = null; }
  return job;
}

function get(jobId) { return jobs.get(jobId); }

// 列表（运行中优先，其余按结束/创建时间倒序），顺带清理超过保留期的历史
function list(username) {
  let changed = false;
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.state !== 'running' && j.state !== 'queued' && j.endedAt && now - j.endedAt > RETAIN_MS) {
      jobs.delete(id); changed = true;
    }
  }
  if (changed) persistJobs();
  const mine = [...jobs.values()].filter((j) => j.user === username);
  mine.sort((a, b) => {
    const ar = a.state === 'running' || a.state === 'queued' ? 1 : 0;
    const br = b.state === 'running' || b.state === 'queued' ? 1 : 0;
    if (ar !== br) return br - ar;
    return (b.endedAt || b.createdAt) - (a.endedAt || a.createdAt);
  });
  return mine.slice(0, KEEP);
}

restoreJobs();

module.exports = { submit, cancel, get, list, subscribeEvents, subscribeOutput };
