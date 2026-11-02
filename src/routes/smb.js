'use strict';

// SMB 共享管理路由：三 Tab 浏览（全员）+ 新建/取消共享/权限编辑/断会话/关文件（admin + 确认框 + 审计）
// 动态值（共享名/路径/FileId/账户列表）经 spawn env 注入，绝不拼接进命令串
const smb = require('../services/smb');
const audit = require('../hooks/audit');

function role(request) {
  return (request.session && request.session.get('role')) || 'admin';
}

function bad(t, key) {
  return Object.assign(new Error(t(key)), { statusCode: 400 });
}

// 字段读取：支持 multipart（前端 FormData，@fastify/multipart 默认不填充 request.body，需手动流式收集）
// 与 urlencoded（冒烟/脚本）两种形态；access 以重复键多次出现，每个值为 JSON 字符串
async function readFields(request) {
  const ct = String(request.headers['content-type'] || '');
  if (!ct.includes('multipart/form-data')) {
    const b = request.body || {};
    return { ...b, access: b.access === undefined ? [] : (Array.isArray(b.access) ? b.access : [b.access]) };
  }
  const body = {};
  for await (const part of request.parts()) {
    if (part.type === 'file') { part.file.resume(); continue; } // 不接收文件字段
    if (part.fieldname === 'access') (body.access = body.access || []).push(part.value);
    else body[part.fieldname] = part.value;
  }
  if (!body.access) body.access = [];
  return body;
}

// access 条目解析与校验：[{account, right}]，非法直接 400
function parseAccessItems(request, raw) {
  const out = [];
  for (const item of raw) {
    let a;
    try { a = typeof item === 'string' ? JSON.parse(item) : item; } catch { throw bad(request.t, 'smb.invalidAccess'); }
    const account = String((a || {}).account || '').trim();
    const right = String((a || {}).right || '');
    if (!smb.ACCOUNT_RE.test(account) || !smb.RIGHTS.includes(right)) throw bad(request.t, 'smb.invalidAccess');
    out.push({ account, right });
  }
  return out;
}

// LanmanServer 未运行等场景：列表失败降级为空列表 + 提示，避免整页 500
async function safeList(fn, t) {
  try {
    return { items: await fn(), err: null };
  } catch (e) {
    const msg = String(e.message || '');
    const down = /LanmanServer|Server 服务|Get-SmbShare|Get-SmbSession|Get-SmbOpenFile|无法识别|not recognized/i.test(msg);
    return { items: [], err: down ? t('smb.svcDown') : msg.slice(0, 200) };
  }
}

// Tab 片段渲染（页面 / 切换 / 操作后刷新共用）
async function renderTab(reply, request, tab, kw, msg) {
  const k = String(kw || '').trim().toLowerCase();
  let items = [];
  let listErr = null;
  if (tab === 'shares') {
    const r = await safeList(() => smb.listShares(request.t), request.t);
    items = r.items;
    listErr = r.err;
    if (k) items = items.filter((i) => `${i.name} ${i.path} ${i.desc}`.toLowerCase().includes(k));
    // 「仅看 Everyone 暴露」筛选（安全检测开关）
    if (String(request.query.everyone || '') === '1') items = items.filter((i) => i.everyone);
  } else if (tab === 'sessions') {
    const r = await safeList(() => smb.listSessions(request.t), request.t);
    items = r.items;
    listErr = r.err;
    if (k) items = items.filter((i) => `${i.client} ${i.user}`.toLowerCase().includes(k));
  } else {
    const r = await safeList(() => smb.listOpenFiles(request.t), request.t);
    items = r.items;
    listErr = r.err;
    if (k) items = items.filter((i) => `${i.path} ${i.user} ${i.client}`.toLowerCase().includes(k));
  }
  return reply.view(`partials/smb-${tab}`, {
    items,
    listErr,
    total: items.length,
    tab,
    kw: String(kw || ''),
    t: request.t,
    role: role(request),
    msg: msg || null,
  });
}

module.exports = async function smbRoutes(app) {
  // 整页：默认共享 Tab
  app.get('/smb', async (request, reply) => {
    const tab = smb.TABS.has(String(request.query.tab)) ? String(request.query.tab) : 'shares';
    const k = String(request.query.kw || '').trim().toLowerCase();
    const shares = tab === 'shares'
      ? await safeList(() => smb.listShares(request.t), request.t) : { items: [], err: null };
    const sharesFiltered = k ? shares.items.filter((i) => `${i.name} ${i.path} ${i.desc}`.toLowerCase().includes(k)) : shares.items;
    const everyoneOnly = String(request.query.everyone || '') === '1';
    return reply.renderPage('pages/smb', {
      title: request.t('smb.title'),
      active: 'smb',
      tab,
      kw: String(request.query.kw || ''),
      everyoneOnly,
      items: everyoneOnly ? sharesFiltered.filter((i) => i.everyone) : sharesFiltered,
      total: everyoneOnly ? sharesFiltered.filter((i) => i.everyone).length : sharesFiltered.length,
      listErr: tab === 'shares' ? shares.err : null,
      role: role(request),
      msg: null,
    });
  });

  // Tab 切换 / 搜索 / 操作后刷新（partial）
  app.get('/smb/list/:tab', async (request, reply) => {
    const tab = smb.TABS.has(String(request.params.tab)) ? String(request.params.tab) : 'shares';
    return renderTab(reply, request, tab, request.query.kw, null);
  });

  // 新建共享（含权限模板：Full 固定行 + Read/Change 行编辑）
  app.post('/smb/share/create', async (request, reply) => {
    app.assertWritable(request);
    const body = await readFields(request);
    const name = String(body.name || '').trim();
    const sharePath = String(body.path || '').trim();
    const desc = String(body.desc || '').trim();
    const access = parseAccessItems(request, body.access);
    if (!access.length) throw bad(request.t, 'smb.invalidAccess');
    if (!smb.SHARE_NAME_RE.test(name) || smb.isManagedShare(name)) throw bad(request.t, 'smb.invalidName');
    if (!smb.SHARE_PATH_RE.test(sharePath)) throw bad(request.t, 'smb.invalidPath');
    const full = access.filter((a) => a.right === 'Full').map((a) => a.account);
    const change = access.filter((a) => a.right === 'Change').map((a) => a.account);
    const read = access.filter((a) => a.right === 'Read').map((a) => a.account);
    const r = await smb.createShare(name, sharePath, desc, read, change, full, request.t);
    audit(request, '新建SMB共享', { name, path: sharePath, read, change, full, ok: r.ok });
    if (!r.ok) {
      reply.header('HX-Trigger', JSON.stringify({ toast: { message: 'enc:' + encodeURIComponent(r.error), type: 'warning' } }));
      return renderTab(reply, request, 'shares', body.kw, r.error);
    }
    reply.header('HX-Trigger', JSON.stringify({ toast: { message: 'enc:' + encodeURIComponent(request.t('smb.shareCreated').replace('{n}', name)), type: 'success' } }));
    return renderTab(reply, request, 'shares', body.kw, null);
  });

  // 取消共享（管理共享双重拦截）
  app.post('/smb/share/remove', async (request, reply) => {
    app.assertWritable(request);
    const body = request.body || {};
    const name = String(body.name || '').trim();
    if (!smb.SHARE_NAME_RE.test(name)) throw bad(request.t, 'smb.invalidName');
    if (smb.isManagedShare(name)) throw bad(request.t, 'smb.managedProtected');
    const r = await smb.removeShare(name, request.t);
    audit(request, '取消SMB共享', { name, ok: r.ok });
    if (!r.ok) {
      reply.header('HX-Trigger', JSON.stringify({ toast: { message: 'enc:' + encodeURIComponent(r.error), type: 'warning' } }));
      return renderTab(reply, request, 'shares', body.kw, r.error);
    }
    reply.header('HX-Trigger', JSON.stringify({ toast: { message: 'enc:' + encodeURIComponent(request.t('smb.shareRemoved').replace('{n}', name)), type: 'success' } }));
    return renderTab(reply, request, 'shares', body.kw, null);
  });

  // 权限编辑（diff：不中断现有连接；Full 保留行由服务端按现状合并，防误降权）
  app.post('/smb/share/access', async (request, reply) => {
    app.assertWritable(request);
    const body = await readFields(request);
    const name = String(body.name || '').trim();
    const desired = parseAccessItems(request, body.access);
    if (!smb.SHARE_NAME_RE.test(name)) throw bad(request.t, 'smb.invalidName');
    // 现状以服务端列表为准（防并发过期）
    const shares = await smb.listShares(request.t);
    const cur = shares.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!cur) throw bad(request.t, 'smb.shareNotFound');
    const current = smb.parseAccess(cur.access);
    // 既有 Full 权限强制保留（编辑器锁定行可能与现状漂移，服务端兜底）
    current.filter((a) => a.right === 'Full').forEach((a) => {
      if (!desired.some((d) => d.account.toLowerCase() === a.account.toLowerCase())) {
        desired.push({ account: a.account, right: 'Full' });
      } else {
        desired.find((d) => d.account.toLowerCase() === a.account.toLowerCase()).right = 'Full';
      }
    });
    const { revoke, grant } = smb.accessDiff(current, desired);
    if (!revoke.length && !grant.length) {
      return renderTab(reply, request, 'shares', body.kw, null);
    }
    const r = await smb.editAccess(name, revoke, grant, request.t);
    audit(request, '编辑SMB共享权限', { name, revoke, grant, ok: r.ok });
    if (!r.ok) {
      reply.header('HX-Trigger', JSON.stringify({ toast: { message: 'enc:' + encodeURIComponent(r.error), type: 'warning' } }));
      return renderTab(reply, request, 'shares', body.kw, r.error);
    }
    reply.header('HX-Trigger', JSON.stringify({ toast: { message: 'enc:' + encodeURIComponent(request.t('smb.accessUpdated').replace('{n}', name)), type: 'success' } }));
    return renderTab(reply, request, 'shares', body.kw, null);
  });

  // 断开会话
  app.post('/smb/session/close', async (request, reply) => {
    app.assertWritable(request);
    const body = request.body || {};
    const id = String(body.id || '').trim();
    if (!/^\d+$/.test(id)) throw bad(request.t, 'smb.invalidId');
    const r = await smb.closeSession(id, request.t);
    audit(request, '断开SMB会话', { id, user: body.user || null, ok: r.ok });
    const toast = 'enc:' + encodeURIComponent(r.ok
      ? request.t('smb.sessionClosed').replace('{n}', String(body.user || id))
      : request.t('smb.actionFailed').replace('{n}', r.error || ''));
    reply.header('HX-Trigger', JSON.stringify({ toast: { message: toast, type: r.ok ? 'success' : 'warning' } }));
    return renderTab(reply, request, 'sessions', body.kw, r.ok ? null : r.error);
  });

  // 关闭打开的文件
  app.post('/smb/file/close', async (request, reply) => {
    app.assertWritable(request);
    const body = request.body || {};
    const id = String(body.id || '').trim();
    if (!/^\d+$/.test(id)) throw bad(request.t, 'smb.invalidId');
    const r = await smb.closeOpenFile(id, request.t);
    audit(request, '关闭SMB打开文件', { id, path: body.path || null, ok: r.ok });
    const toast = 'enc:' + encodeURIComponent(r.ok
      ? request.t('smb.fileClosed').replace('{n}', String(body.path || id)).slice(0, 120)
      : request.t('smb.actionFailed').replace('{n}', r.error || ''));
    reply.header('HX-Trigger', JSON.stringify({ toast: { message: toast, type: r.ok ? 'success' : 'warning' } }));
    return renderTab(reply, request, 'openfiles', body.kw, r.ok ? null : r.error);
  });
};
