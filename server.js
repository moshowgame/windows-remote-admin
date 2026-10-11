'use strict';

// 入口：构建应用并监听端口
const { buildApp } = require('./src/app');

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
