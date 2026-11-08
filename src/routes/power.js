'use strict';

// 重启/关机路由：本机操作 / 远程操作（DCOM|WinRM）/ 中止计划 / 连通性预检 / 近期 1074 事件
// 全部写操作 admin 专属 + 确认框（前端）+ 审计；密码仅 env 注入，绝不落日志与审计
const pw = require('../services/power');
const audit = require('../hooks/audit');

function role(request) {
  return (request.session && request.session.get('role')) || 'admin';
}

function forbid(request) {
  throw Object.assign(new Error(request.t('common.forbidden')), { statusCode: 403 });
}

function bad(t, key) {
  return Object.assign(new Error(t(key)), { statusCode: 400 });
}

function toastHeader(reply, message, type) {
  reply.header('HX-Trigger', JSON.stringify({ toast: { message: 'enc:' + encodeURIComponent(message), type } }));
}

// 参数归一：动作/延迟/理由（理由压平换行，shutdown /c 与 WMI Comment 均不支持多行语义）
function opOf(v, t) {
  const op = String(v || '');
  if (!pw.validOp(op)) throw bad(t, 'p.invalidOp');
  return op;
}

function delayOf(v, t) {
  const n = parseInt(v, 10);
  if (!pw.validDelay(n)) throw bad(t, 'p.invalidDelay');
  return n;
}

function reasonOf(v, t) {
  const r = String(v || '').replace(/[\r\n]+/g, ' ').trim();
  if (!pw.validReason(r)) throw bad(t, 'p.invalidReason');
  return r;
}

// 近期事件 partial（页面 / 操作后刷新共用）
async function renderRecent(reply, request) {
  let rows = null;
  let err = null;
  try {
    rows = await pw.recentEvents(request.t);
  } catch (e) {
    err = String(e.message || '').slice(0, 200);
  }
  return reply.view('partials/power-recent', { rows, err });
}

module.exports = async function powerRoutes(app) {
  // 整页
  app.get('/power', async (request, reply) => {
    return reply.renderPage('pages/power', {
      title: request.t('p.title'),
      active: 'power',
      isAdmin: role(request) === 'admin',
      pw,
      msg: null,
    });
  });

  // 近 24h 关机/重启事件（partial，面板 hx-trigger=load）
  app.get('/power/recent', async (request, reply) => {
    return renderRecent(reply, request);
  });

  // 本机重启/关机（admin；前端双重确认，延迟默认 10 秒可中止）
  app.post('/power/local', async (request, reply) => {
    if (role(request) !== 'admin') forbid(request);
    const t = request.t;
    const b = request.body || {};
    const op = opOf(b.op, t);
    const delay = delayOf(b.delay, t);
    const reason = reasonOf(b.reason, t);
    const r = await pw.localShutdown(op, delay, reason, t);
    audit(request, op === 'restart' ? '本机重启' : '本机关机', { delay, reason, ok: r.ok });
    if (!r.ok) {
      toastHeader(reply, t('p.actionFailed') + ' ' + r.error, 'error');
    } else {
      toastHeader(reply, (op === 'restart' ? t('p.doneRestart') : t('p.doneShutdown')).replace('{n}', String(delay)), 'warning');
    }
    return renderRecent(reply, request);
  });

  // 中止已计划的关机（admin；无计划时提示而非报错）
  app.post('/power/abort', async (request, reply) => {
    if (role(request) !== 'admin') forbid(request);
    const t = request.t;
    const r = await pw.abortShutdown(t);
    audit(request, '取消关机计划', { ok: r.ok });
    if (r.ok) toastHeader(reply, t('p.abortOk'), 'success');
    else toastHeader(reply, t('p.abortNone'), 'info');
    return renderRecent(reply, request);
  });

  // 远程重启/关机（admin；IP + 账号密码 + 理由；通道 DCOM/WMI 或 WinRM）
  app.post('/power/remote', async (request, reply) => {
    if (role(request) !== 'admin') forbid(request);
    const t = request.t;
    const b = request.body || {};
    const op = opOf(b.op, t);
    const delay = delayOf(b.delay, t);
    const reason = reasonOf(b.reason, t);
    const channel = String(b.channel || '');
    const target = String(b.target || '').trim();
    const user = String(b.user || '').trim();
    const pwd = String(b.pwd || '');
    if (!pw.CHANNELS.includes(channel)) throw bad(t, 'p.invalidChannel');
    if (!pw.validHost(target)) throw bad(t, 'p.invalidTarget');
    if (!pw.validUser(user)) throw bad(t, 'p.invalidUser');
    if (!pwd || pwd.length > 127) throw bad(t, 'p.invalidPwd');
    const r = await pw.remoteShutdown(target, user, pwd, op, delay, reason, channel, t);
    // 审计不记录密码
    audit(request, '远程重启/关机', { target, user, channel, op, delay, reason, ok: r.ok });
    if (!r.ok) {
      toastHeader(reply, t('p.actionFailed') + ' ' + r.error, 'error');
    } else {
      toastHeader(reply, (op === 'restart' ? t('p.doneRemoteRestart') : t('p.doneRemoteShutdown'))
        .replace('{n}', target).replace('{s}', String(delay)), 'warning');
    }
    return renderRecent(reply, request);
  });

  // 连通性预检（admin；只读探测不落审计）
  app.post('/power/probe', async (request, reply) => {
    if (role(request) !== 'admin') forbid(request);
    const t = request.t;
    const b = request.body || {};
    const channel = String(b.channel || '');
    const target = String(b.target || '').trim();
    if (!pw.CHANNELS.includes(channel)) throw bad(t, 'p.invalidChannel');
    if (!pw.validHost(target)) throw bad(t, 'p.invalidTarget');
    const r = await pw.probe(target, channel, t);
    return reply.type('application/json; charset=utf-8').send({
      ok: r.ok,
      msg: r.ok ? t('p.reachOk').replace('{n}', target) : t('p.reachFail') + ' ' + (r.error || ''),
    });
  });
};
