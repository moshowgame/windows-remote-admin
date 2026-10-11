'use strict';

// 认证路由：GET/POST /login、POST /logout
// 登录成功/失败均返回 200（HTMX 用 HX-Redirect / 错误框片段），整页表单用 303 重定向
const path = require('node:path');
const entitlement = require('../services/entitlement');
const audit = require('../hooks/audit');

const dataDir = path.join(__dirname, '../../data');

// 登录失败：HTMX 返回错误框片段；整页回显登录页 + 内联错误
function loginFail(request, reply, message) {
  audit(request, '登录失败', { targetUser: request.body && request.body.username });
  if (request.headers['hx-request']) {
    return reply.view('partials/login-alert', { message });
  }
  return reply.renderPage('pages/login', { title: '登录', error: message });
}

module.exports = async function authRoutes(app) {
  // 登录页
  app.get('/login', { config: { public: true } }, async (request, reply) => {
    if (request.session.get('username')) return reply.redirect('/dashboard', 303);
    return reply.renderPage('pages/login', { title: '登录' });
  });

  // 登录提交：每 IP 每分钟 5 次
  app.post('/login', {
    config: {
      public: true,
      rateLimit: { max: 5, timeWindow: '1 minute' },
    },
  }, async (request, reply) => {
    const { username = '', password = '', purpose = '' } = request.body || {};
    if (!username || !password) {
      return loginFail(request, reply, '请输入用户名和密码');
    }
    if (!entitlement.verify(dataDir, username, password)) {
      return loginFail(request, reply, '用户名或密码错误');
    }

    // 写入会话
    request.session.set('username', username);
    request.session.set('purpose', purpose);
    request.session.set('loginAt', Date.now());
    request.session.set('ip', request.ip);
    audit(request, '登录成功', { purpose, targetUser: username });

    if (request.headers['hx-request']) {
      reply.header('HX-Redirect', '/dashboard');
      return reply.code(200).send('');
    }
    return reply.redirect('/dashboard', 303);
  });

  // 登出
  app.post('/logout', async (request, reply) => {
    const username = request.session.get('username');
    request.session.delete();
    if (username) audit(request, '登出', { targetUser: username });
    if (request.headers['hx-request']) {
      reply.header('HX-Redirect', '/login');
      return reply.code(200).send('');
    }
    return reply.redirect('/login', 303);
  });
};
