'use strict';

// 本地用户管理：账户列表 / 解锁 / 启用禁用 / 密码重置
// 写操作经 app.assertWritable（readonly 403）；动态值全部 env 注入，绝不拼接进命令串
const ps = require('../services/powershell');
const audit = require('../hooks/audit');

const NAME_RE = /^[A-Za-z0-9_.\- $]{1,80}$/;
// 支持解锁与启用（禁用操作易导致账户不可用，已移除）；Guest 禁止启用（安全底线）
const ACTIONS = ['unlock', 'enable'];
const GUEST = 'Guest';

// 动作 → PowerShell 命令（$env: 引用，重置密码额外注入 WRA_USER_PWD）
// 密码重置用 net.exe（独立进程，不依赖 Security 模块——powershell.exe 5.1 在 pwsh 终端
// 启动的进程树里会因继承 pwsh 的 PSModulePath 而无法加载 Microsoft.PowerShell.Security）
const ACTION_CMD = {
  unlock: 'Unlock-LocalUser -Name $env:WRA_USER_NAME -ErrorAction Stop',
  enable: 'Enable-LocalUser -Name $env:WRA_USER_NAME -ErrorAction Stop',
  disable: 'Disable-LocalUser -Name $env:WRA_USER_NAME -ErrorAction Stop',
  resetpwd: 'net user "$env:WRA_USER_NAME" "$env:WRA_USER_PWD" > $null; if ($LASTEXITCODE -eq 0) { \'WRA_OK\' } else { throw (\'net exit \' + $LASTEXITCODE) }',
};

async function queryUsers(app, t) {
  const cmd = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
    + '$us = @(Get-LocalUser | ForEach-Object { '
    + '$ll = \'\'; if ($_.LastLogon -and $_.LastLogon -ne [datetime]::MinValue) { $ll = $_.LastLogon.ToString(\'yyyy-MM-dd HH:mm\') }; '
    + '$pl = \'\'; if ($_.PasswordLastSet) { $pl = $_.PasswordLastSet.ToString(\'yyyy-MM-dd HH:mm\') }; '
    + '[PSCustomObject]@{ n = $_.Name; e = [bool]$_.Enabled; lo = [bool]$_.LockedOut; ll = $ll; pl = $pl; d = $_.Description } }); '
    + '@{ t = $us.Count; r = $us } | ConvertTo-Json -Compress -Depth 3';
  const out = await ps.execute(cmd, { sessionKey: 'user-mgmt', timeoutMs: 30000 });
  if (!out.ok) throw new Error(t('users.listFailed').replace('{n}', String(out.output || '').slice(0, 160)));
  const raw = String(out.output || '').trim();
  if (!raw) return { total: 0, rows: [] };
  const data = JSON.parse(raw);
  const rows = Array.isArray(data.r) ? data.r : [data.r].filter(Boolean);
  return { total: data.t || rows.length, rows };
}

function filterRows(result, kw) {
  const k = (kw || '').toLowerCase();
  if (!k) return result.rows;
  return result.rows.filter((r) => `${r.n} ${r.d || ''}`.toLowerCase().includes(k));
}

function renderList(reply, result, kw, msg, role) {
  return reply.view('partials/users-list', {
    rows: filterRows(result, kw), total: result.total, msg, kw, role,
  });
}

module.exports = async function usersRoutes(app) {
  // 整页
  app.get('/users', async (request, reply) => {
    const kw = String(request.query.kw || '').trim().slice(0, 100);
    const result = await queryUsers(app, request.t);
    return reply.renderPage('pages/users', {
      title: request.t('users.title'),
      active: 'users',
      kw,
      rows: filterRows(result, kw),
      total: result.total,
      msg: null,
    });
  });

  // 列表片段（搜索后刷新）
  app.get('/users/list', async (request, reply) => {
    const kw = String(request.query.kw || '').trim().slice(0, 100);
    const result = await queryUsers(app, request.t);
    return renderList(reply, result, kw, null, request.session.get('role') || 'admin');
  });

  // 解锁 / 启用 / 禁用（admin）
  app.post('/users/action', async (request, reply) => {
    app.assertWritable(request);
    const t = request.t;
    const body = request.body || {};
    const name = String(body.name || '').trim();
    const action = String(body.action || '');
    if (!NAME_RE.test(name) || !ACTIONS.includes(action)) {
      throw Object.assign(new Error(t('users.invalidName')), { statusCode: 400 });
    }
    if (action === 'enable' && name.toLowerCase() === GUEST.toLowerCase()) {
      throw Object.assign(new Error(t('users.guestForbidden')), { statusCode: 403 });
    }
    const r = await ps.execute(ACTION_CMD[action], {
      timeoutMs: 30000,
      fresh: true,
      env: { WRA_USER_NAME: name },
    });
    const ok = !!r.ok;
    audit(request, '本地用户操作', { user: name, action, ok });

    const result = await queryUsers(app, t);
    const toastMsg = 'enc:' + encodeURIComponent(
      ok ? t('users.doneUnlock').replace('{n}', name) : t('users.failed') + String(r.output || '').slice(0, 120)
    );
    reply.header('HX-Trigger', JSON.stringify({ toast: { message: toastMsg, type: ok ? 'success' : 'error' } }));
    return renderList(reply, result, String(body.kw || '').trim(), null, request.session.get('role') || 'admin');
  });

  // 重置密码（admin；审计不记录密码本身）
  app.post('/users/resetpwd', async (request, reply) => {
    app.assertWritable(request);
    const t = request.t;
    const body = request.body || {};
    const name = String(body.name || '').trim();
    const pwd = String(body.password || '');
    const pwd2 = String(body.password2 || '');
    // net.exe 传参限制：密码含空格没问题（双引号包裹），但含双引号会破坏 argv 转义
    if (!NAME_RE.test(name) || !pwd || pwd.length > 127 || pwd.includes('"') || pwd !== pwd2) {
      throw Object.assign(new Error(t('users.invalidPwd')), { statusCode: 400 });
    }
    const r = await ps.execute(ACTION_CMD.resetpwd, {
      timeoutMs: 30000,
      fresh: true,
      env: { WRA_USER_NAME: name, WRA_USER_PWD: pwd },
    });
    const ok = !!r.ok;
    audit(request, '重置本地用户密码', { user: name, ok });

    const result = await queryUsers(app, t);
    const toastMsg = 'enc:' + encodeURIComponent(
      ok ? t('users.donePwd').replace('{n}', name) : t('users.failed') + String(r.output || '').slice(0, 120)
    );
    reply.header('HX-Trigger', JSON.stringify({ toast: { message: toastMsg, type: ok ? 'success' : 'error' } }));
    return renderList(reply, result, String(body.kw || '').trim(), null, request.session.get('role') || 'admin');
  });
};
