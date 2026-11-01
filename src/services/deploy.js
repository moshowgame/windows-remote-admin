'use strict';

// 简易部署服务：压缩包预检（白名单 + 剥离 node_modules）→ 备份当前版本 → 覆盖解压 → 回滚
// 约定：
// - 包内允许的顶层条目：package.json / server.js / src/ / public/ / views/ / scripts/
// - node_modules/ 自动剥离（用户已确认：剥离 + 警告，不拒绝）
// - data/ logs/ backups/ .env 等运行时/敏感条目直接拒绝（绝不覆盖）
// - 所有条目共用单一顶层目录时自动剥掉该目录（兼容"整个项目包了一层文件夹"的打包习惯）
// - 备份位于 <ROOT>/backups/deploy-<版本>-<时间戳>/，保留最近 5 份

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const pipeline = require('node:util').promisify(require('node:stream').pipeline);
const yauzl = require('yauzl');

const ROOT = path.join(__dirname, '../..');
const BACKUPS_DIR = path.join(ROOT, 'backups');
const STAGING_DIR = path.join(ROOT, 'data', 'deploy-staging');
const PENDING_FILE = path.join(ROOT, 'data', 'deploy-pending.json');
const RESULT_FILE = path.join(ROOT, 'data', 'deploy-last-result.json');

// 备份/覆盖涉及的代码项（存在才处理）
const CODE_ITEMS = ['package.json', 'server.js', 'src', 'public', 'views', 'scripts'];
// 包内允许的顶层目录
const ALLOWED_DIRS = new Set(['src', 'public', 'views', 'scripts']);
// 禁止出现的顶层条目（运行时数据/凭据，绝不覆盖）
const FORBIDDEN_DIRS = new Set(['data', 'logs', 'backups', 'node_modules']);
const MAX_KEEP_BACKUPS = 5;

class DeployError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---- 部署互斥锁（同一时刻仅一个部署/回滚）----
let deploying = false;
function beginDeploy() {
  if (deploying) throw new DeployError('已有部署/回滚任务在进行中，请稍后再试');
  deploying = true;
}
function endDeploy() {
  deploying = false;
}

// ---- 条目规范化与分类 ----
// 返回 { rel, cls }：rel 为剥掉单层包裹目录后的相对路径（/ 分隔），cls ∈ allowed|strip|forbidden|unknown
function classifyEntry(fileName, allFirstSegs) {
  let parts = fileName.split('/').filter(Boolean);
  if (!parts.length) return null;
  // 全部条目共用同一个不在白名单里的顶层目录 → 视为打包外壳，剥离
  if (allFirstSegs.size === 1 && !ALLOWED_DIRS.has(parts[0]) && parts[0] !== 'package.json' && parts[0] !== 'server.js') {
    parts = parts.slice(1);
    if (!parts.length) return null;
  }
  const top = parts[0];
  if (top === 'node_modules') return { rel: parts.join('/'), cls: 'strip' };
  if (FORBIDDEN_DIRS.has(top)) return { rel: parts.join('/'), cls: 'forbidden' };
  if (top === 'package.json' || top === 'server.js' || ALLOWED_DIRS.has(top)) return { rel: parts.join('/'), cls: 'allowed' };
  if (top.startsWith('.env')) return { rel: parts.join('/'), cls: 'forbidden' };
  return { rel: parts.join('/'), cls: 'unknown' };
}

// 打开 zip 并逐条目回调（集中处理 yauzl 样板与错误）
function walkZip(zipPath, onEntry) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err) return reject(new DeployError(`无法读取压缩包：${err.message}`));
      const fail = (e) => {
        try { zipfile.close(); } catch { /* 忽略 */ }
        reject(e);
      };
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        Promise.resolve(onEntry(zipfile, entry))
          .then(() => zipfile.readEntry())
          .catch(fail);
      });
      zipfile.on('end', () => resolve(zipfile.entryCount));
      zipfile.on('error', (e) => fail(new DeployError(`读取压缩包失败：${e.message}`)));
    });
  });
}

// 读取包内 package.json（限制 512KB，防恶意超大条目）
function readPackageJson(zipPath) {
  return new Promise((resolve) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err) return resolve(null);
      let found = false;
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        const parts = entry.fileName.split('/').filter(Boolean);
        // 兼容单层包裹：取末两级判断 package.json
        const isPkg = parts[parts.length - 1] === 'package.json' && (parts.length === 1 || parts.length === 2);
        if (!found && isPkg && !entry.fileName.endsWith('/')) {
          found = true;
          zipfile.openReadStream(entry, (e, rs) => {
            if (e) return resolve(null);
            const chunks = [];
            let total = 0;
            rs.on('data', (c) => {
              total += c.length;
              if (total > 512 * 1024) { rs.destroy(); return resolve(null); }
              chunks.push(c);
            });
            rs.on('end', () => {
              try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); }
            });
            rs.on('error', () => resolve(null));
          });
        } else {
          zipfile.readEntry();
        }
      });
      zipfile.on('end', () => resolve(null));
      zipfile.on('error', () => resolve(null));
    });
  });
}

// ---- 预检：不落盘解压，仅分类统计 ----
async function analyzePackage(zipPath, { maxFiles = 20000, maxTotalMb = 500 } = {}) {
  const firstSegs = new Set();
  const pre = await walkZip(zipPath, (zf, entry) => {
    const seg = entry.fileName.split('/').filter(Boolean)[0];
    if (seg) firstSegs.add(seg);
  });

  const result = {
    entryCount: pre,
    fileCount: 0,
    dirCount: 0,
    strippedCount: 0,
    totalBytes: 0,
    violations: [],
    topsPresent: new Set(),
    samples: [],
  };

  await walkZip(zipPath, async (zf, entry) => {
    const c = classifyEntry(entry.fileName, firstSegs);
    if (!c) return;
    if (c.cls === 'strip') {
      if (!entry.fileName.endsWith('/')) result.strippedCount++;
      return;
    }
    if (c.cls === 'forbidden' || c.cls === 'unknown') {
      if (result.violations.length < 10) result.violations.push(c.rel + (entry.fileName.endsWith('/') ? '/' : ''));
      return;
    }
    if (entry.fileName.endsWith('/')) {
      result.dirCount++;
    } else {
      result.fileCount++;
      result.totalBytes += entry.uncompressedSize;
      const top = c.rel.split('/')[0];
      if (top === 'package.json' || top === 'server.js') result.topsPresent.add(top);
      else result.topsPresent.add(top);
      if (result.samples.length < 30) result.samples.push(c.rel);
    }
  });

  if (result.entryCount > maxFiles) throw new DeployError(`压缩包含 ${result.entryCount} 个条目，超过上限 ${maxFiles}`);
  if (result.totalBytes > maxTotalMb * 1024 * 1024) throw new DeployError(`解压总量 ${Math.round(result.totalBytes / 1024 / 1024)}MB，超过上限 ${maxTotalMb}MB`);

  // 硬性结构要求
  if (!result.topsPresent.has('package.json')) throw new DeployError('压缩包缺少 package.json（必须包含在根目录或单一顶层目录内）');
  if (!result.topsPresent.has('server.js')) throw new DeployError('压缩包缺少 server.js（入口文件必须包含）');
  if (![...result.topsPresent].some((t) => ALLOWED_DIRS.has(t))) throw new DeployError('压缩包缺少代码目录（src/ 等必须包含）');
  if (result.violations.length) {
    throw new DeployError(`压缩包含不允许覆盖的条目（运行时数据/敏感文件），已中止：${result.violations.join('、')}`);
  }

  // 版本与依赖对比
  const pkg = await readPackageJson(zipPath);
  if (!pkg || !pkg.version) throw new DeployError('package.json 无法解析或缺少 version 字段');
  const cur = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const depDiff = [];
  const oldDeps = cur.dependencies || {};
  const newDeps = pkg.dependencies || {};
  const keys = new Set([...Object.keys(oldDeps), ...Object.keys(newDeps)]);
  for (const k of keys) {
    if (oldDeps[k] !== newDeps[k]) depDiff.push(`${k}: ${oldDeps[k] || '(无)'} → ${newDeps[k] || '(移除)'}`);
  }

  result.name = pkg.name || '(未知)';
  result.version = pkg.version;
  result.curVersion = cur.version || '(未知)';
  result.depDiff = depDiff;

  if (result.strippedCount > 0) {
    result.stripWarning = `已识别 node_modules 条目 ${result.strippedCount} 个，部署时将自动剥离（不覆盖现有依赖）`;
  }
  return result;
}

// ---- 版本号：用户输入主版本（数字与点），时间戳在备份时自动追加 ----
function sanitizeVersion(v) {
  const s = String(v || '').trim();
  return /^\d{1,4}(\.\d{1,4}){0,3}$/.test(s) ? s : null;
}

// 建议的下一个主版本：最近一次备份的版本 +1（patch 段进位）；无备份时取当前 package.json 版本 +1
async function suggestNextVersion() {
  const entries = await fsp.readdir(BACKUPS_DIR).catch(() => []);
  let latest = null;
  let latestTs = -1;
  for (const name of entries) {
    const m = name.match(/^deploy-(\d+(?:\.\d+)*)-\d{8}_\d{6}$/);
    if (!m) continue;
    const st = await fsp.stat(path.join(BACKUPS_DIR, name)).catch(() => null);
    const ts = st ? st.mtimeMs : 0;
    if (ts >= latestTs) { latestTs = ts; latest = m[1]; }
  }
  let base = latest;
  if (!base) {
    const cur = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8').catch(() => ({})));
    base = sanitizeVersion(cur.version);
  }
  if (!base) return '1.0.0';
  const segs = base.split('.');
  segs[segs.length - 1] = String(Number(segs[segs.length - 1]) + 1);
  return segs.join('.');
}

// ---- 备份当前版本（version 为用户输入的主版本标识，缺省回退 package.json 版本）----
async function backupCurrent(version) {
  const cur = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8').catch(() => ({})));
  const v = sanitizeVersion(version) || cur.version || 'unknown';
  const backupId = `deploy-${v}-${stamp()}`;
  const dir = path.join(BACKUPS_DIR, backupId);
  await fsp.mkdir(dir, { recursive: true });
  const items = [];
  for (const item of CODE_ITEMS) {
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) continue;
    await fsp.cp(src, path.join(dir, item), { recursive: true });
    items.push(item);
  }
  await fsp.writeFile(path.join(dir, 'backup-meta.json'), JSON.stringify({
    id: backupId,
    version: v,
    items,
    createdAt: Date.now(),
  }, null, 2));
  return { backupId, items };
}

// ---- 列出备份（含自动清理，仅保留最近 N 份）----
async function listBackups(limit = MAX_KEEP_BACKUPS) {
  const entries = await fsp.readdir(BACKUPS_DIR).catch(() => []);
  const list = [];
  for (const name of entries) {
    const dir = path.join(BACKUPS_DIR, name);
    const st = await fsp.stat(dir).catch(() => null);
    if (!st || !st.isDirectory()) continue;
    let meta = {};
    try { meta = JSON.parse(await fsp.readFile(path.join(dir, 'backup-meta.json'), 'utf8')); } catch { /* 无 meta 也展示 */ }
    list.push({ id: name, version: meta.version || null, items: meta.items || [], createdAt: meta.createdAt || st.mtimeMs });
  }
  list.sort((a, b) => b.createdAt - a.createdAt);
  // 清理超出保留数的旧备份
  for (const old of list.slice(limit)) {
    await fsp.rm(path.join(BACKUPS_DIR, old.id), { recursive: true, force: true }).catch(() => {});
  }
  return list.slice(0, limit);
}

// 校验备份 id（防路径穿越）
function safeBackupId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(id) || id.includes('..')) return null;
  const dir = path.join(BACKUPS_DIR, id);
  if (!path.resolve(dir).startsWith(path.resolve(BACKUPS_DIR) + path.sep)) return null;
  return fs.existsSync(dir) ? dir : null;
}

// ---- 回滚：备份内容覆盖回程序目录（目录先删后拷，保证干净回退）----
async function restoreBackup(backupId) {
  const dir = safeBackupId(backupId);
  if (!dir) throw new DeployError('备份不存在或已清理');
  let meta = {};
  try { meta = JSON.parse(await fsp.readFile(path.join(dir, 'backup-meta.json'), 'utf8')); } catch { /* 忽略 */ }
  const items = meta.items && meta.items.length ? meta.items : CODE_ITEMS.filter((i) => fs.existsSync(path.join(dir, i)));
  const restored = [];
  for (const item of items) {
    const src = path.join(dir, item);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(ROOT, item);
    await fsp.rm(dst, { recursive: true, force: true });
    await fsp.cp(src, dst, { recursive: true });
    restored.push(item);
  }
  if (!restored.length) throw new DeployError('备份内容为空，无法回滚');
  await clearPending();
  return { backupId, restored };
}

// ---- 覆盖解压（仅白名单条目，剥离 node_modules；Zip Slip 校验）----
async function extractPackage(zipPath, analysis) {
  const firstSegs = new Set();
  await walkZip(zipPath, async (zf, entry) => {
    const seg = entry.fileName.split('/').filter(Boolean)[0];
    if (seg) firstSegs.add(seg);
  });

  // 旧代码目录先删后解，保证干净替换（仅删除包内实际携带的目录）
  for (const top of ['src', 'public', 'views', 'scripts']) {
    if (analysis.topsPresent.has(top)) {
      await fsp.rm(path.join(ROOT, top), { recursive: true, force: true });
    }
  }

  const maxBytes = 500 * 1024 * 1024;
  let totalBytes = 0;
  let written = 0;
  const writtenPaths = [];

  await walkZip(zipPath, async (zf, entry) => {
    const c = classifyEntry(entry.fileName, firstSegs);
    if (!c || c.cls !== 'allowed' || entry.fileName.endsWith('/')) return;
    const target = path.resolve(ROOT, c.rel);
    if (target !== ROOT && !target.toLowerCase().startsWith(path.resolve(ROOT).toLowerCase() + path.sep)) {
      throw new DeployError('压缩包含不安全路径（疑似路径穿越），已中止');
    }
    totalBytes += entry.uncompressedSize;
    if (totalBytes > maxBytes) throw new DeployError('解压总量超过上限 500MB，已中止');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.rm(target, { force: true });
    const rs = await new Promise((resolve, reject) => {
      zf.openReadStream(entry, (e, s) => (e ? reject(e) : resolve(s)));
    });
    await pipeline(rs, fs.createWriteStream(target));
    written++;
    writtenPaths.push(c.rel);
  });

  return { written, writtenPaths };
}

// ---- pending 标记（供启动门卫验证 + 失败自动回滚）----
async function writePending(info) {
  await fsp.mkdir(path.dirname(PENDING_FILE), { recursive: true });
  await fsp.writeFile(PENDING_FILE, JSON.stringify({ attempts: 0, ...info, ts: Date.now() }, null, 2));
}
async function readPending() {
  try { return JSON.parse(await fsp.readFile(PENDING_FILE, 'utf8')); } catch { return null; }
}
async function clearPending() {
  await fsp.rm(PENDING_FILE, { force: true }).catch(() => {});
}

// staging 临时 zip 路径（token 仅允许文件名字符）
function stagingPath(token) {
  if (typeof token !== 'string' || !/^deploy-[0-9_-]+\.zip$/.test(token)) return null;
  return path.join(STAGING_DIR, token);
}
async function newStagingPath() {
  await fsp.mkdir(STAGING_DIR, { recursive: true });
  return path.join(STAGING_DIR, `deploy-${stamp()}.zip`);
}

// 清理超龄 staging（上传后一直未确认的 zip），默认保留 24 小时
async function cleanupStaging(maxAgeMs = 24 * 60 * 60 * 1000) {
  try {
    const names = await fsp.readdir(STAGING_DIR);
    const cutoff = Date.now() - maxAgeMs;
    for (const name of names) {
      if (!/^deploy-[0-9_-]+\.zip$/.test(name)) continue;
      const p = path.join(STAGING_DIR, name);
      try {
        const st = await fsp.stat(p);
        if (st.mtimeMs < cutoff) await fsp.rm(p, { force: true });
      } catch { /* 单文件失败忽略 */ }
    }
  } catch { /* 目录不存在等忽略 */ }
}

// ---- 部署启动结果（boot-gate 落盘，页面展示；首次被读取时补写审计后打标记）----
async function readLastResult() {
  try { return JSON.parse(await fsp.readFile(RESULT_FILE, 'utf8')); } catch { return null; }
}
async function markResultAudited(result) {
  try { await fsp.writeFile(RESULT_FILE, JSON.stringify({ ...result, audited: true }, null, 2)); } catch { /* 忽略 */ }
}

module.exports = {
  DeployError,
  beginDeploy,
  endDeploy,
  analyzePackage,
  backupCurrent,
  restoreBackup,
  listBackups,
  extractPackage,
  writePending,
  readPending,
  clearPending,
  stagingPath,
  newStagingPath,
  cleanupStaging,
  readLastResult,
  markResultAudited,
  sanitizeVersion,
  suggestNextVersion,
};
