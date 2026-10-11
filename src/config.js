'use strict';

// 配置加载：config.default.json < config.json（可选） < WRA_* 环境变量
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');

// 1. 默认配置
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.default.json'), 'utf8'));

// 2. config.json 可选覆盖（quickAccess 等本机化配置）
const userCfgPath = path.join(ROOT, 'config.json');
if (fs.existsSync(userCfgPath)) {
  try {
    Object.assign(config, JSON.parse(fs.readFileSync(userCfgPath, 'utf8')));
  } catch {
    // 配置文件损坏时忽略，使用默认值
    console.warn('[config] config.json 解析失败，已忽略');
  }
}

// 3. 环境变量覆盖
const env = process.env;
const num = (v) => Number(v);
if (env.WRA_PORT) config.port = num(env.WRA_PORT);
if (env.WRA_PS_TIMEOUT) config.psTimeoutMs = num(env.WRA_PS_TIMEOUT);
if (env.WRA_UPLOAD_MAX_MB) config.uploadMaxMb = num(env.WRA_UPLOAD_MAX_MB);
if (env.WRA_READ_MAX_MB) config.readMaxMb = num(env.WRA_READ_MAX_MB);
if (env.WRA_EXTRACT_MAX_MB) config.extractMaxMb = num(env.WRA_EXTRACT_MAX_MB);
if (env.WRA_EXTRACT_MAX_FILES) config.extractMaxFiles = num(env.WRA_EXTRACT_MAX_FILES);
if (env.WRA_ENABLE_SERVER_OPEN) {
  config.enableServerOpen = env.WRA_ENABLE_SERVER_OPEN === 'true' || env.WRA_ENABLE_SERVER_OPEN === '1';
}
if (env.WRA_PATH_WHITELIST !== undefined) {
  config.pathWhitelist = env.WRA_PATH_WHITELIST.split(/[|;]/).map((s) => s.trim()).filter(Boolean);
}
if (env.WRA_LOG_RETENTION) config.logRetentionDays = num(env.WRA_LOG_RETENTION);

// 保存用户配置：合并写入 config.json（保留既有键），并同步运行时 config
function saveUserConfig(patch) {
  const userCfgPath = path.join(ROOT, 'config.json');
  let userCfg = {};
  try {
    userCfg = JSON.parse(fs.readFileSync(userCfgPath, 'utf8'));
  } catch {
    // 不存在或损坏均从空对象开始
  }
  Object.assign(userCfg, patch);
  fs.writeFileSync(userCfgPath, JSON.stringify(userCfg, null, 2) + '\n', 'utf8');
  Object.assign(config, patch);
  return userCfg;
}

// 会话签名密钥：环境变量 > data/.session-key > 自动生成并持久化
function ensureSessionKey(dataDir) {
  const secret = env.WRA_SESSION_SECRET;
  if (secret) {
    // 64 位 hex 优先按 hex 解码为 32 字节，否则按 utf8 字节（须 ≥32 字节）
    return /^[0-9a-fA-F]{64}$/.test(secret) ? Buffer.from(secret, 'hex') : Buffer.from(secret, 'utf8');
  }
  const keyPath = path.join(dataDir, '.session-key');
  try {
    const hex = fs.readFileSync(keyPath, 'utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
  } catch {
    // 文件不存在，走生成逻辑
  }
  const hex = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(keyPath, hex, { mode: 0o600 });
  return Buffer.from(hex, 'hex');
}

module.exports = { config, ROOT, ensureSessionKey, saveUserConfig };
