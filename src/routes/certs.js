'use strict';

// 证书路由：LocalMachine 常用存储区浏览 / 详情（全员只读）+ 导出 / 删除（admin + 审计）
const certs = require('../services/certs');
const audit = require('../hooks/audit');

function role(request) {
  return (request.session && request.session.get('role')) || 'admin';
}
function safeStore(raw) {
  return certs.STORES.has(String(raw)) ? String(raw) : 'My';
}

// 状态归类：expired / soon(30天内) / ok
function certState(c) {
  const na = new Date(c.na).getTime();
  const diff = na - Date.now();
  if (diff <= 0) return 'expired';
  if (diff <= 30 * 24 * 3600 * 1000) return 'soon';
  return 'ok';
}

// 列表片段渲染（页面 / 筛选 / 删除后刷新共用）
async function renderList(reply, request, store, kw, state, msg) {
  const items = await certs.listCerts(store, request.server.config.psTimeoutMs, request.t);
  const k = String(kw || '').trim().toLowerCase();
  let filtered = items;
  if (state && ['expired', 'soon', 'ok'].includes(state)) filtered = filtered.filter((c) => certState(c) === state);
  if (k) {
    filtered = filtered.filter((c) => `${c.subj} ${c.iss} ${c.san || ''} ${c.tp}`.toLowerCase().includes(k));
  }
  return reply.view('partials/certs-list', {
    items: filtered,
    total: items.length,
    store,
    kw: String(kw || ''),
    state: state || '',
    certState,
    t: request.t,
    role: role(request),
    msg: msg || null,
  });
}

module.exports = async function certRoutes(app) {
  // 整页：默认 My 存储区
  app.get('/certs', async (request, reply) => {
    const store = safeStore(request.query.store);
    const items = await certs.listCerts(store, app.config.psTimeoutMs, request.t);
    const k = String(request.query.kw || '').trim().toLowerCase();
    const state = ['expired', 'soon', 'ok'].includes(String(request.query.state)) ? String(request.query.state) : '';
    let filtered = state ? items.filter((c) => certState(c) === state) : items;
    if (k) filtered = filtered.filter((c) => `${c.subj} ${c.iss} ${c.san || ''} ${c.tp}`.toLowerCase().includes(k));
    return reply.renderPage('pages/certs', {
      title: request.t('certs.title'),
      active: 'certs',
      items: filtered,
      total: items.length,
      store,
      kw: String(request.query.kw || ''),
      state,
      certState,
      role: role(request),
      msg: null,
    });
  });

  // 列表片段（切存储区 / 筛选 / 操作后刷新）
  app.get('/certs/list', async (request, reply) => {
    return renderList(reply, request, safeStore(request.query.store), request.query.kw, request.query.state, null);
  });

  // 详情 modal 片段
  app.get('/certs/detail', async (request, reply) => {
    const store = safeStore(request.query.store);
    const tp = String(request.query.tp || '');
    const c = await certs.getCert(store, tp, app.config.psTimeoutMs, request.t);
    if (!c) throw Object.assign(new Error(request.t('certs.notFound')), { statusCode: 404 });
    return reply.view('partials/certs-detail', { c, store, certState, t: request.t, role: role(request) });
  });

  // 导出 .cer（DER 公钥）/ .pem（PEM 公钥文本），直接下载
  app.get('/certs/export/:kind(cer|pem)', async (request, reply) => {
    if (role(request) !== 'admin') throw Object.assign(new Error(request.t('common.forbidden')), { statusCode: 403 });
    const kind = request.params.kind;
    const store = safeStore(request.query.store);
    const tp = String(request.query.tp || '');
    const { buf } = await certs.exportCert(store, tp, kind, request.t);
    audit(request, '证书导出', { store, tp, kind });
    reply.header('Content-Type', kind === 'pem' ? 'application/x-pem-file' : 'application/x-x509-ca-cert');
    reply.header('Content-Disposition', `attachment; filename="cert-${tp.slice(0, 8)}.${kind}"`);
    return reply.send(buf);
  });

  // 申请 .pfx 导出：返回一次性下载 token + 随机密码（密码仅此一次展示，不落日志不落审计）
  app.get('/certs/export/pfx-token', async (request, reply) => {
    if (role(request) !== 'admin') throw Object.assign(new Error(request.t('common.forbidden')), { statusCode: 403 });
    const store = safeStore(request.query.store);
    const tp = String(request.query.tp || '');
    // 预检：证书存在且有私钥（导出动作本身在下载接口执行并审计）
    const c = await certs.getCert(store, tp, app.config.psTimeoutMs, request.t);
    if (!c) throw Object.assign(new Error(request.t('certs.notFound')), { statusCode: 404 });
    if (!c.pk) throw Object.assign(new Error(request.t('certs.noPrivateKey')), { statusCode: 400 });
    return reply.view('partials/certs-pfx', {
      token: certs.issuePfxToken(store, tp),
      tp,
      store,
      t: request.t,
    });
  });

  // 下载 .pfx（凭一次性 token；这里才真正执行导出 + 审计）
  app.get('/certs/export/pfx', async (request, reply) => {
    if (role(request) !== 'admin') throw Object.assign(new Error(request.t('common.forbidden')), { statusCode: 403 });
    const v = certs.takePfxToken(String(request.query.token || ''));
    if (!v) throw Object.assign(new Error(request.t('certs.tokenInvalid')), { statusCode: 400 });
    const { buf, pwd } = await certs.exportCert(v.store, v.thumbprint, 'pfx', request.t);
    audit(request, '证书导出', { store: v.store, tp: v.thumbprint, kind: 'pfx' });
    reply.header('Content-Type', 'application/x-pkcs12');
    reply.header('Content-Disposition', `attachment; filename="cert-${v.thumbprint.slice(0, 8)}.pfx"`);
    if (pwd) reply.header('X-Cert-Pwd', pwd);
    return reply.send(buf);
  });

  // 导入证书（multipart：file + store + pwd；cer/crt/pem 公钥免密码，pfx/p12 需导入密码）
  app.post('/certs/import', async (request, reply) => {
    if (role(request) !== 'admin') throw Object.assign(new Error(request.t('common.forbidden')), { statusCode: 403 });
    let store = 'My';
    let pwd = '';
    let fileBuf = null;
    let fname = '';
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        fname = String(part.filename || '');
        fileBuf = await part.toBuffer();
      } else if (part.fieldname === 'store') {
        store = String(part.value || 'My');
      } else if (part.fieldname === 'pwd') {
        pwd = String(part.value || '');
      }
    }
    let r;
    try {
      r = await certs.importCert(store, fileBuf, fname, pwd, request.t);
    } catch (err) {
      r = { ok: false, error: err.message };
    }
    audit(request, '证书导入', { store, file: fname, tp: r.tp || null, ok: !!r.ok });
    if (!r.ok) return { ok: false, msg: r.error || request.t('certs.actionFailed').replace('{n}', '') };
    const toast = 'enc:' + encodeURIComponent(request.t('certs.imported').replace('{n}', (r.tp || '').slice(0, 8)));
    reply.header('HX-Trigger', JSON.stringify({ toast: { message: toast, type: 'success' } }));
    return { ok: true, tp: r.tp, subj: r.subj };
  });

  // 删除证书（admin + 确认框 + 审计）
  app.post('/certs/delete', async (request, reply) => {
    app.assertWritable(request);
    const body = request.body || {};
    const store = safeStore(body.store);
    const tp = String(body.tp || '');
    const r = await certs.deleteCert(store, tp, request.t);
    audit(request, '证书删除', { store, tp, ok: r.ok });
    const toast = 'enc:' + encodeURIComponent(r.ok
      ? request.t('certs.deleted').replace('{n}', tp)
      : request.t('certs.actionFailed').replace('{n}', r.error || ''));
    reply.header('HX-Trigger', JSON.stringify({ toast: { message: toast, type: r.ok ? 'success' : 'warning' } }));
    return renderList(reply, request, store, body.kw, body.state, r.ok ? null : r.error);
  });
};
