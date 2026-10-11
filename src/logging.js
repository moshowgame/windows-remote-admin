'use strict';

// pino 三流日志：app（控制台彩色 + 文件）/ audit（仅文件）/ access（仅文件）
// 按天轮转，保留 config.logRetentionDays 天；审计行格式对齐旧版（本地时间字符串 + 大写级别）
const fs = require('node:fs');
const path = require('node:path');
const pino = require('pino');
const pretty = require('pino-pretty');
const roll = require('pino-roll');
const { config } = require('./config');

// 本地时间 "yyyy-MM-dd HH:mm:ss.SSS"
function localTimestamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// pino-roll v2 返回 Promise，需 await
async function rollStream(file) {
  return roll({
    file,
    frequency: 'daily',
    limit: { count: config.logRetentionDays },
    mkdir: true,
  });
}

async function buildLoggers(logDir) {
  fs.mkdirSync(logDir, { recursive: true });

  // 公共行格式：time 在最前，level 为大写字符串，去掉 pid/hostname
  const ts = () => `,"time":"${localTimestamp()}"`;
  const formatters = { level: (label) => ({ level: label.toUpperCase() }) };
  const base = null;

  // app 流：控制台（pino-pretty 彩色）+ logs/app.log
  const prettyStream = pretty({
    colorize: true,
    translateTime: false,
    ignore: 'pid,hostname',
    messageFormat: '{msg}',
  });
  const app = pino(
    { level: 'info', timestamp: ts, formatters, base },
    pino.multistream([
      { stream: prettyStream },
      { stream: await rollStream(path.join(logDir, 'app.log')) },
    ])
  );

  // audit 流：仅 logs/audit.log
  const audit = pino(
    { level: 'info', timestamp: ts, formatters, base },
    await rollStream(path.join(logDir, 'audit.log'))
  );

  // access 流：仅 logs/access.log
  const access = pino(
    { level: 'info', timestamp: ts, formatters, base },
    await rollStream(path.join(logDir, 'access.log'))
  );

  return { app, audit, access };
}

module.exports = { buildLoggers };
