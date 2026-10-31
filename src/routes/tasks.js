'use strict';

// 任务计划管理路由：Get-ScheduledTask 全量列表（文件夹筛选 / 名称模糊搜索）
// + 运行 / 终止 / 启用 / 禁用 / 删除 + XML 导入导出（全保真编辑）+ 结构化新建
// 动态值一律经 fresh 模式 spawn env 注入 + $env:XXX 引用，绝不拼接进命令串

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const ps = require('../services/powershell');
const audit = require('../hooks/audit');

// 任务名黑名单式校验（\ / : * ? " < > | 与控制字符），长度 1-100（允许中文/空格）
function validName(n) {
  return typeof n === 'string' && n.length >= 1 && n.length <= 100
    && !/[\\/:*?"<>|\x00-\x1f]/.test(n);
}

// 任务文件夹形如 \A\B\（根为 \），无非法字符/控制字符，长度 ≤ 200
const PATH_RE = /^\\[^<>:|?*"\x00-\x1f]{0,190}\\$/;
function validFolderPath(p) {
  return p === '\\' || PATH_RE.test(p);
}

// 新建表单的文件夹输入规范化：'' → '\'（根）；'\Foo' / 'Foo' → '\Foo\'
function normalizeFolder(p) {
  let s = String(p || '').trim();
  if (!s) return '\\';
  if (!s.startsWith('\\')) s = '\\' + s;
  if (!s.endsWith('\\')) s += '\\';
  return s;
}

// 全量拉取任务（Get-ScheduledTask + 逐任务 Get-ScheduledTaskInfo，JSON 压缩输出）
// 注意：State 是枚举必须 [string] 强转，否则 ConvertTo-Json 输出数字（同 TCPState 坑）
// LastRunTime 为哨兵日期（COM 最小 1899-12-30；部分系统返回 1999-11-30）时输出 null，前端按「—」处理
async function listTasks(timeoutMs, t) {
  const cmd = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ErrorActionPreference=\'SilentlyContinue\'; '
    + '$r=@(); Get-ScheduledTask | ForEach-Object { '
    + '$i=$null; try { $i=$_ | Get-ScheduledTaskInfo } catch {}; '
    + '$ex=$null; try { $ex=@($_.Actions)[0].Execute } catch {}; '
    + '$lr=$null; if($i){ $lr=$i.LastTaskResult }; '
    + '$l=$null; if($i -and $i.LastRunTime -and $i.LastRunTime.Year -ge 2000){ $l=$i.LastRunTime.ToString(\'yyyy-MM-dd HH:mm:ss\') }; '
    + '$n=$null; if($i -and $i.NextRunTime){ $n=$i.NextRunTime.ToString(\'yyyy-MM-dd HH:mm:ss\') }; '
    + '$r += [PSCustomObject]@{ n=$_.TaskName; p=$_.TaskPath; s=[string]$_.State; d=$_.Description; ex=$ex; l=$l; lr=$lr; nr=$n } '
    + '}; $r | Sort-Object p, n | ConvertTo-Json -Compress -Depth 3';
  const r = await ps.execute(cmd, { timeoutMs, sessionKey: 'task-mgmt' });
  if (!r.ok) throw new Error(t('tasks.listFailed').replace('{n}', String(r.output || '').slice(0, 200)));
  const raw = String(r.output || '').trim();
  if (!raw) return [];
  const data = JSON.parse(raw);
  return Array.isArray(data) ? data : [data];
}

// 从全量任务提取文件夹候选（含根），字典序
function extractFolders(tasks) {
  const set = new Set(['\\']);
  tasks.forEach((x) => { if (x.p) set.add(x.p); });
  return [...set].sort();
}

function matchKw(task, kw) {
  if (!kw) return true;
  const hay = `${task.n} ${task.d || ''} ${task.ex || ''}`.toLowerCase();
  return hay.includes(kw);
}

function matchFolder(task, folder, sub) {
  if (!folder) return true;                 // 全部
  if (folder === '\\') return task.p === '\\';
  return sub ? String(task.p).startsWith(folder) : task.p === folder;
}

function computeStats(tasks) {
  return {
    total: tasks.length,
    ready: tasks.filter((x) => x.s === 'Ready').length,
    running: tasks.filter((x) => x.s === 'Running').length,
    disabled: tasks.filter((x) => x.s === 'Disabled').length,
  };
}

function matchState(task, state) {
  if (!state) return true; // 全部状态
  return String(task.s || '').toLowerCase() === state;
}

function filterTasks(tasks, kw, folder, sub, state) {
  return tasks.filter((x) => matchKw(x, kw) && matchFolder(x, folder, sub) && matchState(x, state));
}

// 筛选参数解析（页面 query / 写操作 body 共用；sub 默认含子文件夹）
const STATES = new Set(['ready', 'running', 'queued', 'disabled']);

function parseFilters(q) {
  const folder = String((q && q.folder) || '').trim();
  const state = String((q && q.state) || '').trim().toLowerCase();
  return {
    kw: String((q && q.kw) || '').trim().toLowerCase(),
    folder: validFolderPath(folder) ? folder : '',
    sub: String((q && q.sub) || '') !== '0',
    state: STATES.has(state) ? state : '',
  };
}

// 渲染列表片段（统计条 + 表格），页面与操作后刷新共用
function renderList(reply, tasks, filters, msg, role) {
  return reply.view('partials/tasks-list', {
    tasks: filterTasks(tasks, filters.kw, filters.folder, filters.sub, filters.state),
    kw: filters.kw,
    folder: filters.folder,
    sub: filters.sub,
    state: filters.state,
    stats: computeStats(tasks),
    msg,
    role,
  });
}

// 操作命令映射（动态值全部 env 注入）；VERBS 为 toast 动词 i18n key
const ACTIONS = {
  start: 'Start-ScheduledTask -TaskName $env:WRA_TASK_NAME -TaskPath $env:WRA_TASK_PATH -ErrorAction Stop',
  stop: 'Stop-ScheduledTask -TaskName $env:WRA_TASK_NAME -TaskPath $env:WRA_TASK_PATH -ErrorAction Stop',
  enable: 'Enable-ScheduledTask -TaskName $env:WRA_TASK_NAME -TaskPath $env:WRA_TASK_PATH -ErrorAction Stop',
  disable: 'Disable-ScheduledTask -TaskName $env:WRA_TASK_NAME -TaskPath $env:WRA_TASK_PATH -ErrorAction Stop',
  delete: 'Unregister-ScheduledTask -TaskName $env:WRA_TASK_NAME -TaskPath $env:WRA_TASK_PATH -Confirm:$false -ErrorAction Stop',
};
const VERBS = {
  start: 'tasks.actStart',
  stop: 'tasks.actStop',
  enable: 'tasks.actEnable',
  disable: 'tasks.actDisable',
  delete: 'tasks.actDelete',
};

// 新建触发器类型与开始时间格式（datetime-local 输入值）
const TRIGGERS = new Set(['once', 'daily', 'hourly', 'boot', 'logon']);
const START_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const XML_MAX = 512 * 1024;

module.exports = async function tasksRoutes(app) {
  // 全量列表较慢（逐任务取 Info），列表查询固定给至少 90s
  const listTimeout = Math.max(app.config.psTimeoutMs || 60000, 90000);

  // 校验并提取 name/path（写操作共用）
  function readNamePath(body, t) {
    const name = String((body && body.name) || '').trim();
    const taskPath = String((body && body.path) || '').trim();
    if (!validName(name)) {
      throw Object.assign(new Error(t('tasks.invalidName')), { statusCode: 400 });
    }
    if (!validFolderPath(taskPath)) {
      throw Object.assign(new Error(t('tasks.invalidPath')), { statusCode: 400 });
    }
    return { name, taskPath };
  }

  // 整页
  app.get('/tasks', async (request, reply) => {
    const tasks = await listTasks(listTimeout, request.t);
    const filters = parseFilters(request.query);
    return reply.renderPage('pages/tasks', {
      title: request.t('tasks.title'),
      active: 'tasks',
      tasks: filterTasks(tasks, filters.kw, filters.folder, filters.sub, filters.state),
      kw: filters.kw,
      folder: filters.folder,
      sub: filters.sub,
      state: filters.state,
      folders: extractFolders(tasks),
      stats: computeStats(tasks),
      msg: null,
    });
  });

  // 列表片段（筛选 / 操作后刷新）
  app.get('/tasks/list', async (request, reply) => {
    const tasks = await listTasks(listTimeout, request.t);
    const filters = parseFilters(request.query);
    const role = request.session.get('role') || 'admin';
    return renderList(reply, tasks, filters, null, role);
  });

  // 任务操作：start / stop / enable / disable / delete
  app.post('/tasks/action', async (request, reply) => {
    app.assertWritable(request);
    const body = request.body || {};
    const { name, taskPath } = readNamePath(body, request.t);
    const action = String(body.action || '');
    const cmd = ACTIONS[action];
    if (!cmd) throw Object.assign(new Error(request.t('tasks.unknownAction')), { statusCode: 400 });

    const r = await ps.execute(cmd, {
      timeoutMs: 30000,
      fresh: true,
      env: { WRA_TASK_NAME: name, WRA_TASK_PATH: taskPath },
    });
    const ok = !!r.ok;
    audit(request, '任务计划操作', { name, path: taskPath, action, ok });

    const tasks = await listTasks(listTimeout, request.t);
    const filters = parseFilters(body);
    const role = request.session.get('role') || 'admin';
    const verb = request.t(VERBS[action]);
    const toastMsg = 'enc:' + encodeURIComponent(
      ok
        ? request.t('tasks.opDone').replace('{n}', name).replace('{a}', verb)
        : request.t('tasks.opFailed').replace('{n}', name).replace('{a}', verb) + String(r.output || '').slice(0, 150)
    );
    reply.header('HX-Trigger', JSON.stringify({ toast: { message: toastMsg, type: ok ? 'success' : 'error' } }));
    return renderList(reply, tasks, filters, ok ? null : String(r.output || '').slice(0, 200), role);
  });

  // 导出任务 XML（编辑模态加载用，JSON 响应；只读账号也可查看）
  app.get('/tasks/xml', async (request, reply) => {
    const { name, taskPath } = readNamePath(request.query, request.t);
    const r = await ps.execute(
      'Export-ScheduledTask -TaskName $env:WRA_TASK_NAME -TaskPath $env:WRA_TASK_PATH -ErrorAction Stop',
      { timeoutMs: 30000, fresh: true, env: { WRA_TASK_NAME: name, WRA_TASK_PATH: taskPath } }
    );
    if (!r.ok) {
      throw Object.assign(
        new Error(request.t('tasks.xmlLoadFailed').replace('{n}', String(r.output || '').slice(0, 150))),
        { statusCode: 400 }
      );
    }
    return reply.send({ ok: true, xml: String(r.output || '') });
  });

  // 保存任务 XML：写临时文件 → Register-ScheduledTask -Xml -Force 覆盖原任务
  app.post('/tasks/xml', async (request, reply) => {
    app.assertWritable(request);
    const body = request.body || {};
    const { name, taskPath } = readNamePath(body, request.t);
    const xml = String(body.xml || '');
    if (!xml.trim()) throw Object.assign(new Error(request.t('tasks.xmlInvalid')), { statusCode: 400 });
    if (xml.length > XML_MAX) throw Object.assign(new Error(request.t('error.tooLarge')), { statusCode: 413 });

    const tmp = path.join(os.tmpdir(), `wra-task-${crypto.randomUUID()}.xml`);
    await fs.writeFile(tmp, xml, 'utf8');
    let r;
    try {
      // ReadAllText 显式 UTF-8 读取绕过 XML 声明编码探测（导出的声明常为 UTF-16）
      r = await ps.execute(
        '$x=[IO.File]::ReadAllText($env:WRA_TASK_FILE,[Text.Encoding]::UTF8); '
        + 'Register-ScheduledTask -TaskName $env:WRA_TASK_NAME -TaskPath $env:WRA_TASK_PATH -Xml $x -Force -ErrorAction Stop | Out-Null',
        { timeoutMs: 60000, fresh: true, env: { WRA_TASK_NAME: name, WRA_TASK_PATH: taskPath, WRA_TASK_FILE: tmp } }
      );
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
    const ok = !!r.ok;
    audit(request, '任务计划XML保存', { name, path: taskPath, bytes: Buffer.byteLength(xml, 'utf8'), ok });
    if (!ok) {
      throw Object.assign(
        new Error(request.t('tasks.xmlSaveFailed') + String(r.output || '').slice(0, 150)),
        { statusCode: 400 }
      );
    }

    const tasks = await listTasks(listTimeout, request.t);
    const filters = parseFilters(body);
    const role = request.session.get('role') || 'admin';
    reply.header('HX-Trigger', JSON.stringify({
      toast: { message: 'enc:' + encodeURIComponent(request.t('tasks.xmlSaved')), type: 'success' },
    }));
    return renderList(reply, tasks, filters, null, role);
  });

  // 新建任务：结构化表单（程序/参数/起始于 + 5 种常用触发器 + 运行身份）
  app.post('/tasks/create', async (request, reply) => {
    app.assertWritable(request);
    const body = request.body || {};
    const t = request.t;
    const name = String(body.name || '').trim();
    const folder = normalizeFolder(body.folder);
    const exec = String(body.exec || '').trim();
    const args = String(body.args || '');
    const dir = String(body.dir || '').trim();
    const trigger = String(body.trigger || 'once');
    const startAt = String(body.startAt || '').trim();
    const account = String(body.account || 'system');
    const highest = String(body.highest || '') === '1';

    if (!validName(name) || !exec) throw Object.assign(new Error(t('tasks.errRequired')), { statusCode: 400 });
    if (!validFolderPath(folder)) throw Object.assign(new Error(t('tasks.invalidPath')), { statusCode: 400 });
    if (!TRIGGERS.has(trigger)) throw Object.assign(new Error(t('tasks.invalidTrigger')), { statusCode: 400 });
    if (!['system', 'current'].includes(account)) throw Object.assign(new Error(t('tasks.unknownAction')), { statusCode: 400 });
    for (const [v, max] of [[exec, 260], [args, 2048], [dir, 260]]) {
      if (v.length > max || /[\x00-\x1f]/.test(v)) throw Object.assign(new Error(t('error.badRequest')), { statusCode: 400 });
    }

    let interval = 0;
    if (trigger === 'daily' || trigger === 'hourly') {
      interval = parseInt(String(body.interval || ''), 10);
      const max = trigger === 'daily' ? 365 : 8760;
      if (!Number.isInteger(interval) || interval < 1 || interval > max) {
        throw Object.assign(new Error(t('tasks.errInterval')), { statusCode: 400 });
      }
    }
    if (['once', 'daily', 'hourly'].includes(trigger) && !START_RE.test(startAt)) {
      throw Object.assign(new Error(t('tasks.errStartAt')), { statusCode: 400 });
    }

    // 触发器 / 身份 / 动作段组装（动态值仍走 env）
    const at = "([DateTime]::ParseExact($env:WRA_START,'yyyy-MM-ddTHH:mm',[Globalization.CultureInfo]::InvariantCulture))";
    let triggerPart;
    if (trigger === 'once') triggerPart = `New-ScheduledTaskTrigger -Once -At ${at}`;
    else if (trigger === 'daily') triggerPart = `New-ScheduledTaskTrigger -Daily -At ${at} -DaysInterval ([int]$env:WRA_IVAL)`;
    else if (trigger === 'hourly') {
      // 每小时 = Once 起点无限期重复（RepetitionDuration MaxValue = Indefinitely）
      triggerPart = `New-ScheduledTaskTrigger -Once -At ${at} -RepetitionInterval (New-TimeSpan -Hours ([int]$env:WRA_IVAL)) -RepetitionDuration ([TimeSpan]::MaxValue)`;
    } else if (trigger === 'boot') triggerPart = 'New-ScheduledTaskTrigger -AtStartup';
    else triggerPart = 'New-ScheduledTaskTrigger -AtLogOn';

    const runLevel = highest ? 'Highest' : 'Limited';
    const principalPart = account === 'system'
      ? `New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel ${runLevel}`
      : `New-ScheduledTaskPrincipal -UserId $env:WRA_USER -LogonType Interactive -RunLevel ${runLevel}`;

    let actionPart = 'New-ScheduledTaskAction -Execute $env:WRA_EXEC';
    if (args) actionPart += ' -Argument $env:WRA_ARGS';
    if (dir) actionPart += ' -WorkingDirectory $env:WRA_DIR';

    // 任务文件夹逐级创建（New-Item 不支持任务文件夹，须用 Schedule.Service COM）
    let folderPart = '';
    if (folder !== '\\') {
      folderPart = "$svc=New-Object -ComObject Schedule.Service; $svc.Connect(); $cur='\\'; "
        + "foreach($p in $env:WRA_PATH.Split('\\')|Where-Object{$_}){ "
        + "$next=$cur+$p; try{$svc.GetFolder($next)|Out-Null}catch{$svc.GetFolder($cur).CreateFolder($p)|Out-Null}; $cur=$next+'\\' }; ";
    }

    const cmd = "$ErrorActionPreference='Stop'; " + folderPart
      + `$a=${actionPart}; $tr=${triggerPart}; $pr=${principalPart}; `
      + 'Register-ScheduledTask -TaskName $env:WRA_NAME -TaskPath $env:WRA_PATH -Action $a -Trigger $tr -Principal $pr -ErrorAction Stop | Out-Null';

    const env = {
      WRA_NAME: name,
      WRA_PATH: folder,
      WRA_EXEC: exec,
      WRA_START: startAt,
      WRA_IVAL: String(interval),
      WRA_USER: request.session.get('username') || '',
    };
    if (args) env.WRA_ARGS = args;
    if (dir) env.WRA_DIR = dir;

    const r = await ps.execute(cmd, { timeoutMs: 60000, fresh: true, env });
    const ok = !!r.ok;
    audit(request, '任务计划创建', { name, path: folder, trigger, account, highest, ok });
    if (!ok) {
      throw Object.assign(new Error(t('tasks.createFailed') + String(r.output || '').slice(0, 150)), { statusCode: 400 });
    }

    const tasks = await listTasks(listTimeout, request.t);
    const filters = parseFilters(body);
    const role = request.session.get('role') || 'admin';
    reply.header('HX-Trigger', JSON.stringify({
      toast: { message: 'enc:' + encodeURIComponent(t('tasks.createDone').replace('{n}', name)), type: 'success' },
    }));
    return renderList(reply, tasks, filters, null, role);
  });
};
