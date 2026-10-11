'use strict';

// 整页路由（/dashboard、/console）；/files /editor /logs 由各自模块注册
const systeminfo = require('../services/systeminfo');
const { quickCommands } = require('./console');

module.exports = async function pageRoutes(app) {
  app.get('/', async (request, reply) => reply.redirect('/dashboard', 303));

  // Dashboard：初始渲染直出统计卡片
  app.get('/dashboard', async (request, reply) => {
    const s = await systeminfo.getSnapshot();
    return reply.renderPage('pages/dashboard', { title: '系统概览', active: 'dashboard', s });
  });

  // PowerShell 控制台
  app.get('/console', async (request, reply) => {
    return reply.renderPage('pages/console', {
      title: 'PowerShell 控制台',
      active: 'console',
      quickCommands,
      timeoutMs: app.config.psTimeoutMs,
    });
  });
};
