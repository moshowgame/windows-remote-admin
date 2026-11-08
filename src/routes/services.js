'use strict';

// 服务管理路由：CIM 全量列表 + 启停/重启/启动类型切换（写操作全部审计）
// 动态值（服务名/启动类型）经 fresh 模式 spawn env 注入 + $env:XXX 引用，绝不拼接进命令串
const ps = require('../services/powershell');
const audit = require('../hooks/audit');

// 服务名白名单：Win32 服务名常见字符（含少量空格/$）
const NAME_RE = /^[A-Za-z0-9_.\- $]{1,80}$/;
// 启动类型映射（前端只传短名，命令参数取白名单值）
const MODES = { auto: 'Automatic', manual: 'Manual', disabled: 'Disabled' };

// ---- 服务注册（NSSM）----
// 注册模板：exe 留空时由 PowerShell Get-Command 自动探测；脚本按模板拼入 AppParameters
//   nodejs     -> <脚本> [附加参数]
//   java       -> -jar <JAR> [附加参数]
//   powershell -> -NoProfile -ExecutionPolicy Bypass -File <脚本> [附加参数]
//   custom     -> 仅附加参数，可执行文件必填绝对路径
const TEMPLATES = new Set(['nodejs', 'java', 'powershell', 'custom']);
// 绝对路径（禁引号/反引号/控制字符，防跨参数注入；值经 env 注入不经 PS 解析器）
const PATH_RE = /^[A-Za-z]:\\[^"\r\n`|<>]{1,500}$/;
// 可执行文件：绝对路径或裸名（node.exe / java.exe，交由 Get-Command 探测）
const EXE_RE = /^(?:[A-Za-z]:\\[^"\r\n`|<>]{1,500}|[A-Za-z][A-Za-z0-9._\-]{0,99})$/;
const ARGS_RE = /^[^\r\n"]{0,2000}$/;
const TEXT_RE = /^[^\r\n"]{0,200}$/;
// 受保护系统服务：禁止卸载（小写比对，覆盖内核/RPC/网络/安全等关键项）
const PROTECTED = new Set([
  'rpcss', 'winmgmt', 'eventlog', 'schedule', 'spooler', 'plugplay', 'power',
  'profsvc', 'usermanager', 'wcmsvc', 'wlansvc', 'w32time', 'dnscache', 'dhcp',
  'lanmanserver', 'lanmanworkstation', 'cryptsvc', 'netlogon', 'windefend',
  'wsearch', 'winrm', 'vss', 'themes', 'sessionenv', 'trkwks', 'mpssvc', 'bfe',
  'securityhealthservice', 'wdiservicehost', 'wdisystemhost', 'wersvc', 'dcomlaunch',
]);

// 注册命令：全程静态字符串，动态值只经 env 注入；$LASTEXITCODE 显式检查兜住 nssm 原生失败
const REGISTER_CMD =
  "$ErrorActionPreference='Stop'; "
  + "function CK { if ($LASTEXITCODE -ne 0) { throw ('nssm 失败，exit=' + $LASTEXITCODE) } } "
  + '$nssm=(Get-Command nssm.exe -ErrorAction Stop).Source; '
  + '$exe=$env:WRA_APP_EXE; '
  + 'if(-not(Test-Path -LiteralPath $exe)) { $exe=(Get-Command $exe -ErrorAction Stop).Source }; '
  + '& $nssm install $env:WRA_SVC_NAME $exe; CK; '
  + 'if($env:WRA_APP_ARGS) { & $nssm set $env:WRA_SVC_NAME AppParameters $env:WRA_APP_ARGS; CK }; '
  + 'if($env:WRA_APP_DIR) { & $nssm set $env:WRA_SVC_NAME AppDirectory $env:WRA_APP_DIR; CK }; '
  + 'if($env:WRA_SVC_DISPLAY) { & $nssm set $env:WRA_SVC_NAME DisplayName $env:WRA_SVC_DISPLAY; CK }; '
  + 'if($env:WRA_SVC_DESC) { & $nssm set $env:WRA_SVC_NAME Description $env:WRA_SVC_DESC; CK }; '
  + '& $nssm set $env:WRA_SVC_NAME Start $env:WRA_SVC_START; CK; '
  + 'if($env:WRA_APP_LOGDIR) { '
  + 'New-Item -ItemType Directory -Force -Path $env:WRA_APP_LOGDIR | Out-Null; '
  + "& $nssm set $env:WRA_SVC_NAME AppStdout (Join-Path $env:WRA_APP_LOGDIR ($env:WRA_SVC_NAME + '.out.log')); CK; "
  + "& $nssm set $env:WRA_SVC_NAME AppStderr (Join-Path $env:WRA_APP_LOGDIR ($env:WRA_SVC_NAME + '.err.log')); CK; "
  + '& $nssm set $env:WRA_SVC_NAME AppRotateFiles 1; CK; '
  + '& $nssm set $env:WRA_SVC_NAME AppRotateOnline 1; CK; '
  + '& $nssm set $env:WRA_SVC_NAME AppRotateBytes 10485760; CK }; '
  + '& $nssm set $env:WRA_SVC_NAME AppExit Default Restart; CK; '
  + '& $nssm set $env:WRA_SVC_NAME AppRestartDelay 5000; CK; '
  + "if($env:WRA_SVC_AUTOSTART -eq '1') { Start-Service -Name $env:WRA_SVC_NAME -ErrorAction SilentlyContinue }";

// 按模板组装 AppParameters（脚本路径由后端拼入，前端只传模板类型与附加参数）
function buildAppArgs(tpl, script, extra) {
  if (tpl === 'java') return (`-jar ${script} ${extra || ''}`).trim();
  if (tpl === 'powershell') return (`-NoProfile -ExecutionPolicy Bypass -File ${script} ${extra || ''}`).trim();
  if (tpl === 'nodejs') return (`${script} ${extra || ''}`).trim();
  return extra || '';
}

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

  // 注册服务（NSSM）：nodejs / java / powershell / custom 四种模板，动态值全部 env 注入
  app.post('/services/register', async (request, reply) => {
    app.assertWritable(request);
    const body = request.body || {};
    const bad = (key) => Object.assign(new Error(request.t(key)), { statusCode: 400 });

    const tpl = String(body.tpl || '');
    if (!TEMPLATES.has(tpl)) throw bad('services.regInvalidTpl');
    const name = String(body.name || '').trim();
    if (!NAME_RE.test(name)) throw bad('services.invalidName');

    const exe = String(body.exe || '').trim();
    const script = String(body.script || '').trim();
    const args = String(body.args || '').trim();
    const workDir = String(body.workDir || '').trim();
    const logDir = String(body.logDir || '').trim();
    const display = String(body.display || '').trim();
    const desc = String(body.desc || '').trim();

    // 模板字段校验：custom 必填 exe 绝对路径；三种语言模板脚本必填绝对路径
    if (tpl === 'custom') {
      if (!PATH_RE.test(exe)) throw bad('services.regRequired');
    } else {
      if (exe && !EXE_RE.test(exe)) throw bad('services.regInvalidPath');
      if (!PATH_RE.test(script)) throw bad('services.regInvalidPath');
    }
    if (!ARGS_RE.test(args) || !TEXT_RE.test(display) || !TEXT_RE.test(desc)) throw bad('services.regInvalidArgs');
    if ((workDir && !PATH_RE.test(workDir)) || (logDir && !PATH_RE.test(logDir))) throw bad('services.regInvalidPath');

    const env = {
      WRA_SVC_NAME: name,
      WRA_APP_EXE: exe || (tpl === 'java' ? 'java.exe' : tpl === 'powershell' ? 'powershell.exe' : 'node.exe'),
      WRA_APP_ARGS: buildAppArgs(tpl, script, args),
      WRA_SVC_START: body.mode === 'manual' ? 'SERVICE_DEMAND_START' : 'SERVICE_AUTO_START',
      WRA_SVC_AUTOSTART: body.mode !== 'manual' && body.autostart !== '0' ? '1' : '0', // manual 或未勾选则不随安装启动
    };
    if (workDir) env.WRA_APP_DIR = workDir;
    if (logDir) env.WRA_APP_LOGDIR = logDir;
    if (display) env.WRA_SVC_DISPLAY = display;
    if (desc) env.WRA_SVC_DESC = desc;

    const r = await ps.execute(REGISTER_CMD, { timeoutMs: 60000, fresh: true, env });
    const ok = !!r.ok;
    audit(request, '服务注册', {
      name, template: tpl, exe: env.WRA_APP_EXE, args: env.WRA_APP_ARGS,
      workDir: workDir || null, logDir: logDir || null, ok,
    });

    const services = await listServices(app.config.psTimeoutMs, request.t);
    const role = request.session.get('role') || 'admin';
    const toastMsg = 'enc:' + encodeURIComponent(
      ok ? request.t('services.regDone') : request.t('services.regFailed').replace('{n}', String(r.output || '').slice(0, 120))
    );
    // 成功时附带事件通知前端关闭注册模态框
    const triggers = { toast: { message: toastMsg, type: ok ? 'success' : 'warning' } };
    if (ok) triggers['svc-register-done'] = Date.now();
    reply.header('HX-Trigger', JSON.stringify(triggers));
    return renderList(reply, services, String(body.kw || '').trim(), null, role);
  });

  // 卸载服务：停止 + sc.exe delete（标记删除）；受保护系统服务拒绝
  app.post('/services/uninstall', async (request, reply) => {
    app.assertWritable(request);
    const body = request.body || {};
    const name = String(body.name || '').trim();
    if (!NAME_RE.test(name)) throw Object.assign(new Error(request.t('services.invalidName')), { statusCode: 400 });
    if (PROTECTED.has(name.toLowerCase())) {
      throw Object.assign(new Error(request.t('services.protectedName')), { statusCode: 400 });
    }

    const cmd = '$ErrorActionPreference=\'Stop\'; '
      + 'Stop-Service -Name $env:WRA_SVC_NAME -Force -ErrorAction SilentlyContinue; '
      + 'sc.exe delete $env:WRA_SVC_NAME; '
      + 'if($LASTEXITCODE -ne 0) { throw (\'sc.exe delete 失败，exit=\' + $LASTEXITCODE) }';
    const r = await ps.execute(cmd, { timeoutMs: 30000, fresh: true, env: { WRA_SVC_NAME: name } });
    const ok = !!r.ok;
    audit(request, '服务卸载', { name, ok });

    const services = await listServices(app.config.psTimeoutMs, request.t);
    const role = request.session.get('role') || 'admin';
    const toastMsg = 'enc:' + encodeURIComponent(
      ok ? request.t('services.uninstallDone') : request.t('services.uninstallFailed').replace('{n}', String(r.output || '').slice(0, 120))
    );
    reply.header('HX-Trigger', JSON.stringify({ toast: { message: toastMsg, type: ok ? 'success' : 'warning' } }));
    return renderList(reply, services, String(body.kw || '').trim(), null, role);
  });
};
