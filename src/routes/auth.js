'use strict';

// 认证路由：GET/POST /login、POST /logout
// 登录成功/失败均返回 200（HTMX 用 HX-Redirect / 错误框片段），整页表单用 303 重定向
const path = require('node:path');
const entitlement = require('../services/entitlement');
const tpam = require('../services/tpam');
const audit = require('../hooks/audit');

const dataDir = path.join(__dirname, '../../data');

// 登录失败：HTMX 返回错误框片段；整页回显登录页 + 内联错误
function loginFail(request, reply, message) {
  audit(request, '登录失败', { targetUser: request.body && request.body.username });
  if (request.headers['hx-request']) {
    return reply.view('partials/login-alert', { message });
  }
  return reply.renderPage('pages/login', { title: request.t('login.title'), error: message });
}

module.exports = async function authRoutes(app) {
  // 登录页
  app.get('/login', { config: { public: true } }, async (request, reply) => {
    if (request.session.get('username')) return reply.redirect('/dashboard', 303);
    return reply.renderPage('pages/login', { title: request.t('login.title') });
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
    // self-TPAM 临时账号（*_tpam）：走 tpam 校验（4h 有效期，过期即登录被拒）
    if (/^[\w-]*_tpam$/.test(username)) {
      if (!tpam.verify(dataDir, username, password)) {
        return loginFail(request, reply, '临时账号无效或已过期（有效期 4 小时），请联系管理员重新获取');
      }
    } else if (!entitlement.verify(dataDir, username, password)) {
      return loginFail(request, reply, '用户名或密码错误');
    }

    // 写入会话（role：admin / readonly，只读账号禁用全部写操作；TPAM 临时账号恒为 admin）
    request.session.set('username', username);
    request.session.set('role', /^[\w-]*_tpam$/.test(username) ? 'admin' : (entitlement.roleOf(dataDir, username) || 'admin'));
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
