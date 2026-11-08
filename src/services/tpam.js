'use strict';

// self-TPAM：临时特权账号（release 场景）
// - admin 输入 CR/IN 编号 + Staff ID，生成 <StaffID>_tpam 临时账号（admin 权限），有效期 4 小时
// - 凭据落盘 data/tpam.json（仅 bcrypt 哈希，明文密码仅在生成响应中展示一次，不落盘）
// - 过期账号：登录被拒、现有会话在认证钩子中被强制登出（惰性清理，读盘时顺带剔除过期项）
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const TTL_MS = 4 * 60 * 60 * 1000; // 4 小时
const STAFF_RE = /^[A-Za-z0-9_]{1,32}$/; // Staff ID：字母/数字/下划线
const CRIN_RE = /^[A-Za-z0-9\-_]{1,40}$/; // CR/IN 编号：字母/数字/横线/下划线
// 随机密码字符集（去掉 0O1lI 等易混淆字符），16 位
const PWD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%^&*';

function filePath(dataDir) {
  return path.join(dataDir, 'tpam.json');
}

// 读取 + 惰性清理过期项（不回写，写操作时自然落盘清理结果）
function load(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(dataDir), 'utf8'));
    const acc = raw && raw.accounts && typeof raw.accounts === 'object' ? raw.accounts : {};
    const now = Date.now();
    const accounts = {};
    for (const [k, v] of Object.entries(acc)) {
      if (v && typeof v.hash === 'string' && typeof v.expiresAt === 'number' && v.expiresAt > now) {
        accounts[k] = v;
      }
    }
    return accounts;
  } catch {
    return {};
  }
}

function save(dataDir, accounts) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(filePath(dataDir), JSON.stringify({ accounts }, null, 2), 'utf8');
}

function randomPassword(len = 16) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += PWD_CHARS[bytes[i] % PWD_CHARS.length];
  return out;
}

function isValidStaff(s) { return STAFF_RE.test(s); }
function isValidCrIn(s) { return CRIN_RE.test(s); }
function usernameOf(staffId) { return staffId + '_tpam'; }

// 生成（同名账号已存在则覆盖 = 续期换密码，TTL 重置）
function generate(dataDir, staffId, crIn) {
  const username = usernameOf(staffId);
  const password = randomPassword();
  const now = Date.now();
  const accounts = load(dataDir);
  accounts[username] = {
    staffId,
    crIn,
    hash: bcrypt.hashSync(password, 10),
    createdAt: now,
    expiresAt: now + TTL_MS,
  };
  save(dataDir, accounts);
  return { username, password, staffId, crIn, createdAt: now, expiresAt: now + TTL_MS };
}

// 登录校验：仅 _tpam 账号走此处；不存在/已过期/密码不符一律 false
function verify(dataDir, username, password) {
  const acc = load(dataDir)[username];
  if (!acc) return false;
  try {
    return bcrypt.compareSync(password, acc.hash);
  } catch {
    return false;
  }
}

// 会话存活检查（认证钩子用）：账号存在且未过期
function sessionAlive(dataDir, username) {
  return !!load(dataDir)[username];
}

// 列表（已按过期惰性过滤），剩余时间排序
function list(dataDir) {
  const now = Date.now();
  return Object.entries(load(dataDir))
    .map(([username, v]) => ({
      username,
      staffId: v.staffId,
      crIn: v.crIn,
      createdAt: v.createdAt,
      expiresAt: v.expiresAt,
      remainingMs: Math.max(0, v.expiresAt - now),
    }))
    .sort((a, b) => a.expiresAt - b.expiresAt);
}

function revoke(dataDir, username) {
  const accounts = load(dataDir);
  if (!accounts[username]) return false;
  delete accounts[username];
  save(dataDir, accounts);
  return true;
}

module.exports = { TTL_MS, STAFF_RE, CRIN_RE, isValidStaff, isValidCrIn, usernameOf, generate, verify, sessionAlive, list, revoke };
