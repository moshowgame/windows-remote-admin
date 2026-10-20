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

// 读取 [end - 512KB, end) 窗口并返回最后 maxLines 行的高亮 HTML。
// 返回 before = 窗口内第一个完整行的起始字节偏移（0 表示已到文件头），
// 作为 /logs/history 向上翻页的游标 —— 大日志（百 MB/GB 级）按需回溯，绝不整读文件。
async function readWindow(file, end, keyword, maxLines = 500) {
  const st = await fsp.stat(file);
  if (!Number.isFinite(end) || end <= 0) return { html: '', before: 0, hasMore: false };
  end = Math.min(end, st.size);
  const start = Math.max(0, end - 512 * 1024);
  const readStart = start > 0 ? start - 1 : 0; // 多读 1 字节判断窗口起点是否在行边界
  const fh = await fsp.open(file, 'r');
  let text;
  try {
    const buf = Buffer.alloc(end - readStart);
    await fh.read(buf, 0, buf.length, readStart);
    text = buf.toString('utf8');
  } finally {
    await fh.close().catch(() => {});
  }

  // 对齐到第一个完整行：窗口起点前一字节不是换行 → 起点在半行中间，跳过该半行
  let aligned = readStart;
  if (readStart > 0) {
    if (text[0] === '\n' || text[0] === '\r') {
      aligned = start;
    } else {
      const m = /(\r\n|\r|\n)/.exec(text);
      if (!m) return { html: '', before: readStart, hasMore: true }; // 整窗一条巨行：跳过本轮继续向前
      aligned = readStart + m.index + m[1].length;
    }
  }
  if (aligned > readStart) text = text.slice(aligned - readStart);

  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const page = lines.slice(-maxLines);
  return {
    html: page.map((l) => lineHtml(l, keyword)).join(''),
    before: aligned,
    hasMore: aligned > 0,
  };
}

// 兼容旧名：读取文件尾部窗口
async function tailHtml(file, keyword, maxLines = 500) {
  const st = await fsp.stat(file);
  return readWindow(file, st.size, keyword, maxLines);
}

// grep 模式：从字节游标 start 向后流式扫描，返回匹配行 + 前/后各 context 行上下文。
// 关键字不区分大小写（includes 匹配）；上下文组重叠自动合并（组间插入 {skip:N} 省略提示）。
// 游标精确到字节（逐行累计含换行的字节数），翻页无重复无遗漏；大文件单批最多扫 32MB。
// 返回 { segments: [{t, m} | {skip}], next, hasMore, matches, scanned, endReached }
async function scanGrep(file, { keyword, context = 5, limit = 50, start = 0 }) {
  const CHUNK = 4 * 1024 * 1024;     // 单块读取 4MB
  const MAX_SCAN = 32 * 1024 * 1024; // 单次请求最多扫描 32MB
  const MAX_OUT = 512 * 1024;        // 输出预算：超出后本块内静默（游标仍精确推进）

  const st = await fsp.stat(file);
  const lower = keyword.toLowerCase();
  const segments = [];
  const beforeBuf = [];              // 前 context 行缓冲 [{ no, t }]
  let offset = start;
  let lineNo = 0;
  let groupEnd = 0;                  // 活动上下文组的结束行号（绝对行号）
  let lastEnd = 0;                   // 最后输出的绝对行号
  let matches = 0;
  let scanned = 0;
  let outBytes = 0;
  let muted = false;
  let next = start;
  let hitLimit = false;

  // 统一输出：自动补组间省略提示；返回是否需要中断（limit/输出预算）
  const emit = (no, t, m) => {
    if (muted) return;
    if (lastEnd > 0 && no > lastEnd + 1) {
      segments.push({ skip: no - lastEnd - 1 });
      outBytes += 32;
    }
    segments.push({ t, m });
    outBytes += Buffer.byteLength(t) + 8;
    lastEnd = no;
    if (outBytes > MAX_OUT) muted = true;
  };

  const fh = await fsp.open(file, 'r');
  try {
    let carry = '';
    const lineRe = /.*(?:\r\n|\r|\n)|.+$/g;
    scan:
    while (offset < st.size && scanned < MAX_SCAN) {
      const len = Math.min(CHUNK, st.size - offset);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, offset);
      scanned += len;
      const chunkStart = offset;
      offset += len;
      const chunkStr = buf.toString('utf8');
      const carryChars = carry.length;
      const carryBytes = Buffer.byteLength(carry, 'utf8');
      const text = carry + chunkStr;
      carry = '';
      let consumed = 0; // 本块内已处理完整行的字节数（含 carry，按 UTF-8 字节计）

      lineRe.lastIndex = 0;
      let m;
      while ((m = lineRe.exec(text)) !== null) {
        const raw = m[0];
        if (!/\r\n|\r|\n$/.test(raw)) { carry = raw; break; } // 半行留给下一块
        consumed = carryBytes + Buffer.byteLength(chunkStr.slice(0, lineRe.lastIndex - carryChars), 'utf8');
        lineNo++;
        const t = raw.replace(/\r\n|\r|\n$/, '');
        const hit = lower ? t.toLowerCase().includes(lower) : false;

        if (hit) {
          matches++;
          groupEnd = lineNo + context;
          // 先补输出缓冲里的前置上下文（行号 > lastEnd 且 >= 匹配行 - context）
          const needFrom = lineNo - context;
          for (const b of beforeBuf) {
            if (b.no > lastEnd && b.no >= needFrom) emit(b.no, b.t, false);
          }
          emit(lineNo, t, true);
        } else if (lineNo <= groupEnd && lineNo > lastEnd) {
          emit(lineNo, t, false);
        }

        beforeBuf.push({ no: lineNo, t });
        if (beforeBuf.length > context) beforeBuf.shift();

        if (matches >= limit) { next = chunkStart + consumed; hitLimit = true; break scan; }
      }

      next = chunkStart + consumed; // 半行未被消费，下次从其行首继续
      if (carry && offset >= st.size) {
        // 文件末尾的最后一行（无换行符）：按完整行处理
        lineNo++;
        const t = carry;
        const hit = lower ? t.toLowerCase().includes(lower) : false;
        if (hit) {
          matches++;
          groupEnd = lineNo + context;
          const needFrom = lineNo - context;
          for (const b of beforeBuf) {
            if (b.no > lastEnd && b.no >= needFrom) emit(b.no, b.t, false);
          }
          emit(lineNo, t, true);
        } else if (lineNo <= groupEnd && lineNo > lastEnd) {
          emit(lineNo, t, false);
        }
        beforeBuf.push({ no: lineNo, t });
        if (beforeBuf.length > context) beforeBuf.shift();
        carry = '';
        next = offset; // 已扫到文件尾
      }
    }
  } finally {
    await fh.close().catch(() => {});
  }

  if (matches >= limit && !hitLimit) hitLimit = true;
  return {
    segments,
    next,
    hasMore: next < st.size,
    matches,
    scanned,
    endReached: next >= st.size,
  };
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
    const tail = file ? await tailHtml(file, keyword) : { html: '', before: 0, hasMore: false };

    return reply.renderPage('pages/logs', {
      title: request.t('logs.title'),
      active: 'logs',
      dir,
      pattern,
      days,
      keyword,
      files,
      file,
      linesHtml: tail.html,
      before: tail.before,
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
    if (!st || st.isDirectory()) throw new PathError(request.t('logs.fileNotFound'));
    const keyword = String(request.query.keyword || '');
    const tail = await tailHtml(full, keyword);
    return reply.view('partials/log-content', { file: full, keyword, linesHtml: tail.html, before: tail.before, hasMore: tail.hasMore });
  });

  // 向上翻页：按字节游标 before 读取更早的 500 行（大日志按需回溯，O(1) 内存）
  app.get('/logs/history', async (request, reply) => {
    const full = resolveUserPath(request.query.file);
    const st = await fsp.stat(full).catch(() => null);
    if (!st || st.isDirectory()) throw new PathError(request.t('logs.fileNotFound'));
    const keyword = String(request.query.keyword || '');
    const before = parseInt(request.query.before, 10) || 0;
    const r = await readWindow(full, before, keyword);
    return reply.view('partials/log-history', {
      file: full,
      keyword,
      linesHtml: r.html,
      before: r.before,
      hasMore: r.hasMore,
    });
  });

  // grep 模式：全文件流式扫描，返回匹配行 + 前/后各 context 行（JSON，前端渲染）
  // start 为字节游标：结果超过 limit 时精确停在匹配行末，继续扫描无重复无遗漏
  app.get('/logs/grep', async (request, reply) => {
    const full = resolveUserPath(request.query.file);
    const st = await fsp.stat(full).catch(() => null);
    if (!st || st.isDirectory()) throw new PathError(request.t('logs.fileNotFound'));
    const keyword = String(request.query.keyword || '').trim();
    if (!keyword) throw new PathError(request.t('logs.keywordRequired'));
    let context = parseInt(request.query.context, 10);
    if (!Number.isFinite(context) || context < 0) context = 5;
    if (context > 20) context = 20;
    const limit = Math.min(Math.max(parseInt(request.query.limit, 10) || 50, 1), 200);
    const start = Math.max(parseInt(request.query.start, 10) || 0, 0);
    const r = await scanGrep(full, { keyword, context, limit, start });
    return reply.send(r);
  });

  // SSE 实时跟踪：fs.watch 父目录 + offset 追加读，500ms 节流
  app.get('/logs/stream', async (request, reply) => {
    const full = resolveUserPath(request.query.file);
    const st = await fsp.stat(full).catch(() => null);
    if (!st || st.isDirectory()) throw new PathError(request.t('logs.fileNotFound'));
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
        let s = await fsp.stat(full);
        if (s.size < offset) {
          offset = 0;
          buf = '';
          send(lineHtml(request.t('logs.truncated'), ''));
        }
        // 自适应追赶：单次最多 4 轮 × 2MB，高频写入（百 MB 级日志）也不会持续滞后
        let loops = 0;
        while (!closed && s.size > offset && loops < 4) {
          const len = Math.min(s.size - offset, 2 * 1024 * 1024);
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
          loops++;
          if (s.size > offset) s = await fsp.stat(full); // 追赶期间刷新最新大小
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
