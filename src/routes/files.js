'use strict';

// 文件资源管理器路由：浏览/预览/上传/下载/解压/压缩/目录操作/SSE 任务进度
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const archiver = require('archiver');

const filesystem = require('../services/filesystem');
const { PathError, resolveUserPath, sizeText } = filesystem;
const archive = require('../services/archive');
const ps = require('../services/powershell');
const audit = require('../hooks/audit');

// HX-Trigger 头不允许非 ASCII，中文消息打 enc: 前缀由前端解码
const encMsg = (m) => /^[\x20-\x7E]*$/.test(m) ? m : 'enc:' + encodeURIComponent(m);
const toastHeader = (message, type) => ({
  'HX-Trigger': JSON.stringify({ toast: { message: encMsg(message), type: type || 'success' } }),
});

const DEFAULT_ROOT = () => (filesystem.resolveUserPath('C:\\'));

function defaultRoot(app) {
  const list = app.config.pathWhitelist || [];
  return list.length > 0 ? path.resolve(list[0]) : DEFAULT_ROOT();
}

function sanitizeName(name) {
  const n = String(name || '').trim();
  if (!n) throw new PathError('名称不能为空');
  if (n === '.' || n === '..') throw new PathError('名称不合法');
  if (/[\\/:*?"<>|]/.test(n)) throw new PathError('名称不能包含 \\ / : * ? " < > | 字符');
  if (n.length > 200) throw new PathError('名称过长（最多 200 字符）');
  return n;
}

// 浏览上下文：列目录 + 面包屑 + 会话最近访问（供页面直出与片段刷新共用）
async function browseCtx(app, request, q = {}) {
  const sort = ['name', 'size', 'mtime'].includes(q.sort) ? q.sort : 'name';
  const order = q.order === 'desc' ? 'desc' : 'asc';
  const dir = resolveUserPath(q.path, defaultRoot(app));
  const st = await fsp.stat(dir).catch(() => null);
  if (!st || !st.isDirectory()) throw new PathError(`目录不存在：${dir}`);
  const items = await filesystem.listDir(dir, sort, order);

  // 会话最近访问（去重截 20 条）
  let recent = (request.session.get('recentPaths') || []).filter((p) => p !== dir);
  recent.unshift(dir);
  if (recent.length > 20) recent.length = 20;
  request.session.set('recentPaths', recent);

  return {
    dir,
    items,
    sort,
    order,
    parent: filesystem.parentOf(dir),
    crumbs: filesystem.crumbsOf(dir),
    recent,
  };
}

module.exports = async function filesRoutes(app) {
  // ---- 页面直出 ----
  app.get('/files', async (request, reply) => {
    const b = await browseCtx(app, request, request.query);
    return reply.renderPage('pages/files', {
      title: '文件资源管理器',
      active: 'files',
      ...b,
      quickAccess: app.config.quickAccess || [],
      uploadMaxMb: app.config.uploadMaxMb || 100,
      extractMaxMb: app.config.extractMaxMb || 2048,
      extractMaxFiles: app.config.extractMaxFiles || 20000,
      whitelistOn: (app.config.pathWhitelist || []).length > 0,
    });
  });

  // ---- 浏览（返回 OOB 复合片段：主区 + 最近访问）----
  app.post('/files/browse', async (request, reply) => {
    const b = await browseCtx(app, request, request.body || {});
    return reply.view('partials/file-browse', b);
  });

  // ---- 预览（模态内容）----
  app.get('/files/preview', async (request, reply) => {
    const full = resolveUserPath(request.query.path);
    const st = await fsp.stat(full).catch(() => null);
    if (!st) throw new PathError('文件不存在或已被移动');
    if (st.isDirectory()) throw new PathError('目录不支持预览');
    // 预览大小前置校验：文本 readMaxMb，其他类型 50MB 上限
    const readMax = (app.config.readMaxMb || 10) * 1024 * 1024;
    const otherMax = 50 * 1024 * 1024;
    if (st.size > readMax) throw new PathError(`文件超过 ${app.config.readMaxMb || 10} MB，不支持在线预览`);
    if (st.size > otherMax) throw new PathError(`文件过大（${sizeText(st.size)}），不支持在线预览`);
    const kind = await filesystem.kindOf(full, st);
    const data = { name: path.basename(full), path: full, kind };
    if (kind === 'text') {
      data.text = await filesystem.readTextPage(full, parseInt(request.query.page, 10) || 1);
    } else if (kind === 'image') {
      data.url = `/files/raw?path=${encodeURIComponent(full)}`;
    } else if (kind === 'zip') {
      data.zip = await archive.listZipEntries(full, 200);
    } else {
      data.info = { sizeText: sizeText(st.size), mtimeText: filesystem.timeText(st.mtime) };
    }
    return reply.view('partials/file-preview', data);
  });

  // ---- 图片直接输出（inline / 下载）----
  app.get('/files/raw', async (request, reply) => {
    const full = resolveUserPath(request.query.path);
    const st = await fsp.stat(full).catch(() => null);
    if (!st || st.isDirectory()) throw new PathError('文件不存在');
    const mime = filesystem.IMAGE_MIME[path.extname(full).toLowerCase()];
    if (!mime) throw new PathError('仅支持图片直接输出');
    if (st.size > 20 * 1024 * 1024) throw new PathError('图片过大，不支持在线预览');
    const name = encodeURIComponent(path.basename(full));
    reply.type(mime);
    reply.header('Content-Security-Policy', 'sandbox'); // 防 SVG 内嵌脚本
    reply.header(
      'Content-Disposition',
      `${request.query.dl === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${name}`
    );
    return reply.send(fs.createReadStream(full));
  });

  // ---- 下载 ----
  app.get('/files/download', async (request, reply) => {
    const full = resolveUserPath(request.query.path);
    const st = await fsp.stat(full).catch(() => null);
    if (!st) throw new PathError('文件不存在');
    if (st.isDirectory()) throw new PathError('目录请使用「打包下载」');
    reply.type('application/octet-stream');
    reply.header(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(full))}`
    );
    audit(request, '下载文件', { path: full });
    return reply.send(fs.createReadStream(full));
  });

  // ---- 多选打包下载（同步流式 zip，GET 免 CSRF）----
  app.get('/files/download-zip', async (request, reply) => {
    const raw = String(request.query.paths || '');
    const paths = raw.split('|').filter(Boolean).map((p) => resolveUserPath(p));
    if (paths.length === 0) throw new PathError('请先勾选要打包的条目');
    const stats = [];
    for (const p of paths) {
      const st = await fsp.stat(p).catch(() => null);
      if (!st) throw new PathError(`条目不存在或已变更：${path.basename(p)}`);
      stats.push({ p, st });
    }
    const zipName = `download_${filesystem.stampNow()}.zip`;
    reply.type('application/zip');
    reply.header(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`
    );
    audit(request, '打包下载', { count: paths.length });
    const ar = archiver('zip', { zlib: { level: 5 } });
    for (const { p, st } of stats) {
      if (st.isDirectory()) ar.directory(p, path.basename(p));
      else ar.file(p, { name: path.basename(p) });
    }
    ar.finalize();
    return reply.send(ar);
  });

  // ---- 上传（multipart 流式落盘）----
  app.post('/files/upload', async (request, reply) => {
    if (!request.isMultipart()) throw new PathError('请使用文件上传表单');
    let dir = null;
    const results = [];
    const stamp = filesystem.stampNow();
    const maxBytes = (app.config.uploadMaxMb || 100) * 1024 * 1024;

    for await (const part of request.parts()) {
      if (part.type === 'field') {
        if (part.fieldname === 'path' && !dir) {
          dir = resolveUserPath(part.value);
          const st = await fsp.stat(dir).catch(() => null);
          if (!st || !st.isDirectory()) throw new PathError('上传目标不是有效目录');
        }
        continue;
      }
      if (!dir) throw new PathError('缺少上传目标目录');
      const safeName = path.basename(String(part.filename || '')).replace(/[\\/:*?"<>|]/g, '_');
      if (!safeName) {
        part.file.resume();
        continue;
      }
      let dest = path.join(dir, safeName);
      if (fs.existsSync(dest)) {
        const ext = path.extname(safeName);
        dest = path.join(dir, `${safeName.slice(0, safeName.length - ext.length)}_${stamp}${ext}`);
      }
      try {
        await pipeline(part.file, fs.createWriteStream(dest));
        if (part.file.truncated) {
          await fsp.rm(dest, { force: true }).catch(() => {});
          results.push({ name: safeName, ok: false, note: `超过单文件上限 ${app.config.uploadMaxMb} MB` });
        } else {
          const st = await fsp.stat(dest);
          results.push({ name: safeName, ok: true, sizeText: sizeText(st.size) });
        }
      } catch (e) {
        await fsp.rm(dest, { force: true }).catch(() => {});
        results.push({ name: safeName, ok: false, note: `写入失败（${e.code || e.message}）` });
      }
    }

    if (!dir) throw new PathError('缺少上传目标目录');
    if (results.length === 0) throw new PathError('未收到文件');
    const okCount = results.filter((r) => r.ok).length;
    audit(request, '上传文件', { dir, count: results.length, ok: okCount });

    const b = await browseCtx(app, request, { path: dir });
    return reply.view('partials/upload-result', {
      ...b,
      uploaded: results,
      okCount,
      failCount: results.length - okCount,
    });
  });

  // ---- 服务器直接打开（默认关闭，需 enableServerOpen）----
  app.post('/files/open', async (request, reply) => {
    if (!app.config.enableServerOpen) throw new PathError('管理员未启用「服务器直接打开」功能');
    const full = resolveUserPath(request.body && request.body.path);
    const st = await fsp.stat(full).catch(() => null);
    if (!st) throw new PathError('文件不存在');
    if (st.isDirectory()) throw new PathError('仅支持打开文件');
    // 路径经环境变量传入，脚本内用 $env: 引用：值不会被 PowerShell 解析器求值，杜绝命令注入
    await ps.execute('Start-Process -LiteralPath $env:WRA_OPEN_TARGET', { timeoutMs: 15000, env: { WRA_OPEN_TARGET: full } });
    audit(request, '服务器打开文件', { path: full });
    return reply.headers(toastHeader('已发送打开指令', 'info')).send('');
  });

  // ---- 解压（异步任务）----
  app.post('/files/extract', async (request, reply) => {
    const full = resolveUserPath(request.body && request.body.path);
    const st = await fsp.stat(full).catch(() => null);
    if (!st || st.isDirectory() || path.extname(full).toLowerCase() !== '.zip') {
      throw new PathError('请选择 .zip 压缩包进行解压');
    }
    const t = archive.enqueue(
      request.session.get('username'),
      'extract',
      `解压 ${path.basename(full)}`,
      (task) => archive.extractZip(full, task.id)
    );
    audit(request, '解压压缩包', { path: full });
    return reply.view('partials/task-list', { tasks: [t], oob: true });
  });

  // ---- 压缩（异步任务，支持多选）----
  app.post('/files/compress', async (request, reply) => {
    let paths = (request.body && request.body.paths) || [];
    if (!Array.isArray(paths)) paths = paths ? [paths] : [];
    if (paths.length === 0) throw new PathError('请先勾选要压缩的条目');
    if (paths.length > 100) throw new PathError('一次最多压缩 100 个条目');

    const resolved = [];
    for (const p of paths) {
      const full = resolveUserPath(p);
      const st = await fsp.stat(full).catch(() => null);
      if (!st) throw new PathError(`条目不存在：${path.basename(String(p))}`);
      resolved.push({ full, st });
    }
    const first = resolved[0].full;
    const destZip = path.join(
      path.dirname(first),
      `${path.basename(first)}_${filesystem.stampNow()}.zip`
    );
    // 目标不能位于任何待压缩目录内部（边读边写会出错）
    for (const { full, st } of resolved) {
      if (st.isDirectory() && destZip.toLowerCase().startsWith(full.toLowerCase() + path.sep)) {
        throw new PathError('压缩目标不能位于待压缩目录内部');
      }
    }
    const t = archive.enqueue(
      request.session.get('username'),
      'compress',
      `压缩 ${resolved.length} 项 → ${path.basename(destZip)}`,
      (task) => archive.compressZip(resolved.map((r) => r.full), destZip, task.id)
    );
    audit(request, '压缩文件', { count: resolved.length, dest: destZip });
    return reply.view('partials/task-list', { tasks: [t], oob: true });
  });

  // ---- 新建文件夹 ----
  app.post('/files/mkdir', async (request, reply) => {
    const b = request.body || {};
    const dir = resolveUserPath(b.path);
    const full = path.join(dir, sanitizeName(b.name));
    if (fs.existsSync(full)) throw new PathError('同名文件或目录已存在');
    await fsp.mkdir(full);
    audit(request, '创建目录', { path: full });
    const ctx = await browseCtx(app, request, { path: dir, sort: b.sort, order: b.order });
    return reply.headers(toastHeader('目录已创建')).view('partials/file-browse', ctx);
  });

  // ---- 重命名 ----
  app.post('/files/rename', async (request, reply) => {
    const b = request.body || {};
    const full = resolveUserPath(b.path);
    const st = await fsp.stat(full).catch(() => null);
    if (!st) throw new PathError('原文件或目录不存在');
    const parent = path.dirname(full);
    const target = path.join(parent, sanitizeName(b.name));
    if (fs.existsSync(target)) throw new PathError('目标名称已存在');
    await fsp.rename(full, target);
    audit(request, '重命名', { from: full, to: target });
    const ctx = await browseCtx(app, request, { path: parent, sort: b.sort, order: b.order });
    return reply.headers(toastHeader('重命名成功')).view('partials/file-browse', ctx);
  });

  // ---- 删除（目录需输名确认）----
  app.post('/files/delete', async (request, reply) => {
    const b = request.body || {};
    const full = resolveUserPath(b.path);
    const st = await fsp.stat(full).catch(() => null);
    if (!st) throw new PathError('文件或目录不存在');
    if (st.isDirectory()) {
      const confirm = String(b.confirmName || '').trim();
      if (confirm !== path.basename(full)) throw new PathError('确认名称与目录名不一致');
      await fsp.rm(full, { recursive: true, force: true });
    } else {
      await fsp.rm(full, { force: true });
    }
    audit(request, '删除', { path: full, isDir: st.isDirectory() });
    const ctx = await browseCtx(app, request, { path: path.dirname(full), sort: b.sort, order: b.order });
    return reply.headers(toastHeader('已删除')).view('partials/file-browse', ctx);
  });

  // ---- 任务进度 SSE ----
  app.get('/files/tasks/stream', async (request, reply) => {
    const username = request.session.get('username');

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // SSE data 必须单行：渲染后压掉换行
    const send = async (tasks) => {
      try {
        let html = await app.view('partials/task-list', { tasks, oob: false });
        html = html.replace(/\r?\n\s*/g, '');
        reply.raw.write(`event: task-progress\ndata: ${html}\n\n`);
      } catch {
        // 渲染失败时跳过本次推送
      }
    };

    await send(archive.activeTasksFor(username));

    const onTask = async (t) => {
      // refresh 事件（任务面板清理）与普通更新都重拉全量任务列表
      if (t.username !== username) return;
      await send(archive.activeTasksFor(username));
    };
    archive.taskEvents.on('task', onTask);

    const hb = setInterval(() => {
      try {
        reply.raw.write(':hb\n\n');
      } catch {
        // 忽略心跳失败
      }
    }, 25000);

    request.raw.on('close', () => {
      clearInterval(hb);
      archive.taskEvents.off('task', onTask);
    });
  });
};

module.exports.browseCtx = browseCtx;
module.exports.defaultRoot = defaultRoot;
