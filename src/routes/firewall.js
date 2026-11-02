'use strict';

// Windows 防火墙路由：配置文件状态 + 规则浏览（全员）与启停/新建/删除、配置文件开关（admin + 确认框 + 审计）
// 动态值（规则 ID/名称/端口/描述）经 spawn env 注入，绝不拼接进命令串
const fw = require('../services/firewall');
const audit = require('../hooks/audit');

// 单页上限：规则动辄 400+，超出部分 footer 提示
const CAP = 300;

function role(request) {
  return (request.session && request.session.get('role')) || 'admin';
}

function bad(t, key) {
  return Object.assign(new Error(t(key)), { statusCode: 400 });
}

// 筛选参数归一（白名单外一律视为全部）；GET 取 query、POST 取 body（操作后回渲染需带上当前筛选）
function filters(request) {
  const q = request.query || {};
  const b = request.body || {};
  const get = (k) => (q[k] !== undefined && q[k] !== null ? q[k] : b[k]);
  const pick = (v, list) => (list.includes(String(v || '')) ? String(v) : '');
  return {
    dir: pick(get('dir'), fw.DIRECTIONS),
    act: pick(get('act'), fw.ACTIONS),
    prof: pick(get('prof'), fw.PROFILE_NAMES),
    state: pick(get('state'), ['on', 'off']),
    kw: String(get('kw') || '').trim(),
  };
}

// 列表失败降级：防火墙服务异常/模块缺失时提示而非 500
async function safe(fn, t) {
  try {
    return { data: await fn(), err: null };
  } catch (e) {
    const msg = String(e.message || '');
    const down = /NetSecurity|Get-NetFirewall|无法识别|not recognized/i.test(msg);
    return { data: down ? t('fw.svcDown') : msg.slice(0, 200), err: true };
  }
}

// 应用筛选（服务端过滤）
function applyFilters(items, f) {
  let out = items;
  if (f.dir) out = out.filter((i) => i.dir === f.dir);
  if (f.act) out = out.filter((i) => i.act === f.act);
  if (f.prof) out = out.filter((i) => i.profNames.includes(f.prof));
  if (f.state) out = out.filter((i) => (f.state === 'on' ? i.on : !i.on));
  if (f.kw) {
    const k = f.kw.toLowerCase();
    out = out.filter((i) => `${i.name} ${i.grp} ${i.desc} ${i.lp} ${i.proto}`.toLowerCase().includes(k));
  }
  return out;
}

// partial 渲染（页面 / 筛选 / 操作后刷新共用）：配置文件状态卡 + 规则表
async function renderList(reply, request, f, msg) {
  const tp = await safe(() => fw.listProfiles(request.t), request.t);
  const tr = await safe(() => fw.listRules(request.t), request.t);
  const profiles = tp.err ? [] : tp.data;
  let items = tr.err ? [] : applyFilters(tr.data, f);
  const total = items.length;
  const shown = items.slice(0, CAP);
  return reply.view('partials/fw-list', {
    profiles,
    listErr: tp.err ? tp.data : (tr.err ? tr.data : null),
    items: shown,
    total,
    cap: CAP,
    f,
    role: role(request),
    msg: msg || null,
  });
}

// Toast 头（fetch 手动渲染，前端 toastMsg 读取 HX-Trigger）
function toastHeader(reply, message, type) {
  reply.header('HX-Trigger', JSON.stringify({ toast: { message: 'enc:' + encodeURIComponent(message), type } }));
}

module.exports = async function firewallRoutes(app) {
  // 整页：筛选栏 + 面板壳
  app.get('/firewall', async (request, reply) => {
    const f = filters(request);
    // 面板首次加载的初始查询串（深链筛选直达）
    const initQs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    return reply.renderPage('pages/firewall', {
      title: request.t('fw.title'),
      active: 'firewall',
      f,
      initQs,
      fw, // 视图引用白名单常量（PROFILE_NAMES）
      role: role(request),
      msg: null,
    });
  });

  // 筛选 / 刷新（partial）
  app.get('/firewall/list', async (request, reply) => {
    return renderList(reply, request, filters(request), null);
  });

  // 启用/禁用规则（可逆操作，不设确认框）
  app.post('/firewall/rule/toggle', async (request, reply) => {
    app.assertWritable(request);
    const b = request.body || {};
    const id = String(b.id || '').trim();
    const on = String(b.on || '') === '1';
    if (!fw.RULE_ID_RE.test(id)) throw bad(request.t, 'fw.invalidId');
    const r = await fw.toggleRule(id, on, request.t);
    audit(request, '切换防火墙规则状态', { id, on, ok: r.ok });
    if (!r.ok) {
      toastHeader(reply, request.t('fw.actionFailed') + ' ' + r.error, 'warning');
      return renderList(reply, request, filters(request), r.error);
    }
    toastHeader(reply, request.t(on ? 'fw.ruleEnabled' : 'fw.ruleDisabled').replace('{n}', String(b.name || id)), 'success');
    return renderList(reply, request, filters(request), null);
  });

  // 新建放行/阻止规则
  app.post('/firewall/rule/create', async (request, reply) => {
    app.assertWritable(request);
    const b = request.body || {};
    const name = String(b.name || '').trim();
    const dir = String(b.dir || '');
    const act = String(b.act || '');
    const proto = String(b.proto || '');
    const lport = String(b.lport || '').trim();
    const prof = String(b.prof || '');
    const desc = String(b.desc || '').trim();
    if (!fw.RULE_NAME_RE.test(name)) throw bad(request.t, 'fw.invalidName');
    if (!fw.DIRECTIONS.includes(dir) || !fw.ACTIONS.includes(act) || !fw.PROTOCOLS.includes(proto)) throw bad(request.t, 'fw.invalidName');
    if (!fw.PROFILE_NAMES.includes(prof)) throw bad(request.t, 'fw.invalidName');
    if ((proto === 'TCP' || proto === 'UDP') && lport && !fw.validPorts(lport)) throw bad(request.t, 'fw.invalidPort');
    const r = await fw.createRule(name, dir, act, proto, lport, prof, desc, request.t);
    audit(request, '新建防火墙规则', { name, dir, act, proto, lport, prof, ok: r.ok });
    if (!r.ok) {
      toastHeader(reply, request.t('fw.actionFailed') + ' ' + r.error, 'warning');
      return renderList(reply, request, filters(request), r.error);
    }
    toastHeader(reply, request.t('fw.ruleCreated').replace('{n}', name), 'success');
    return renderList(reply, request, filters(request), null);
  });

  // 删除规则（确认框 + 审计；系统内置规则同样可删，由确认框文案警示）
  app.post('/firewall/rule/delete', async (request, reply) => {
    app.assertWritable(request);
    const b = request.body || {};
    const id = String(b.id || '').trim();
    if (!fw.RULE_ID_RE.test(id)) throw bad(request.t, 'fw.invalidId');
    const r = await fw.deleteRule(id, request.t);
    audit(request, '删除防火墙规则', { id, name: b.name || null, ok: r.ok });
    if (!r.ok) {
      toastHeader(reply, request.t('fw.actionFailed') + ' ' + r.error, 'warning');
      return renderList(reply, request, filters(request), r.error);
    }
    toastHeader(reply, request.t('fw.ruleDeleted').replace('{n}', String(b.name || id)), 'success');
    return renderList(reply, request, filters(request), null);
  });

  // 启用/禁用配置文件（高危：整个防火墙面开关，前端确认框红色警示）
  app.post('/firewall/profile/toggle', async (request, reply) => {
    app.assertWritable(request);
    const b = request.body || {};
    const name = String(b.name || '');
    const on = String(b.on || '') === '1';
    if (!['Domain', 'Private', 'Public'].includes(name)) throw bad(request.t, 'fw.invalidId');
    const r = await fw.toggleProfile(name, on, request.t);
    audit(request, '切换防火墙配置文件', { name, on, ok: r.ok });
    if (!r.ok) {
      toastHeader(reply, request.t('fw.actionFailed') + ' ' + r.error, 'warning');
      return renderList(reply, request, filters(request), r.error);
    }
    toastHeader(reply, request.t(on ? 'fw.profOn' : 'fw.profOff').replace('{n}', request.t('fw.prof.' + name)), on ? 'success' : 'warning');
    return renderList(reply, request, filters(request), null);
  });
};
