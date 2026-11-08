'use strict';

// self-TPAM 路由：临时特权账号（release 场景）生成 / 吊销 / 列表
// - 生成与吊销 admin 专属 + 审计；明文密码仅在生成响应中展示一次，绝不落日志与审计
const tpam = require('../services/tpam');
const audit = require('../hooks/audit');
const path = require('node:path');

const dataDir = path.join(__dirname, '../../data');

function role(request) {
  return (request.session && request.session.get('role')) || 'admin';
}

function forbid(request) {
  throw Object.assign(new Error(request.t('error.forbidden')), { statusCode: 403 });
}

function bad(t, key) {
  return Object.assign(new Error(t(key)), { statusCode: 400 });
}

function toastHeader(reply, message, type) {
  reply.header('HX-Trigger', JSON.stringify({ toast: { message: 'enc:' + encodeURIComponent(message), type } }));
}

function pad(n) { return String(n).padStart(2, '0'); }

function fmtTime(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtRemaining(ms) {
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m % 60}m`;
}

function decorate(items) {
  return items.map((it) => Object.assign({}, it, {
    createdAtStr: fmtTime(it.createdAt),
    expiresAtStr: fmtTime(it.expiresAt),
    remainingStr: fmtRemaining(it.remainingMs),
  }));
}

// 列表 partial（页面 / 生成 / 吊销后刷新共用）；cred 仅生成响应携带（一次性展示）
function renderList(reply, request, cred) {
  return reply.view('partials/tpam-list', {
    items: decorate(tpam.list(dataDir)),
    isAdmin: role(request) === 'admin',
    cred: cred || null,
  });
}

module.exports = async function tpamRoutes(app) {
  // 整页（readonly 可查看列表，无生成 / 吊销入口）
  app.get('/tpam', async (request, reply) => {
    return reply.renderPage('pages/tpam', {
      title: request.t('tpam.title'),
      active: 'tpam',
      isAdmin: role(request) === 'admin',
      items: decorate(tpam.list(dataDir)),
      cred: null,
    });
  });

  // 生成（admin；同名覆盖 = 续期换密码，TTL 重置）
  app.post('/tpam/generate', async (request, reply) => {
    if (role(request) !== 'admin') forbid(request);
    const t = request.t;
    const b = request.body || {};
    const staffId = String(b.staffId || '').trim();
    const crIn = String(b.crIn || '').trim();
    if (!tpam.isValidStaff(staffId)) throw bad(t, 'tpam.invalidStaff');
    if (!tpam.isValidCrIn(crIn)) throw bad(t, 'tpam.invalidCrIn');
    const r = tpam.generate(dataDir, staffId, crIn);
    // 审计不记录密码
    audit(request, '生成 TPAM 临时账号', { targetUser: r.username, crIn, expiresAt: new Date(r.expiresAt).toISOString() });
    toastHeader(reply, t('tpam.doneGenerate').replace('{n}', r.username), 'success');
    const it = decorate([r])[0];
    return renderList(reply, request, { username: it.username, password: r.password, expiresAtStr: it.expiresAtStr });
  });

  // 吊销（admin；已过期 / 不存在时提示而非报错）
  app.post('/tpam/revoke', async (request, reply) => {
    if (role(request) !== 'admin') forbid(request);
    const t = request.t;
    const username = String((request.body || {}).username || '').trim();
    if (!/^[\w-]*_tpam$/.test(username)) throw bad(t, 'tpam.invalidUser');
    const ok = tpam.revoke(dataDir, username);
    if (!ok) {
      toastHeader(reply, t('tpam.alreadyGone'), 'info');
    } else {
      audit(request, '吊销 TPAM 临时账号', { targetUser: username });
      toastHeader(reply, t('tpam.revokeOk').replace('{n}', username), 'success');
    }
    return renderList(reply, request);
  });
};
