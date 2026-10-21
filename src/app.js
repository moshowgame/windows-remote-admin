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
const i18n = require('./i18n');
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
const netRoutes = require('./routes/net');

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

  // 整页渲染辅助：自动注入 csrf / username / role / i18n
  app.decorateReply('renderPage', function renderPage(view, data = {}) {
    const csrf = this.generateCsrf();
    const username = this.request.session ? this.request.session.get('username') || '' : '';
    const role = this.request.session ? this.request.session.get('role') || 'admin' : 'admin';
    const t = i18n.of(this.request);
    return this.view(view, { ...data, csrf, username, role, t, lang: i18n.detect(this.request) });
  });

  // 写操作守卫：只读账号访问写路由直接 403（错误处理器统一转为 HTMX toast / 错误页）
  app.decorate('assertWritable', function assertWritable(request) {
    if (request.session && request.session.get('role') === 'readonly') {
      throw Object.assign(new Error(i18n.of(request)('common.readonlyDenied')), { statusCode: 403 });
    }
  });

  // ---- 插件 ----
  await app.register(require('@fastify/cookie'));
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

  // i18n：preHandler 阶段统一挂 request.t 并写入 reply.locals（partial 渲染也自动可用）
  app.addHook('preHandler', async (request, reply) => {
    request.t = i18n.of(request);
    reply.locals = { t: request.t, lang: i18n.detect(request) };
  });

  // ---- 错误处理 ----
  // 生成状态码对应的用户提示（500/403 不泄露内部细节）；固定文案走 i18n，业务动态消息原样返回
  const messageFor = (status, error, t) => {
    if (status === 400) return error && error.message ? error.message : t('error.badRequest');
    if (status === 413) return t('error.tooLarge');
    if (status === 429) return t('error.rateLimited');
    if (status === 403) return t('error.forbidden');
    return status >= 500 ? t('error.server') : t('error.generic');
  };
  // 浏览器整页请求渲染友好错误页；渲染失败兜底纯文本
  const sendErrorPage = (reply, request, status, msg) => {
    try {
      return reply.code(status).renderPage('pages/error', {
        title: `${i18n.of(request)('error.pageTitle')} ${status}`,
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
    const t = i18n.of(request);
    const msg = messageFor(status, error, t);
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
    const t = i18n.of(request);
    if (request.headers['hx-request']) {
      reply.code(404).header('X-WRA-Error', encodeURIComponent(t('error.notFound')));
      return reply.send('');
    }
    const accept = String(request.headers.accept || '');
    if (accept.includes('text/html')) {
      return sendErrorPage(reply, request, 404, t('error.notFoundDetail'));
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
  await app.register(netRoutes);

  return app;
}

module.exports = { buildApp };
