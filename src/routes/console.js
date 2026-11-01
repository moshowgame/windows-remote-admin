'use strict';

// PowerShell 控制台路由（只读查询为主，运维常用场景）
// 后台长任务：提交/终止走 assertWritable + 审计；查看类（列表/流/输出）不设限不审计
const ps = require('../services/powershell');
const jobs = require('../services/jobs');
const audit = require('../hooks/audit');

module.exports = async function consoleRoutes(app) {
  // ---- 自动补全命令表：真实 Get-Command 全集（进程级缓存）+ 静态种子兜底 ----
  const COMPLETION_SEED = [
    'Get-ChildItem', 'Get-Content', 'Get-Command', 'Get-Date', 'Get-Process', 'Get-Service',
    'Get-Location', 'Get-Item', 'Get-Volume', 'Get-PSDrive', 'Get-NetTCPConnection', 'Get-ComputerInfo',
    'Set-Location', 'Set-Content', 'Set-Item', 'Copy-Item', 'Move-Item', 'Remove-Item', 'New-Item',
    'Select-Object', 'Where-Object', 'ForEach-Object', 'Sort-Object', 'Measure-Object', 'Out-String',
    'Write-Output', 'Write-Host', 'Start-Process', 'Stop-Process', 'Start-Service', 'Stop-Service',
    'Restart-Service', 'Restart-Computer', 'Test-Connection', 'Test-Path', 'Invoke-Command',
    'ipconfig', 'ping', 'netstat', 'tasklist', 'taskkill', 'systeminfo', 'whoami', 'hostname',
    'foreach', 'if', 'else', 'switch', 'try', 'catch', 'finally', 'function', 'param', 'return',
    'gci', 'ls', 'dir', 'cat', 'cd', 'pwd', 'sls', 'echo', 'gc', 'sc', 'ni', 'ri', 'cp', 'mv', 'cls', 'ft', 'fl',
  ];
  let completionNames = null;
  let completionPromise = null;
  const getCompletionNames = () => {
    if (completionNames) return Promise.resolve(completionNames);
    if (!completionPromise) {
      completionPromise = ps
        .freshExecute(
          '(Get-Command -CommandType Cmdlet,Alias,Function -ErrorAction SilentlyContinue | ForEach-Object Name | Sort-Object -Unique) -join [Environment]::NewLine',
          { timeoutMs: 20000 }
        )
        .then((r) => {
          const names = String(r.output || '')
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter((s) => /^[A-Za-z][A-Za-z0-9-]*$/.test(s));
          completionNames = names.length > 100 ? names.concat(COMPLETION_SEED) : COMPLETION_SEED;
          // 去重（真实命令在前）
          const seen = new Set();
          completionNames = completionNames.filter((n) => (seen.has(n) ? false : (seen.add(n), true)));
          return completionNames;
        })
        .catch(() => {
          completionNames = COMPLETION_SEED;
          return completionNames;
        });
    }
    return completionPromise;
  };

  // 补全命令表（只读，无审计；认证钩子已覆盖）
  app.get('/console/completions', async () => ({ names: await getCompletionNames() }));

  // 执行命令：返回终端输出片段（beforeend 追加）
  app.post('/console/execute', async (request, reply) => {
    app.assertWritable(request);
    const command = String((request.body && request.body.command) || '').trim();
    if (!command) {
      return reply.view('partials/console-output', {
        command: '',
        result: { ok: false, output: request.t('console.emptyCommand'), durationMs: 0, exitCode: -1, timedOut: false },
      });
    }

    // 连续会话：按用户名隔离，cd / 变量等状态跨命令保留
    const username = (request.session && request.session.get('username')) || 'anonymous';
    const result = await ps.execute(command, { timeoutMs: app.config.psTimeoutMs, sessionKey: `user:${username}` });
    audit(request, 'PowerShell 命令执行', { command, durationMs: result.durationMs, ok: result.ok });

    return reply.view('partials/console-output', { command, result });
  });

  // ---- 后台长任务（Job 模型）----

  // 提交长任务：立即 202 返回 jobId，执行与请求解耦
  app.post('/console/jobs', async (request, reply) => {
    app.assertWritable(request);
    const body = request.body || {};
    const username = (request.session && request.session.get('username')) || 'anonymous';
    const isScript = String(body.kind || '') === 'script';
    const job = jobs.submit({
      username,
      command: isScript ? null : String(body.command || ''),
      script: isScript ? String(body.script || '') : null,
      timeoutMs: Number(body.timeoutMs),
    });
    audit(request, 'PowerShell 长任务提交', {
      jobId: job.id, kind: job.kind, timeoutMs: job.timeoutMs,
      command: job.commandPreview.slice(0, 200),
    });
    return reply.code(202).send({ id: job.id, state: job.state, timeoutMs: job.timeoutMs });
  });

  // 任务面板 partial（列表 + 历史）
  app.get('/console/jobs', async (request, reply) => {
    const username = (request.session && request.session.get('username')) || 'anonymous';
    return reply.view('partials/console-jobs', {
      jobs: jobs.list(username),
      t: request.t,
      role: request.session.get('role') || 'admin',
    });
  });

  // 按用户事件流：job-created / job-updated（驱动面板刷新）
  app.get('/console/stream', async (request, reply) => {
    const username = (request.session && request.session.get('username')) || 'anonymous';
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    jobs.subscribeEvents(username, reply.raw);
    reply.raw.write(': connected\n\n');
  });

  // 单任务输出 SSE：先回放环形缓冲，后实时追加；结束发 eof 终帧
  app.get('/console/jobs/:id/output', async (request, reply) => {
    const username = (request.session && request.session.get('username')) || 'anonymous';
    const job = jobs.get(request.params.id);
    if (!job || job.user !== username) {
      reply.code(404);
      return reply.send('');
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    jobs.subscribeOutput(job, reply.raw);
  });

  // 终止长任务：taskkill /T /F 语义，返回刷新后的面板 partial
  app.post('/console/jobs/:id/cancel', async (request, reply) => {
    app.assertWritable(request);
    const username = (request.session && request.session.get('username')) || 'anonymous';
    const job = jobs.cancel(request.params.id, username);
    if (!job) {
      const err = new Error(request.t('console.jobNotFound'));
      err.statusCode = 404;
      throw err;
    }
    audit(request, 'PowerShell 长任务终止', { jobId: job.id, command: job.commandPreview, state: job.state });
    return reply.view('partials/console-jobs', {
      jobs: jobs.list(username),
      t: request.t,
      role: request.session.get('role') || 'admin',
    });
  });
};
