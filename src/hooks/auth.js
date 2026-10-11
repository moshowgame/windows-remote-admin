'use strict';

// 认证钩子（受保护路由 preHandler）：
// - 已登录：放行
// - 未登录整页请求：302 → /login
// - 未登录 HTMX 片段请求：401 + HX-Redirect: /login（HTMX 自动整页跳转）
// - 未授权访问记入审计
const audit = require('./audit');

module.exports = async function authenticate(request, reply) {
  // 公开路由（登录页等）直接放行
  if (request.routeOptions.config && request.routeOptions.config.public) return;
  // 静态资源（Tabler/HTMX/图标）公开放行
  if (request.raw.url && request.raw.url.startsWith('/static/')) return;

  const username = request.session && request.session.get('username');
  if (username) return;

  audit(request, '未授权拦截', { url: request.raw.url });

  // SSE 连接（EventSource）无法处理 302/HX-Redirect：直接 401 结束，让前端静默断开
  if ((request.headers.accept || '').includes('text/event-stream')) {
    reply.code(401);
    return reply.send('');
  }

  if (request.headers['hx-request']) {
    reply.code(401).header('HX-Redirect', '/login');
    return reply.send('');
  }
  return reply.redirect('/login', 302);
};
