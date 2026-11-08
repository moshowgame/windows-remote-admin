'use strict';

// 认证路由：GET/POST /login、POST /logout
// 登录成功/失败均返回 200（HTMX 用 HX-Redirect / 错误框片段），整页表单用 303 重定向
// 认证方式（auth.mode）：local（默认）/ ldap / both（登录页提供方式选择器）
// LDAP 登录：staffid 经 LDAP/AD 校验 → data/auth-map.csv（或组映射）解析角色 → 未映射拒绝登录
const path = require('node:path');
const entitlement = require('../services/entitlement');
const tpam = require('../services/tpam');
const ldap = require('../services/ldap');
const audit = require('../hooks/audit');

const dataDir = path.join(__dirname, '../../data');

// 读取 auth.mode（缺省 local）
function authMode(app) {
  const a = app.config && app.config.auth;
  return a && (a.mode === 'ldap' || a.mode === 'both') ? a.mode : 'local';
}

// 登录失败：HTMX 返回错误框片段；整页回显登录页 + 内联错误
function loginFail(request, reply, message) {
  audit(request, '登录失败', { targetUser: request.body && request.body.username });
  if (request.headers['hx-request']) {
    return reply.view('partials/login-alert', { message });
  }
  return reply.renderPage('pages/login', { title: request.t('login.title'), error: message, authMode: authMode(request.server) });
}

// 写入会话并跳转（HTMX 用 HX-Redirect，整页 303）
function loginSuccess(request, reply, username, role, purpose, event) {
  request.session.set('username', username);
  request.session.set('role', role);
  request.session.set('purpose', purpose);
  request.session.set('loginAt', Date.now());
  request.session.set('ip', request.ip);
  audit(request, event, { purpose, targetUser: username });

  if (request.headers['hx-request']) {
    reply.header('HX-Redirect', '/dashboard');
    return reply.code(200).send('');
  }
  return reply.redirect('/dashboard', 303);
}

// 本地账号认证（entitlement.csv / self-TPAM 临时账号）
function verifyLocal(request, reply, username, password, purpose) {
  if (/^[\w-]*_tpam$/.test(username)) {
    // self-TPAM 临时账号（*_tpam）：走 tpam 校验（4h 有效期，过期即登录被拒）
    if (!tpam.verify(dataDir, username, password)) {
      return loginFail(request, reply, '临时账号无效或已过期（有效期 4 小时），请联系管理员重新获取');
    }
    return loginSuccess(request, reply, username, 'admin', purpose, '登录成功');
  }
  if (!entitlement.verify(dataDir, username, password)) {
    return loginFail(request, reply, '用户名或密码错误');
  }
  return loginSuccess(request, reply, username, entitlement.roleOf(dataDir, username) || 'admin', purpose, '登录成功');
}

// LDAP/AD 认证：staffid 校验 → 角色映射（未映射拒绝）→ 服务不可达时按配置回退本地
async function verifyLdap(request, reply, username, password, purpose, ldapCfg) {
  const result = await ldap.authenticate(ldapCfg, username, password);

  if (result.status === ldap.OK) {
    const role = ldap.mapRole(dataDir, username, result.groups, ldapCfg.groupRoleMap);
    if (!role) {
      // 默认拒绝：staffid / 组均未映射，不允许登录
      audit(request, 'LDAP 映射拒绝', { targetUser: username });
      return loginFail(request, reply, '账号未经授权（staffid 未映射任何角色），请联系管理员配置 data/auth-map.csv');
    }
    return loginSuccess(request, reply, username, role, purpose, '登录成功(LDAP)');
  }

  if (result.status === ldap.BAD_CREDENTIALS) {
    // 49 / 密码为空：凭据错误，直接拒绝且绝不兜底
    return loginFail(request, reply, 'LDAP 用户名或密码错误');
  }
  if (result.status === ldap.DENIED) {
    return loginFail(request, reply, `LDAP 认证被拒绝（错误码 ${result.errorCode}），请联系管理员`);
  }

  // 不可达（81 类）：按 allowLocalFallback 决定是否回退本地 entitlement 账号
  if (ldapCfg.allowLocalFallback !== false) {
    if (entitlement.verify(dataDir, username, password)) {
      const role = entitlement.roleOf(dataDir, username) || 'admin';
      return loginSuccess(request, reply, username, role, purpose, '登录成功(LDAP 回退)');
    }
    return loginFail(request, reply, 'LDAP 服务不可用，且本地账号校验失败');
  }
  return loginFail(request, reply, 'LDAP 服务暂不可用，请稍后再试');
}

module.exports = async function authRoutes(app) {
  // 登录页
  app.get('/login', { config: { public: true } }, async (request, reply) => {
    if (request.session.get('username')) return reply.redirect('/dashboard', 303);
    return reply.renderPage('pages/login', { title: request.t('login.title'), authMode: authMode(app) });
  });

  // 登录提交：每 IP 每分钟 5 次
  app.post('/login', {
    config: {
      public: true,
      rateLimit: { max: 5, timeWindow: '1 minute' },
    },
  }, async (request, reply) => {
    const { username = '', password = '', purpose = '', method = '' } = request.body || {};
    if (!username || !password) {
      return loginFail(request, reply, '请输入用户名和密码');
    }
    if (!/^[\w.@-]{1,64}$/.test(username)) {
      return loginFail(request, reply, '用户名包含不支持的字符');
    }

    const mode = authMode(app);
    const ldapCfg = (app.config.auth && app.config.auth.ldap) || {};
    // both 模式按用户选择分流（非法值回退 local）；单一模式强制对应方式
    const effective = mode === 'both' ? (method === 'ldap' ? 'ldap' : 'local') : mode;

    if (effective === 'ldap') {
      return verifyLdap(request, reply, username, password, purpose, ldapCfg);
    }
    return verifyLocal(request, reply, username, password, purpose);
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
