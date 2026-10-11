'use strict';

// PowerShell 执行服务
// - spawn 而非拼接 shell 字符串：-NoProfile -NonInteractive -EncodedCommand（Base64 UTF-16LE），防命令注入
// - 输出：前置 [Console]::OutputEncoding=UTF8 保证中文不乱码
// - 超时：taskkill /T /F 强杀进程树
// - CLIXML 错误流清洗（对齐 Go 版逻辑）
// - 输出上限 2MB 截断
const { spawn } = require('node:child_process');

const MAX_OUTPUT = 2 * 1024 * 1024; // 2MB

// Base64(UTF-16LE) 编码
function encodeCommand(command) {
  return Buffer.from(command, 'utf16le').toString('base64');
}

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

// 执行 PowerShell 命令，返回 { ok, output, durationMs, exitCode, timedOut }
function execute(command, options = {}) {
  const timeoutMs = options.timeoutMs || 60000;
  // 前置：UTF-8 输出编码 + 关闭进度流（防"正在准备首次使用模块"等噪声污染 stderr）
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
        '-EncodedCommand', encodeCommand(wrapped),
        // 额外环境变量：供脚本以 $env:XXX 引用外部数据（值不经 PS 解析器插值，防注入）
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
      // 超时：强杀整个进程树
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
      if (killed) return; // 超时路径已处理
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

module.exports = { execute };
