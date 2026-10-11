'use strict';

// 日志监控路由：文件扫描（通配/天数过滤）+ 尾部内容（关键词高亮）+ SSE 实时跟踪
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { ROOT } = require('../config');
const filesystem = require('../services/filesystem');
const { PathError, resolveUserPath, sizeText, timeText } = filesystem;

// HTML 转义（先转义再做关键词高亮，避免注入）
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function lineHtml(raw, keyword) {
  let out = esc(raw);
  const k = keyword ? esc(keyword) : '';
  if (k) out = out.split(k).join(`<mark>${k}</mark>`);
  return `<div class="log-line">${out}</div>`;
}

// 读取文件尾部（最多 512KB / 500 行）并返回高亮 HTML
async function tailHtml(file, keyword, maxLines = 500) {
  const st = await fsp.stat(file);
  const len = Math.min(st.size, 512 * 1024);
  const fh = await fsp.open(file, 'r');
  let text;
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, st.size - len);
    text = buf.toString('utf8');
  } finally {
    await fh.close().catch(() => {});
  }
  if (len < st.size) {
    const nl = text.indexOf('\n');
    if (nl >= 0) text = text.slice(nl + 1); // 去掉截断的半行
  }
  let lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  lines = lines.slice(-maxLines);
  return lines.map((l) => lineHtml(l, keyword)).join('');
}

// 通配符 → 正则（* / ? ）
function globToRegex(pattern) {
  const s = String(pattern || '*').replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${s.replace(/\*/g, '[^\\\\/]*').replace(/\?/g, '.')}$`, 'i');
}

function normalizeDays(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1) return 7;
  return Math.min(n, 365);
}

// 递归扫描日志文件：深度 5 / 总数 200 / mtime 过滤，按修改时间倒序
async function scanLogFiles({ dir, pattern, days, limit = 200 }) {
  const re = globToRegex(pattern);
  const since = Date.now() - days * 86400000;
  const out = [];

  async function walk(d, depth) {
    if (depth > 5 || out.length >= limit) return;
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return; // 目录不可读直接跳过
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!e.isFile() || !re.test(e.name)) continue;
      try {
        const st = await fsp.stat(full);
        if (st.mtimeMs < since) continue;
        out.push({
          path: full,
          name: e.name,
          dir: d,
          sizeText: sizeText(st.size),
          mtimeMs: st.mtimeMs,
          mtimeText: timeText(st.mtime),
        });
      } catch {
        // 忽略无法 stat 的文件
      }
    }
  }

  await walk(dir, 0);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, limit);
}

module.exports = async function logsRoutes(app) {
  // 监控页
  app.get('/logs', async (request, reply) => {
    const q = request.query;
    const dir = q.dir ? resolveUserPath(q.dir, path.join(ROOT, 'logs')) : path.join(ROOT, 'logs');
    // pino-roll 按天轮转后活动文件带 .N 后缀（如 app.log.2），默认需覆盖
    const pattern = String(q.pattern || '*.log*');
    const days = normalizeDays(q.days);
    const keyword = String(q.keyword || '');
    const files = await scanLogFiles({ dir, pattern, days });

    let file = null;
    if (q.file) {
      const full = resolveUserPath(q.file);
      const st = await fsp.stat(full).catch(() => null);
      file = st && !st.isDirectory() ? full : null;
    }
    if (!file && files.length > 0) file = files[0].path;
    const linesHtml = file ? await tailHtml(file, keyword) : '';

    return reply.renderPage('pages/logs', {
      title: '日志监控',
      active: 'logs',
      dir,
      pattern,
      days,
      keyword,
      files,
      file,
      linesHtml,
      autoPick: false,
    });
  });

  // 文件列表片段（扫描按钮触发；autoPick 自动加载首个文件内容）
  app.get('/logs/files', async (request, reply) => {
    const q = request.query;
    const dir = resolveUserPath(q.dir, path.join(ROOT, 'logs'));
    const pattern = String(q.pattern || '*.log*');
    const days = normalizeDays(q.days);
    const keyword = String(q.keyword || '');
    const files = await scanLogFiles({ dir, pattern, days });
    const file = files.length > 0 ? files[0].path : null;
    return reply.view('partials/log-file-list', { files, file, keyword, autoPick: true });
  });

  // 内容片段（尾部 + 高亮 + SSE 挂载点）
  app.get('/logs/content', async (request, reply) => {
    const full = resolveUserPath(request.query.file);
    const st = await fsp.stat(full).catch(() => null);
    if (!st || st.isDirectory()) throw new PathError('日志文件不存在');
    const keyword = String(request.query.keyword || '');
    const linesHtml = await tailHtml(full, keyword);
    return reply.view('partials/log-content', { file: full, keyword, linesHtml });
  });

  // SSE 实时跟踪：fs.watch 父目录 + offset 追加读，500ms 节流
  app.get('/logs/stream', async (request, reply) => {
    const full = resolveUserPath(request.query.file);
    const st = await fsp.stat(full).catch(() => null);
    if (!st || st.isDirectory()) throw new PathError('日志文件不存在');
    const keyword = String(request.query.keyword || '');
    const watchDir = path.dirname(full);
    const base = path.basename(full);
    let offset = st.size;

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (html) => {
      try {
        reply.raw.write(`event: log-tail\ndata: ${html}\n\n`);
      } catch {
        // 连接已断开
      }
    };

    let buf = ''; // 半行缓冲
    let timer = null;
    let closed = false;

    const pump = async () => {
      timer = null;
      if (closed) return;
      try {
        const s = await fsp.stat(full);
        if (s.size < offset) {
          offset = 0;
          buf = '';
          send(lineHtml('--- 检测到文件被截断，已从头开始读取 ---', ''));
        }
        if (s.size > offset) {
          const len = Math.min(s.size - offset, 512 * 1024);
          const chunk = Buffer.alloc(len);
          const fh = await fsp.open(full, 'r');
          try {
            await fh.read(chunk, 0, len, offset);
          } finally {
            await fh.close().catch(() => {});
          }
          offset += len;
          const parts = (buf + chunk.toString('utf8')).split(/\r\n|\r|\n/);
          buf = parts.pop() || '';
          if (buf.length > 256 * 1024) {
            send(lineHtml(buf, keyword)); // 超长半行强制输出
            buf = '';
          }
          if (parts.length > 0) send(parts.map((l) => lineHtml(l, keyword)).join(''));
        }
      } catch {
        // 文件被删除等：保持连接等待恢复
      }
    };

    const watcher = fs.watch(watchDir, (event, name) => {
      if (closed) return;
      if (name && name !== base) return;
      if (!timer) timer = setTimeout(pump, 500);
    });

    const hb = setInterval(() => {
      if (closed) return;
      try {
        reply.raw.write(':hb\n\n');
      } catch {
        // 忽略
      }
    }, 25000);

    request.raw.on('close', () => {
      closed = true;
      clearInterval(hb);
      if (timer) clearTimeout(timer);
      watcher.close();
    });
  });
};
