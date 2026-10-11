'use strict';

// Fastify 应用工厂：插件注册 / 全局钩子 / 错误处理 / 路由挂载
const path = require('node:path');
const fastify = require('fastify');
const formbody = require('@fastify/formbody');
const staticPlugin = require('@fastify/static');
const viewPlugin = require('@fastify/view');
const ejs = require('ejs');
const secureSession = require('@fastify/secure-session');
const rateLimit = require('@fastify/rate-limit');
const csrfProtection = require('@fastify/csrf-protection');
const multipart = require('@fastify/multipart');

const { config, ROOT, ensureSessionKey } = require('./config');
const { buildLoggers } = require('./logging');
const authenticate = require('./hooks/auth');
const auditFn = require('./hooks/audit');
const entitlement = require('./services/entitlement');
const authRoutes = require('./routes/auth');
const pageRoutes = require('./routes/pages');
const dashboardRoutes = require('./routes/dashboard');
const consoleRoutes = require('./routes/console');
const filesRoutes = require('./routes/files');
const editorRoutes = require('./routes/editor');
const logsRoutes = require('./routes/logs');
const settingsRoutes = require('./routes/settings');
const servicesRoutes = require('./routes/services');

async function buildApp() {
  const loggers = await buildLoggers(path.join(ROOT, 'logs'));

  // 会话密钥（环境变量 > data/.session-key > 自动生成）
  config.sessionKey = ensureSessionKey(path.join(ROOT, 'data'));

  // 用户文件初始化：种子默认账号 / 明文密码自动迁移
  entitlement.ensure(path.join(ROOT, 'data'), loggers.app);

  const app = fastify({
    loggerInstance: loggers.app,
    disableRequestLogging: true, // 关闭默认请求日志（防敏感头泄露），access 流由 onResponse 钩子写
    trustProxy: true,            // 反代场景下取真实客户端 IP（限流/审计用）
    bodyLimit: 20 * 1024 * 1024, // 编辑器保存 10MB 文本（表单编码会膨胀），留足余量
  });

  // ---- 全局装饰 ----
  app.decorate('config', config);
  app.decorate('auditLog', loggers.audit);
  app.decorate('audit', auditFn);

  // 整页渲染辅助：自动注入 csrf 与 username
  app.decorateReply('renderPage', function renderPage(view, data = {}) {
    const csrf = this.generateCsrf();
    const username = this.request.session ? this.request.session.get('username') || '' : '';
    return this.view(view, { ...data, csrf, username });
  });

  // ---- 插件 ----
  await app.register(formbody);
  await app.register(multipart, {
    limits: {
      fileSize: (config.uploadMaxMb || 100) * 1024 * 1024, // 单文件上限
      files: 20,                                           // 单次最多文件数
    },
  });
  await app.register(staticPlugin, {
    root: path.join(ROOT, 'public'),
    prefix: '/static/',
  });
  await app.register(viewPlugin, {
    engine: { ejs },
    root: path.join(ROOT, 'views'),
  });
  await app.register(secureSession, {
    secret: config.sessionKey,
    cookieName: 'wra_session',
    cookie: { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 86400 }, // 24h
  });
  await app.register(rateLimit, { global: false }); // 仅对显式声明的路由限流（/login）
  await app.register(csrfProtection, {
    sessionPlugin: '@fastify/secure-session', // csrf secret 存入会话
    // 优先 HTMX 全局请求头，回退表单隐藏域 _csrf
    getToken: (req) => req.headers['x-csrf-token'] || (req.body && req.body._csrf) || '',
  });
  // csrf-protection 仅暴露钩子函数，需手动挂载；安全方法（GET/HEAD/OPTIONS）不校验
  const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
  app.addHook('preHandler', function csrfGuard(request, reply, done) {
    if (SAFE_METHODS.has(request.method)) return done();
    return app.csrfProtection(request, reply, done);
  });

  // ---- 访问日志（静态资源除外）----
  app.addHook('onResponse', async (request, reply) => {
    if (request.raw.url && request.raw.url.startsWith('/static/')) return;
    loggers.access.info({
      method: request.method,
      url: request.raw.url,
      status: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
      username: (request.session && request.session.get('username')) || '-',
      ip: request.ip,
    });
  });

  // ---- 认证钩子（公开路由需在路由 config.public 声明）----
  app.addHook('preHandler', authenticate);

  // ---- 错误处理 ----
  const hxMessages = {
    429: '操作过于频繁，请稍后再试',
    403: '安全校验失败，请刷新页面重试',
  };
  // 生成状态码对应的用户提示（500/403 不泄露内部细节）
  const messageFor = (status, error) => {
    if (status === 400) return error && error.message ? error.message : '请求参数错误';
    if (status === 413) return '请求体过大，超出限制';
    return hxMessages[status] || (status >= 500 ? '服务器内部错误' : '请求失败');
  };
  // 浏览器整页请求渲染友好错误页；渲染失败兜底纯文本
  const sendErrorPage = (reply, request, status, msg) => {
    try {
      return reply.code(status).renderPage('pages/error', {
        title: `错误 ${status}`,
        active: '',
        code: status,
        message: msg,
      });
    } catch {
      return reply.type('text/html; charset=utf-8').send(
        `<h1>${status}</h1><p>${msg}</p><p><a href="/dashboard">返回首页</a></p>`
      );
    }
  };

  app.setErrorHandler((error, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) {
      app.log.error({ err: error, url: request.raw.url }, '请求处理失败');
    }
    const msg = messageFor(status, error);
    if (request.headers['hx-request']) {
      // HTMX 请求：保持状态码语义，由前端 app.js 读 X-WRA-Error（URL 编码防非法头字符）弹 Toast
      reply.code(status).header('X-WRA-Error', encodeURIComponent(msg));
      return reply.send('');
    }
    // 浏览器导航请求（Accept 含 text/html）→ 友好错误页；其余（API/下载等）→ JSON
    const accept = String(request.headers.accept || '');
    if (accept.includes('text/html')) {
      return sendErrorPage(reply, request, status, msg);
    }
    return reply.code(status).send({ error: msg });
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.headers['hx-request']) {
      reply.code(404).header('X-WRA-Error', encodeURIComponent('页面不存在'));
      return reply.send('');
    }
    const accept = String(request.headers.accept || '');
    if (accept.includes('text/html')) {
      return sendErrorPage(reply, request, 404, `路径 ${request.raw.url} 不存在`);
    }
    return reply.code(404).send({ error: 'Not Found' });
  });

  // ---- 路由 ----
  await app.register(authRoutes);
  await app.register(pageRoutes);
  await app.register(dashboardRoutes);
  await app.register(consoleRoutes);
  await app.register(filesRoutes);
  await app.register(editorRoutes);
  await app.register(logsRoutes);
  await app.register(settingsRoutes);
  await app.register(servicesRoutes);

  return app;
}

module.exports = { buildApp };
