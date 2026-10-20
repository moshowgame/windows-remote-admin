'use strict';

// 整页路由（/dashboard、/console）；/files /editor /logs 由各自模块注册
const systeminfo = require('../services/systeminfo');
const { getQuickCommands } = require('./console');
const i18n = require('../i18n');

module.exports = async function pageRoutes(app) {
  app.get('/', async (request, reply) => reply.redirect('/dashboard', 303));

  // 语言切换：写 cookie 后跳回来源页（GET 安全方法，无需 CSRF；公开路由保证登录页切换可用）
  app.get('/lang/:code', { config: { public: true } }, async (request, reply) => {
    const { code } = request.params;
    if (i18n.LANGS.includes(code)) {
      reply.setCookie(i18n.COOKIE, code, { path: '/', maxAge: 31536000, sameSite: 'lax' });
    }
    return reply.redirect(request.headers.referer || '/dashboard', 303);
  });

  // Dashboard：初始渲染直出统计卡片
  app.get('/dashboard', async (request, reply) => {
    const s = await systeminfo.getSnapshot();
    return reply.renderPage('pages/dashboard', { title: request.t('dashboard.title'), active: 'dashboard', s });
  });

  // PowerShell 控制台
  app.get('/console', async (request, reply) => {
    return reply.renderPage('pages/console', {
      title: request.t('console.title'),
      active: 'console',
      quickCommands: getQuickCommands(request.t),
      timeoutMs: app.config.psTimeoutMs,
    });
  });
};
