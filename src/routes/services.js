'use strict';

// 服务管理路由：CIM 全量列表 + 启停/重启/启动类型切换（写操作全部审计）
// 动态值（服务名/启动类型）经 fresh 模式 spawn env 注入 + $env:XXX 引用，绝不拼接进命令串
const ps = require('../services/powershell');
const audit = require('../hooks/audit');

// 服务名白名单：Win32 服务名常见字符（含少量空格/$）
const NAME_RE = /^[A-Za-z0-9_.\- $]{1,80}$/;
// 启动类型映射（前端只传短名，命令参数取白名单值）
const MODES = { auto: 'Automatic', manual: 'Manual', disabled: 'Disabled' };

// CIM 一次取全量：状态 / 启动类型 / PID / 运行账户 / 可执行路径
async function listServices(timeoutMs) {
  const cmd = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
    + 'Get-CimInstance Win32_Service | Sort-Object DisplayName '
    + '| Select-Object Name, DisplayName, State, StartMode, ProcessId, StartName, PathName '
    + '| ConvertTo-Json -Compress -Depth 2';
  const r = await ps.execute(cmd, { timeoutMs, sessionKey: 'svc-mgmt' });
  if (!r.ok) throw new Error('获取服务列表失败：' + String(r.output || '').slice(0, 200));
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
    const services = await listServices(app.config.psTimeoutMs);
    const kw = String(request.query.kw || '').trim();
    return reply.renderPage('pages/services', {
      title: '服务管理',
      active: 'services',
      services: services.filter((s) => matchKw(s, kw)),
      kw,
      stats: computeStats(services),
      msg: null,
    });
  });

  // 列表片段（搜索 / 操作后刷新）
  app.get('/services/list', async (request, reply) => {
    const services = await listServices(app.config.psTimeoutMs);
    return renderList(reply, services, String(request.query.kw || '').trim(), null, request.session.get('role') || 'admin');
  });

  // 服务操作：start / stop / restart / mode（mode 需 mode=auto|manual|disabled）
  app.post('/services/action', async (request, reply) => {
    app.assertWritable(request);
    const body = request.body || {};
    const name = String(body.name || '').trim();
    const action = String(body.action || '');
    if (!NAME_RE.test(name)) throw Object.assign(new Error('服务名不合法'), { statusCode: 400 });

    let cmd;
    if (action === 'start') cmd = 'Start-Service -Name $env:WRA_SVC_NAME -ErrorAction Stop';
    else if (action === 'stop') cmd = 'Stop-Service -Name $env:WRA_SVC_NAME -Force -ErrorAction Stop';
    else if (action === 'restart') cmd = 'Restart-Service -Name $env:WRA_SVC_NAME -Force -ErrorAction Stop';
    else if (action === 'mode') {
      const mode = MODES[String(body.mode || '')];
      if (!mode) throw Object.assign(new Error('启动类型不合法'), { statusCode: 400 });
      cmd = 'Set-Service -Name $env:WRA_SVC_NAME -StartupType $env:WRA_SVC_MODE -ErrorAction Stop';
    } else throw Object.assign(new Error('未知操作'), { statusCode: 400 });

    const env = { WRA_SVC_NAME: name };
    if (action === 'mode') env.WRA_SVC_MODE = MODES[String(body.mode)];

    // fresh 一次性进程：env 按调用生效，不残留长驻会话
    const r = await ps.execute(cmd, { timeoutMs: 30000, fresh: true, env });
    const ok = !!r.ok;
    audit(request, '服务管理操作', { name, action, mode: body.mode || null, ok });

    // 操作后重拉列表返回（保持当前搜索关键字）
    const services = await listServices(app.config.psTimeoutMs);
    const kw = String(body.kw || '').trim();
    const role = request.session.get('role') || 'admin';
    return renderList(reply, services, kw, ok ? null : `操作失败：${String(r.output || '').slice(0, 120)}`, role);
  });
};
