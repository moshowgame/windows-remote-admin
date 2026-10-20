'use strict';

// 用户认证服务：data/entitlement.csv
// - 新格式：username,password_hash（bcrypt）[,role]（admin / readonly，缺省 admin）
// - 兼容旧格式：明文密码首次启动自动迁移，原文件备份为 entitlement.csv.plain.bak（迁移保留 role 列）
// - 文件不存在：种子默认账号 admin / admin123
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');

function csvPath(dataDir) {
  return path.join(dataDir, 'entitlement.csv');
}

// 解析 CSV：username,password[,role]，忽略表头；role 仅认 readonly，其余一律 admin
function parse(content) {
  const users = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(',');
    if (idx <= 0) continue;
    const username = trimmed.slice(0, idx).trim();
    const rest = trimmed.slice(idx + 1).trim();
    const idx2 = rest.indexOf(',');
    let password = rest;
    let role = 'admin';
    if (idx2 > 0) {
      password = rest.slice(0, idx2).trim();
      role = rest.slice(idx2 + 1).trim().toLowerCase();
    }
    if (!username || !password) continue;
    if (/^username$/i.test(username)) continue; // 表头行
    if (role !== 'readonly') role = 'admin';
    users.push({ username, password, role });
  }
  return users;
}

// 序列化行：readonly 保留角色列，admin 省略（兼容旧格式）
function serializeUser(u) {
  return u.role === 'readonly' ? `${u.username},${u.password},readonly` : `${u.username},${u.password}`;
}

// 启动时调用：种子 / 明文迁移
function ensure(dataDir, log) {
  const file = csvPath(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });

  if (!fs.existsSync(file)) {
    const hash = bcrypt.hashSync('admin123', 10);
    fs.writeFileSync(file, `admin,${hash}\n`, 'utf8');
    log.warn('entitlement.csv 不存在，已创建默认账号 admin / admin123，请登录后尽快修改');
    return;
  }

  const users = parse(fs.readFileSync(file, 'utf8'));
  const hasPlain = users.some((u) => !u.password.startsWith('$2'));
  if (!hasPlain) return;

  // 备份明文文件 → 哈希迁移 → 回写（保留 role 列）
  fs.copyFileSync(file, `${file}.plain.bak`);
  const migrated = users.map((u) => {
    const hash = u.password.startsWith('$2') ? u.password : bcrypt.hashSync(u.password, 10);
    return serializeUser({ username: u.username, password: hash, role: u.role });
  });
  fs.writeFileSync(file, migrated.join('\n') + '\n', 'utf8');
  log.warn(`检测到明文密码，已自动迁移为 bcrypt 哈希（${users.length} 个账号），原文件备份为 entitlement.csv.plain.bak`);
}

// 校验登录（每次读盘：用户量小，且支持改密后即时生效）
function verify(dataDir, username, password) {
  const file = csvPath(dataDir);
  if (!fs.existsSync(file)) return false;
  const users = parse(fs.readFileSync(file, 'utf8'));
  const user = users.find((u) => u.username === username);
  if (!user) return false;
  try {
    return bcrypt.compareSync(password, user.password);
  } catch {
    return false;
  }
}

// 查询用户角色（admin / readonly；不存在返回 null）
function roleOf(dataDir, username) {
  const file = csvPath(dataDir);
  if (!fs.existsSync(file)) return null;
  const users = parse(fs.readFileSync(file, 'utf8'));
  const user = users.find((u) => u.username === username);
  return user ? user.role : null;
}

module.exports = { ensure, verify, roleOf };
