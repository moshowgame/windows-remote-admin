'use strict';

// 入口：构建应用并监听端口
const path = require('node:path');
const fs = require('node:fs');
const { buildApp } = require('./src/app');

// 加载程序目录下的 .env（与启动时的工作目录无关）。
// 语义：不覆盖已存在的环境变量——外部注入（shell export / NSSM AppEnvironmentExtra）优先于 .env。
function loadDotenv(file) {
  if (!fs.existsSync(file)) return 0;
  // 支持 UTF-8 BOM、CRLF/LF；KEY=VALUE，忽略空行与 # 注释行，兼容 "export KEY=" 前缀与行内注释
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  let count = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice(7).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (/^['"]/.test(value)) {
      // 带引号：取首个成对引号内的内容，其余（含行内注释）丢弃
      const end = value.indexOf(value[0], 1);
      if (end > 0) value = value.slice(1, end);
    } else {
      const hash = value.indexOf(' #');
      if (hash > -1) value = value.slice(0, hash).trim();
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
      count++;
    }
  }
  return count;
}

const envLoaded = loadDotenv(path.join(__dirname, '.env'));
if (envLoaded > 0) console.log(`[WRA] 已从程序目录加载 .env（${envLoaded} 个变量）`);

async function main() {
  const app = await buildApp();
  try {
    await app.listen({ port: app.config.port, host: '0.0.0.0' });
  } catch (err) {
    app.log.error(err, '启动失败');
    process.exit(1);
  }
}

main();
