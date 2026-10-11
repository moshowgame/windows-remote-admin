'use strict';

// 压缩/解压服务：任务队列（每用户并发 1）+ 进度事件 + yauzl/archiver 实现
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const yauzl = require('yauzl');
const archiver = require('archiver');
const { config } = require('../config');
const { PathError, sizeText, stampNow } = require('./filesystem');

const tasks = new Map(); // taskId → task
const taskEvents = new EventEmitter();
taskEvents.setMaxListeners(200);

const queues = new Map(); // username → { running, list: [{t, runFn}] }
let taskSeq = 0;

function newTask(username, type, title) {
  const id = `t${Date.now().toString(36)}${(++taskSeq).toString(36)}`;
  const t = {
    id,
    username,
    type,
    title,
    status: 'pending', // pending | running | done | error
    percent: 0,
    detail: '排队中…',
    startedAt: null,
    endedAt: null,
    error: null,
    resultPath: null,
  };
  tasks.set(id, t);
  return t;
}

function updateTask(id, patch) {
  const t = tasks.get(id);
  if (!t) return;
  Object.assign(t, patch);
  taskEvents.emit('task', { ...t });
}

// 完成任务 15s 后从 SSE 面板消失，5 分钟后清理
function scheduleCleanup(t) {
  setTimeout(() => taskEvents.emit('task', { username: t.username, refresh: true }), 15 * 1000).unref();
  setTimeout(() => tasks.delete(t.id), 5 * 60 * 1000).unref();
}

// 入队：同用户串行执行，不同用户互不影响
function enqueue(username, type, title, runFn) {
  const t = newTask(username, type, title);
  const q = queues.get(username) || { running: false, list: [] };
  queues.set(username, q);
  q.list.push({ t, runFn });
  if (!q.running) runQueue(username);
  return t;
}

async function runQueue(username) {
  const q = queues.get(username);
  if (!q || q.running) return;
  q.running = true;
  try {
    while (q.list.length > 0) {
      const { t, runFn } = q.list.shift();
      updateTask(t.id, { status: 'running', detail: '开始处理…', startedAt: Date.now() });
      try {
        const resultPath = await runFn(t);
        updateTask(t.id, {
          status: 'done',
          percent: 100,
          detail: '完成',
          endedAt: Date.now(),
          resultPath: resultPath || null,
        });
      } catch (err) {
        updateTask(t.id, {
          status: 'error',
          detail: '失败',
          endedAt: Date.now(),
          error: err.message || '未知错误',
        });
      }
      scheduleCleanup(t);
    }
  } finally {
    q.running = false;
    if (q.list.length === 0) queues.delete(username);
  }
}

// 用户当前活跃任务（pending/running + 15s 内结束的）
function activeTasksFor(username) {
  const now = Date.now();
  const out = [];
  for (const t of tasks.values()) {
    if (t.username !== username) continue;
    if (t.status === 'pending' || t.status === 'running') out.push(t);
    else if (t.endedAt && now - t.endedAt < 15 * 1000) out.push(t);
  }
  return out;
}

// 单条目流式落盘
function pipeEntry(zipfile, entry, target) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, rs) => {
      if (err) return reject(err);
      const ws = fs.createWriteStream(target);
      rs.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', resolve);
      rs.pipe(ws);
    });
  });
}

// 解压 zip：Zip Slip 校验 + 双限额（条目数/总字节），超限中止并清理半成品
function extractZip(zipPath, taskId) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err) return reject(new PathError(`无法读取压缩包：${err.message}`));
      const entryCount = zipfile.entryCount;
      if (entryCount > config.extractMaxFiles) {
        zipfile.close();
        return reject(new PathError(`压缩包含 ${entryCount} 个条目，超过上限 ${config.extractMaxFiles}`));
      }

      const destRoot = path.join(
        path.dirname(zipPath),
        `${path.basename(zipPath, path.extname(zipPath))}_extract_${stampNow()}`
      );
      let madeRoot = false;
      const ensureRoot = async () => {
        if (!madeRoot) {
          await fsp.mkdir(destRoot, { recursive: true });
          madeRoot = true;
        }
      };

      const maxBytes = (config.extractMaxMb || 2048) * 1024 * 1024;
      let totalBytes = 0;
      let doneCount = 0;
      let lastPct = -1;
      let settled = false;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        try {
          zipfile.close();
        } catch {
          /* 忽略 */
        }
        reject(e);
      };

      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        (async () => {
          // Zip Slip：解出路径必须位于 destRoot 内（拒绝 ../、盘符、绝对路径）
          const target = path.resolve(destRoot, entry.fileName);
          const lower = target.toLowerCase();
          if (lower !== destRoot.toLowerCase() && !lower.startsWith(destRoot.toLowerCase() + path.sep)) {
            await fsp.rm(destRoot, { recursive: true, force: true }).catch(() => {});
            return fail(new PathError('压缩包含不安全路径（疑似路径穿越），已中止'));
          }
          if (entry.fileName.endsWith('/')) {
            await ensureRoot();
            await fsp.mkdir(target, { recursive: true });
          } else {
            totalBytes += entry.uncompressedSize;
            if (totalBytes > maxBytes) {
              await fsp.rm(destRoot, { recursive: true, force: true }).catch(() => {});
              return fail(new PathError(`解压总量超过上限 ${config.extractMaxMb} MB，已中止并清理`));
            }
            await ensureRoot();
            await fsp.mkdir(path.dirname(target), { recursive: true });
            await pipeEntry(zipfile, entry, target);
          }
          doneCount++;
          const pct = Math.min(99, Math.round((doneCount / Math.max(1, entryCount)) * 100));
          if (pct !== lastPct) {
            lastPct = pct;
            updateTask(taskId, { percent: pct, detail: `已解出 ${doneCount}/${entryCount} 项` });
          }
          zipfile.readEntry();
        })().catch(fail);
      });
      zipfile.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(destRoot);
      });
      zipfile.on('error', (e) => {
        fsp.rm(destRoot, { recursive: true, force: true }).catch(() => {});
        fail(new PathError(`解压失败：${e.message}`));
      });
    });
  });
}

// 压缩：sources 为绝对路径数组，目录整体打包（含目录本身）
function compressZip(sources, destZip, taskId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = fs.createWriteStream(destZip);
    const ar = archiver('zip', { zlib: { level: 6 } });
    let lastPct = -1;

    const fail = (e) => {
      if (settled) return;
      settled = true;
      fsp.rm(destZip, { force: true }).catch(() => {});
      reject(new PathError(`压缩失败：${e.message || e}`));
    };

    ar.on('progress', (data) => {
      const total = data.fs.totalBytes;
      const processed = data.fs.processedBytes;
      const pct = total > 0 ? Math.min(99, Math.round((processed / total) * 100)) : 0;
      if (pct !== lastPct) {
        lastPct = pct;
        updateTask(taskId, { percent: pct, detail: `已写入 ${sizeText(processed)} / ${sizeText(total)}` });
      }
    });
    ar.on('error', fail);
    ws.on('error', fail);
    ws.on('close', () => {
      if (settled) return;
      settled = true;
      resolve(destZip);
    });
    ar.pipe(ws);

    try {
      for (const src of sources) {
        const st = fs.statSync(src);
        if (st.isDirectory()) ar.directory(src, path.basename(src));
        else ar.file(src, { name: path.basename(src) });
      }
      ar.finalize().catch(fail);
    } catch (e) {
      fail(e);
    }
  });
}

// 列出压缩包条目（预览用）
function listZipEntries(zipPath, limit = 200) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err) return reject(new PathError(`无法读取压缩包：${err.message}`));
      const out = [];
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (out.length < limit) {
          out.push({
            name: entry.fileName,
            isDir: entry.fileName.endsWith('/'),
            sizeText: sizeText(entry.uncompressedSize),
          });
        }
        zipfile.readEntry();
      });
      zipfile.on('end', () => resolve({ entries: out, total: zipfile.entryCount }));
      zipfile.on('error', (e) => reject(new PathError(`读取压缩包失败：${e.message}`)));
    });
  });
}

module.exports = { enqueue, updateTask, taskEvents, activeTasksFor, extractZip, compressZip, listZipEntries };
