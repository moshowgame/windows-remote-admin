'use strict';

// 启动门卫：部署后的首次启动验证 + 失败自动回滚
// 机制：/deploy 落盘新代码时写入 data/deploy-pending.json（含备份 id）；
// server.js 第一步进入 run(bootFn)：标记存在即"验证模式"——
//   - 启动成功（监听就绪）→ 清标记，部署转正；
//   - 启动失败（模块加载/插件初始化/端口监听抛错）→ 从备份回滚代码 → 清标记 → 退出，
//     由 NSSM / node --watch / 人工重启拉起旧版本。
// 自保护：连续失败超过 MAX_ATTEMPTS 次不再自动回滚（防循环），保留提示人工处理。

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MARKER = path.join(ROOT, 'data', 'deploy-pending.json');
const BACKUPS_DIR = path.join(ROOT, 'backups');
const MAX_ATTEMPTS = 2;

// 验证模式启动超时：超时视为新版本失败（可 env 覆盖便于测试）
const BOOT_TIMEOUT_MS = Number(process.env.WRA_BOOT_TIMEOUT_MS) || 60000;
// 环境性错误：端口被占用/无权限 ≠ 版本问题，不回滚（旧版本同样起不来），保留部署与备份交人工处理
const ENV_ERR_CODES = new Set(['EADDRINUSE', 'EACCES']);

// 为启动函数加超时护栏：bootFn 既不抛错也不就绪时按失败处理，避免进程悬挂
function withTimeout(bootFn) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`boot timeout after ${Math.round(BOOT_TIMEOUT_MS / 1000)}s (listen not ready)`);
      err.code = 'WRA_BOOT_TIMEOUT';
      reject(err);
    }, BOOT_TIMEOUT_MS);
    Promise.resolve()
      .then(bootFn)
      .then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); }
      );
  });
}

function readMarker() {
  try {
    const m = JSON.parse(fs.readFileSync(MARKER, 'utf8'));
    return m && m.backupId ? m : null;
  } catch {
    return null;
  }
}

function clearMarker() {
  try { fs.rmSync(MARKER, { force: true }); } catch { /* 忽略 */ }
}

// 从备份恢复代码（目录先删后拷）；id 防路径穿越，备份缺失视为回滚不成立
function rollback(backupId) {
  if (typeof backupId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(backupId) || backupId.includes('..')) return false;
  const dir = path.join(BACKUPS_DIR, backupId);
  if (!path.resolve(dir).startsWith(path.resolve(BACKUPS_DIR) + path.sep) || !fs.existsSync(dir)) return false;
  let items = [];
  try {
    items = JSON.parse(fs.readFileSync(path.join(dir, 'backup-meta.json'), 'utf8')).items || [];
  } catch { /* 无 meta 时按探测 */ }
  if (!items.length) {
    items = ['package.json', 'server.js', 'src', 'public', 'views', 'scripts'].filter((i) => fs.existsSync(path.join(dir, i)));
  }
  for (const item of items) {
    const src = path.join(dir, item);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(ROOT, item);
    fs.rmSync(dst, { recursive: true, force: true });
    fs.cpSync(src, dst, { recursive: true });
  }
  return items.length > 0;
}

// 包装启动函数：无标记 → 原样启动（失败退出码 1，交给进程管理器）；
// 有标记 → 验证模式（成功转正 / 失败自动回滚）
async function run(bootFn) {
  const marker = readMarker();
  if (!marker) {
    try {
      await bootFn();
    } catch (err) {
      console.error('[WRA] 启动失败：', err && err.stack ? err.stack : err);
      process.exit(1);
    }
    return;
  }

  // 验证模式
  console.log(`[WRA] 检测到待验证部署 v${marker.toVersion || '?'}（备份 ${marker.backupId}），进入启动验证…`);
  try {
    await withTimeout(bootFn);
    clearMarker();
    console.log(`[WRA] 部署 v${marker.toVersion || '?'} 启动成功，已转正`);
    return;
  } catch (err) {
    // 环境性错误（端口被占用/无权限）≠ 版本问题：不回滚，保留部署与备份，交人工释放端口后重启
    if (err && ENV_ERR_CODES.has(err.code)) {
      console.error(`[WRA] 启动失败为环境问题（${err.code}），非版本问题，不回滚；请释放端口后重启验证（备份保留：${marker.backupId}）`);
      process.exit(1);
    }
    console.error('[WRA] 部署后首次启动失败：', err && err.message ? err.message : err);
  }

  marker.attempts = (marker.attempts || 0) + 1;
  if (marker.attempts > MAX_ATTEMPTS) {
    clearMarker();
    console.error(`[WRA] 启动失败超过 ${MAX_ATTEMPTS} 次，停止自动回滚，请人工处理（备份：${marker.backupId}）`);
    process.exit(1);
  }

  let ok = false;
  try {
    ok = rollback(marker.backupId);
  } catch (e) {
    console.error('[WRA] 回滚过程出错：', e && e.message ? e.message : e);
  }
  clearMarker();
  if (ok) {
    console.error(`[WRA] 已自动回滚到备份 ${marker.backupId}，进程即将退出；重启后将运行上一版本`);
    process.exit(0);
  }
  console.error(`[WRA] 自动回滚失败（备份 ${marker.backupId} 缺失或为空），请人工处理`);
  process.exit(1);
}

module.exports = { run };
