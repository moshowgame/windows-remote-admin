'use strict';

// 环境变量路由：Machine / User 查看（全员）+ 增改删（admin，确认框 + 审计）
// 敏感值（名称含 password/token/key 等）默认打码，查看原值独立接口 + 审计
const env = require('../services/envvars');
const audit = require('../hooks/audit');

function role(request) {
  return (request.session && request.session.get('role')) || 'admin';
}

// 列表片段渲染（页面 / 保存 / 删除 / 刷新共用）
async function renderList(reply, request, scope, kw, msg) {
  const items = await env.listEnv(scope, request.server.config.psTimeoutMs, request.t);
  const k = String(kw || '').trim().toLowerCase();
  const filtered = k ? items.filter((i) => i.name.toLowerCase().includes(k)) : items;
  return reply.view('partials/env-list', {
    items: filtered,
    total: items.length,
    scope,
    kw: String(kw || ''),
    t: request.t,
    role: role(request),
    msg: msg || null,
  });
}

module.exports = async function envRoutes(app) {
  // 整页：默认 Machine
  app.get('/env', async (request, reply) => {
    const scope = env.SCOPES.has(String(request.query.scope)) ? String(request.query.scope) : 'Machine';
    const items = await env.listEnv(scope, app.config.psTimeoutMs, request.t);
    const k = String(request.query.kw || '').trim().toLowerCase();
    return reply.renderPage('pages/env', {
      title: request.t('env.title'),
      active: 'env',
      items: k ? items.filter((i) => i.name.toLowerCase().includes(k)) : items,
      total: items.length,
      scope,
      kw: String(request.query.kw || ''),
      role: role(request),
      msg: null,
    });
  });

  // 列表片段（切作用域 / 搜索 / 操作后刷新）
  app.get('/env/list', async (request, reply) => {
    const scope = env.SCOPES.has(String(request.query.scope)) ? String(request.query.scope) : 'Machine';
    return renderList(reply, request, scope, request.query.kw, null);
  });

  // 保存（新增/修改）
  app.post('/env/save', async (request, reply) => {
    app.assertWritable(request);
    const body = request.body || {};
    const scope = env.SCOPES.has(String(body.scope)) ? String(body.scope) : 'Machine';
    const name = String(body.name || '').trim();
    const value = String(body.value == null ? '' : body.value);
    if (!env.NAME_RE.test(name)) throw Object.assign(new Error(request.t('env.invalidName')), { statusCode: 400 });
    if (!value || value.length > env.MAX_VALUE_LEN) {
      throw Object.assign(new Error(request.t('env.invalidValue').replace('{n}', String(env.MAX_VALUE_LEN))), { statusCode: 400 });
    }
    const r = await env.setEnv(name, value, scope, request.t);
    audit(request, '环境变量保存', { scope, name, valueLen: value.length, ok: r.ok });
    const toast = 'enc:' + encodeURIComponent(r.ok
      ? request.t('env.saved').replace('{n}', name)
      : request.t('env.actionFailed').replace('{n}', r.error || ''));
    reply.header('HX-Trigger', JSON.stringify({ toast: { message: toast, type: r.ok ? 'success' : 'warning' } }));
    return renderList(reply, request, scope, body.kw, r.ok ? null : r.error);
  });

  // 删除（系统关键变量前后端双重拦截）
  app.post('/env/delete', async (request, reply) => {
    app.assertWritable(request);
    const body = request.body || {};
    const scope = env.SCOPES.has(String(body.scope)) ? String(body.scope) : 'Machine';
    const name = String(body.name || '').trim();
    if (!env.NAME_RE.test(name)) throw Object.assign(new Error(request.t('env.invalidName')), { statusCode: 400 });
    if (env.isCritical(name)) throw Object.assign(new Error(request.t('env.criticalProtected')), { statusCode: 400 });
    const r = await env.deleteEnv(name, scope, request.t);
    audit(request, '环境变量删除', { scope, name, ok: r.ok });
    const toast = 'enc:' + encodeURIComponent(r.ok
      ? request.t('env.deleted').replace('{n}', name)
      : request.t('env.actionFailed').replace('{n}', r.error || ''));
    reply.header('HX-Trigger', JSON.stringify({ toast: { message: toast, type: r.ok ? 'success' : 'warning' } }));
    return renderList(reply, request, scope, body.kw, r.ok ? null : r.error);
  });

  // 查看敏感变量原值（admin + 审计）
  app.get('/env/reveal', async (request, reply) => {
    if (role(request) !== 'admin') {
      throw Object.assign(new Error(request.t('common.forbidden')), { statusCode: 403 });
    }
    const scope = env.SCOPES.has(String(request.query.scope)) ? String(request.query.scope) : 'Machine';
    const name = String(request.query.name || '').trim();
    if (!env.NAME_RE.test(name)) throw Object.assign(new Error(request.t('env.invalidName')), { statusCode: 400 });
    const r = await env.getEnv(name, scope, request.t);
    audit(request, '查看敏感环境变量', { scope, name });
    return { value: r.value };
  });
};
