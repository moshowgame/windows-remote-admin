'use strict';

// 服务管理路由：CIM 全量列表 + 启停/重启/启动类型切换（写操作全部审计）
// 动态值（服务名/启动类型）经 fresh 模式 spawn env 注入 + $env:XXX 引用，绝不拼接进命令串
const ps = require('../services/powershell');
const audit = require('../hooks/audit');

// 服务名白名单：Win32 服务名常见字符（含少量空格/$）
const NAME_RE = /^[A-Za-z0-9_.\- $]{1,80}$/;
// 启动类型映射（前端只传短名，命令参数取白名单值）
const MODES = { auto: 'Automatic', manual: 'Manual', disabled: 'Disabled' };

// CIM 一次取全量：状态 / 启动类型 / PID / 运行账户 / 可执行路径（t 用于错误消息国际化）
async function listServices(timeoutMs, t) {
  const cmd = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
    + 'Get-CimInstance Win32_Service | Sort-Object DisplayName '
    + '| Select-Object Name, DisplayName, State, StartMode, ProcessId, StartName, PathName '
    + '| ConvertTo-Json -Compress -Depth 2';
  const r = await ps.execute(cmd, { timeoutMs, sessionKey: 'svc-mgmt' });
  if (!r.ok) throw new Error(t('services.listFailed').replace('{n}', String(r.output || '').slice(0, 200)));
  const raw = String(r.output || '').trim();
  if (!raw) return [];
  const data = JSON.parse(raw);
  return Array.isArray(data) ? data : [data];
}

function matchKw(svc, kw) {
  if (!kw) return true;
  const hay = `${svc.Name} ${svc.DisplayName} ${svc.StartName || ''}`.toLowerCase();
  return hay.includes(kw);
}

// 统计汇总（总数 / 运行中 / 已停止 / 自动未运行）
function computeStats(services) {
  return {
    total: services.length,
    running: services.filter((s) => s.State === 'Running').length,
    stopped: services.filter((s) => s.State === 'Stopped').length,
    autoNotRunning: services.filter((s) => s.StartMode === 'Auto' && s.State !== 'Running').length,
  };
}

// 渲染列表片段（tbody + 统计条），页面与操作后刷新共用
function renderList(reply, services, kw, msg, role) {
  const filtered = services.filter((s) => matchKw(s, kw));
  return reply.view('partials/services-list', { services: filtered, kw, stats: computeStats(services), msg, role });
}

module.exports = async function servicesRoutes(app) {
  // 整页
  app.get('/services', async (request, reply) => {
    const services = await listServices(app.config.psTimeoutMs, request.t);
    const kw = String(request.query.kw || '').trim();
    return reply.renderPage('pages/services', {
      title: request.t('services.title'),
      active: 'services',
      services: services.filter((s) => matchKw(s, kw)),
      kw,
      stats: computeStats(services),
      msg: null,
    });
  });

  // 列表片段（搜索 / 操作后刷新）
  app.get('/services/list', async (request, reply) => {
    const services = await listServices(app.config.psTimeoutMs, request.t);
    return renderList(reply, services, String(request.query.kw || '').trim(), null, request.session.get('role') || 'admin');
  });

  // 服务操作：start / stop / restart / mode（mode 需 mode=auto|manual|disabled）
  app.post('/services/action', async (request, reply) => {
    app.assertWritable(request);
    const body = request.body || {};
    const name = String(body.name || '').trim();
    const action = String(body.action || '');
    if (!NAME_RE.test(name)) throw Object.assign(new Error(request.t('services.invalidName')), { statusCode: 400 });

    let cmd;
    if (action === 'start') cmd = 'Start-Service -Name $env:WRA_SVC_NAME -ErrorAction Stop';
    else if (action === 'stop') cmd = 'Stop-Service -Name $env:WRA_SVC_NAME -Force -ErrorAction Stop';
    else if (action === 'restart') cmd = 'Restart-Service -Name $env:WRA_SVC_NAME -Force -ErrorAction Stop';
    else if (action === 'mode') {
      const mode = MODES[String(body.mode || '')];
      if (!mode) throw Object.assign(new Error(request.t('services.invalidMode')), { statusCode: 400 });
      cmd = 'Set-Service -Name $env:WRA_SVC_NAME -StartupType $env:WRA_SVC_MODE -ErrorAction Stop';
    } else throw Object.assign(new Error(request.t('services.unknownAction')), { statusCode: 400 });

    const env = { WRA_SVC_NAME: name };
    if (action === 'mode') env.WRA_SVC_MODE = MODES[String(body.mode)];

    // fresh 一次性进程：env 按调用生效，不残留长驻会话
    const r = await ps.execute(cmd, { timeoutMs: 30000, fresh: true, env });
    const ok = !!r.ok;
    audit(request, '服务管理操作', { name, action, mode: body.mode || null, ok });

    // 操作后重拉列表返回（保持当前搜索关键字）
    const services = await listServices(app.config.psTimeoutMs, request.t);
    const kw = String(body.kw || '').trim();
    const role = request.session.get('role') || 'admin';
    return renderList(reply, services, kw, ok ? null : request.t('services.actionFailed').replace('{n}', String(r.output || '').slice(0, 120)), role);
  });

  // 批量操作：start / stop / restart / disable（逐个执行，每个服务独立审计）
  app.post('/services/batch-action', async (request, reply) => {
    app.assertWritable(request);
    const body = request.body || {};
    const action = String(body.action || '');
    const names = String(body.names || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!names.length || names.length > 20) {
      throw Object.assign(new Error(request.t('services.batchInvalid')), { statusCode: 400 });
    }
    if (names.some((n) => !NAME_RE.test(n))) {
      throw Object.assign(new Error(request.t('services.invalidName')), { statusCode: 400 });
    }
    // 批量「禁用」映射为 Set-Service StartupType Disabled；其余直接对应
    const mode = action === 'disable' ? 'Disabled' : null;
    const realAction = action === 'disable' ? 'mode' : action;
    if (!['start', 'stop', 'restart', 'mode'].includes(realAction) || (realAction === 'mode' && mode !== 'Disabled')) {
      throw Object.assign(new Error(request.t('services.unknownAction')), { statusCode: 400 });
    }

    const results = [];
    for (const name of names) {
      let cmd;
      const env = { WRA_SVC_NAME: name };
      if (realAction === 'start') cmd = 'Start-Service -Name $env:WRA_SVC_NAME -ErrorAction Stop';
      else if (realAction === 'stop') cmd = 'Stop-Service -Name $env:WRA_SVC_NAME -Force -ErrorAction Stop';
      else if (realAction === 'restart') cmd = 'Restart-Service -Name $env:WRA_SVC_NAME -Force -ErrorAction Stop';
      else {
        env.WRA_SVC_MODE = mode;
        cmd = 'Set-Service -Name $env:WRA_SVC_NAME -StartupType $env:WRA_SVC_MODE -ErrorAction Stop';
      }
      let r;
      try {
        r = await ps.execute(cmd, { timeoutMs: 20000, fresh: true, env });
      } catch (err) {
        r = { ok: false, output: String(err && err.message || err) };
      }
      const ok = !!r.ok;
      results.push({ name, ok, error: ok ? null : String(r.output || '').slice(0, 120) });
      audit(request, '服务管理批量操作', { name, action: realAction, mode: realAction === 'mode' ? mode : null, ok, batch: true, total: names.length });
    }

    const okCount = results.filter((x) => x.ok).length;
    const failed = results.filter((x) => !x.ok);
    const msg = failed.length
      ? request.t('services.batchDone').replace('{ok}', String(okCount)).replace('{fail}', String(failed.length))
        + ' | ' + failed.slice(0, 5).map((f) => `${f.name}: ${f.error || ''}`).join(' | ')
      : null;

    const services = await listServices(app.config.psTimeoutMs, request.t);
    const kw = String(body.kw || '').trim();
    const role = request.session.get('role') || 'admin';
    const toastMsg = 'enc:' + encodeURIComponent(
      request.t('services.batchDone').replace('{ok}', String(okCount)).replace('{fail}', String(failed.length))
    );
    reply.header('HX-Trigger', JSON.stringify({ toast: { message: toastMsg, type: failed.length ? 'warning' : 'success' } }));
    return renderList(reply, services, kw, msg, role);
  });
};
