'use strict';

// PowerShell 执行服务
// - 默认：按 sessionKey 长驻 PowerShell 会话进程（stdin 喂命令 + 哨兵定界输出），
//   cd / 变量 / 函数 / 已加载模块跨命令保留（连续会话）；空闲 10 分钟自动回收
// - options.fresh = true：退回一次性进程模式，适合需注入临时环境变量的调用
//   （如 Start-Process 的 WRA_OPEN_TARGET），一次性进程不会污染会话
// - 命令经 Base64(UTF8) 解码后 Invoke-Expression：单行喂入避免多行语句被提前执行，
//   且彻底规避引号/特殊字符的转义问题（值不经 PS 解析器插值）
// - 会话内每条命令前置 [Console]::OutputEncoding=UTF8（中文不乱码）+ 关闭进度流噪声
// - 超时：taskkill /T /F 强杀进程树；会话进程被杀后下次调用自动重建（状态重置）
// - CLIXML 错误流清洗（对齐 Go 版逻辑）+ 输出上限 2MB 截断
const { spawn } = require('node:child_process');

const MAX_OUTPUT = 2 * 1024 * 1024;   // 单命令输出上限 2MB
const IDLE_TTL_MS = 10 * 60 * 1000;   // 会话空闲 10 分钟自动回收

// ---- 会话注册表：key -> session ----
const sessions = new Map();

// CLIXML 转义还原：_x000D__x000A_ → \r\n 等，XML 实体反转义
function decodeClixml(text) {
  return text
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// 清洗 CLIXML 错误流：提取 <S> 文本节点，去掉标签噪声
function cleanClixml(raw) {
  if (!raw.includes('#< CLIXML')) return raw;
  let body = raw.replace(/^#<\s*CLIXML\s*/m, '');
  const parts = [];
  const re = /<S\s[^>]*>([\s\S]*?)<\/S>/g;
  let m;
  while ((m = re.exec(body)) !== null) parts.push(decodeClixml(m[1]));
  let result = parts.length ? parts.join('') : body;
  // 兜底去掉残余 XML 标签与收尾标记
  result = result.replace(/<\/?Objs[^>]*>/g, '').replace(/#<\/CLIXML>\s*$/, '').replace(/<[^>]+>/g, '');
  return result;
}

// 创建（或重建）会话进程
function startSession(s) {
  s.child = spawn('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-Command', '-', // 从 stdin 逐条读取并执行，同一进程内状态连续
  ], { windowsHide: true, env: Object.assign({}, process.env, s.env) });
  s.buf = '';
  s.errbuf = '';

  s.child.stdout.setEncoding('utf8');
  s.child.stdout.on('data', (d) => {
    s.buf += d;
    if (s.waiter) checkWaiter(s);
    // 哨兵长时间未到且输出暴涨的兜底保护（正常命令由超时强杀处理）
    if (s.buf.length > MAX_OUTPUT * 8) {
      destroySession(s.key);
      if (s.waiter) {
        const w = s.waiter;
        s.waiter = null;
        w.finish({ ok: false, output: '输出超出会话缓冲上限，会话已重置', durationMs: Date.now() - w.started, exitCode: -1, timedOut: true });
      }
    }
  });
  s.child.stderr.on('data', (d) => { if (s.errbuf.length < MAX_OUTPUT * 2) s.errbuf += d; });

  s.child.on('close', () => {
    if (sessions.get(s.key) === s) sessions.delete(s.key);
    if (s.waiter) {
      const w = s.waiter;
      s.waiter = null;
      clearTimeout(w.timer);
      w.finish({ ok: false, output: 'PowerShell 会话进程已退出，下次执行将自动重建', durationMs: Date.now() - w.started, exitCode: -1, timedOut: false });
    }
  });
  s.child.stdin.on('error', () => { /* EPIPE：进程已死，由 close/重试路径处理 */ });
}

function destroySession(key) {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  try {
    if (s.child && s.child.exitCode === null) {
      spawn('taskkill', ['/PID', String(s.child.pid), '/T', '/F'], { windowsHide: true });
    }
  } catch { /* 进程可能已退出 */ }
}

// 哨兵到达：截取本命令输出并消费缓冲
function checkWaiter(s) {
  const w = s.waiter;
  const idx = s.buf.indexOf(w.marker, w.start);
  if (idx === -1) return;

  const lineEnd = s.buf.indexOf('\n', idx);
  const tail = s.buf.slice(idx + w.marker.length, lineEnd === -1 ? undefined : lineEnd).trim();
  let output = s.buf.slice(w.start, idx);

  // 消费已完成的缓冲，防止长驻会话内存无限增长
  s.buf = lineEnd === -1 ? '' : s.buf.slice(lineEnd + 1);
  s.waiter = null;

  const stderrClean = cleanClixml(s.errbuf.slice(w.errStart));
  s.errbuf = '';
  if (stderrClean) output += (output && !output.endsWith('\n') ? '\n' : '') + stderrClean;
  output = output.replace(/\r\n/g, '\n').trim();
  if (output.length > MAX_OUTPUT) output = output.slice(0, MAX_OUTPUT) + '\n[输出已截断：超过 2MB 上限]';

  const ok = tail === ':0'; // 哨兵后缀：$? → 0/1
  w.finish({ ok, output, durationMs: Date.now() - w.started, exitCode: ok ? 0 : 1, timedOut: false });
}

// 向会话写入单行命令并等待哨兵；进程意外死亡时重建会话并重试一次
function writeAndWait(s, command, timeoutMs, started) {
  return new Promise((resolve) => {
    const marker = `__WRA_DONE_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}__`;
    const b64 = Buffer.from(command, 'utf8').toString('base64');
    const line =
      `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$ProgressPreference='SilentlyContinue';` +
      `Invoke-Expression ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')));` +
      `[Console]::Out.WriteLine('${marker}' + $(if ($?) {':0'} else {':1'}))`;

    const w = {
      marker,
      started,
      retried: false,
      start: s.buf.length,
      errStart: s.errbuf.length,
      finish: null,
      timer: null,
    };
    w.finish = (value) => { clearTimeout(w.timer); resolve(value); };
    w.timer = setTimeout(() => {
      if (s.waiter !== w) return;
      s.waiter = null;
      try {
        spawn('taskkill', ['/PID', String(s.child.pid), '/T', '/F'], { windowsHide: true });
      } catch { /* 进程可能已退出 */ }
      w.finish({
        ok: false,
        output: `命令执行超时（${timeoutMs}ms），已强制终止；会话状态已重置`,
        durationMs: Date.now() - started,
        exitCode: -1,
        timedOut: true,
      });
    }, timeoutMs);

    const send = () => {
      w.start = s.buf.length;
      w.errStart = s.errbuf.length;
      s.child.stdin.write(line + '\n', (err) => {
        if (!err) return;
        // 会话进程已死：重建后重试一次
        if (!w.retried) {
          w.retried = true;
          startSession(s);
          s.child.stdin.write(line + '\n', (err2) => {
            if (err2) {
              s.waiter = null;
              clearTimeout(w.timer);
              w.finish({ ok: false, output: `无法启动 PowerShell 会话：${err2.message}`, durationMs: Date.now() - started, exitCode: -1, timedOut: false });
            }
          });
          return;
        }
        s.waiter = null;
        clearTimeout(w.timer);
        w.finish({ ok: false, output: `PowerShell 会话不可用：${err.message}`, durationMs: Date.now() - started, exitCode: -1, timedOut: false });
      });
    };

    s.waiter = w;
    send();
  });
}

// 一次性进程模式（保留旧行为）：适合需按调用注入环境变量的场景
function freshExecute(command, options = {}) {
  const timeoutMs = options.timeoutMs || 60000;
  const wrapped = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;\n$ProgressPreference='SilentlyContinue';\n${command}`;

  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let killed = false;

    let child;
    try {
      child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', Buffer.from(wrapped, 'utf16le').toString('base64'),
      ], { windowsHide: true, env: Object.assign({}, process.env, options.env || {}) });
    } catch (err) {
      return resolve({ ok: false, output: `无法启动 PowerShell：${err.message}`, durationMs: 0, exitCode: -1, timedOut: false });
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { if (stdout.length < MAX_OUTPUT * 2) stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_OUTPUT * 2) stderr += d.toString('utf8'); });

    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      killed = true;
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } catch { /* 进程可能已退出 */ }
      setTimeout(() => done({
        ok: false,
        output: `命令执行超时（${timeoutMs}ms），已强制终止`,
        durationMs: Date.now() - started,
        exitCode: -1,
        timedOut: true,
      }), 1500);
    }, timeoutMs);

    child.on('error', (err) => done({
      ok: false,
      output: String(err.message),
      durationMs: Date.now() - started,
      exitCode: -1,
      timedOut: false,
    }));

    child.on('close', (code) => {
      if (killed) return;
      let output = stdout || '';
      const stderrClean = cleanClixml(stderr);
      if (stderrClean) output += (output ? '\n' : '') + stderrClean;
      if (stdout.length > MAX_OUTPUT) {
        output = output.slice(0, MAX_OUTPUT) + '\n[输出已截断：超过 2MB 上限]';
      }
      done({
        ok: code === 0,
        output: output.trim(),
        durationMs: Date.now() - started,
        exitCode: code === null ? -1 : code,
        timedOut: false,
      });
    });
  });
}

// 执行 PowerShell 命令，返回 { ok, output, durationMs, exitCode, timedOut }
// options:
//   - timeoutMs   超时毫秒数（默认 60000）
//   - sessionKey  会话标识（默认 'default'；建议按用户名隔离）
//   - fresh       true 时退回一次性进程模式（配合 env 注入临时变量）
//   - env         fresh 模式下注入的环境变量；会话模式下仅首次创建生效
function execute(command, options = {}) {
  const timeoutMs = options.timeoutMs || 60000;
  if (options.fresh) return freshExecute(command, options);

  const key = String(options.sessionKey || 'default');
  let s = sessions.get(key);
  if (!s) {
    s = { key, child: null, buf: '', errbuf: '', waiter: null, queue: Promise.resolve(), idleTimer: null, env: options.env || {} };
    sessions.set(key, s);
  }
  startSessionIfDead(s);

  // 空闲自动回收
  clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => destroySession(key), IDLE_TTL_MS);
  if (s.idleTimer.unref) s.idleTimer.unref();

  // 串行队列：同一会话的命令依次执行，避免输出串流
  const run = s.queue.then(() => writeAndWait(s, command, timeoutMs, Date.now()));
  s.queue = run.then(() => undefined, () => undefined);
  return run;
}

function startSessionIfDead(s) {
  if (!s.child || s.child.exitCode !== null) startSession(s);
}

module.exports = { execute };
