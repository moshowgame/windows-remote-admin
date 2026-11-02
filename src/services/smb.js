'use strict';

// SMB 共享管理服务：共享目录 / 客户端会话 / 打开文件 三块浏览 + 管理
// 动态值（共享名/路径/FileId/账户列表）经 fresh 模式 spawn env 注入 + $env:XXX 引用，绝不拼接进命令串
// 依赖 LanmanServer（Server 服务）；未运行时报错由路由层降级为友好提示

const ps = require('./powershell');

// 共享名白名单（Windows 允许字母数字._-空格$）
const SHARE_NAME_RE = /^[A-Za-z0-9._\- ]{1,80}$/;
// 账户/组名白名单（允许 DOMAIN\user 形式）
const ACCOUNT_RE = /^[A-Za-z0-9_.\-\s\\]{1,104}$/;
// 本地路径（新建共享要求存在）：盘符开头、禁 UNC/ADS/非法字符
const SHARE_PATH_RE = /^[A-Za-z]:\\[^<>:"|?*\u0000-\u001f]{0,250}$/;
// 管理共享（隐藏系统共享 + 域控目录），禁止取消共享
const MANAGED_RE = /\$$|^(print|fax|sysvol|netlogon)$/i;
const RIGHTS = ['Read', 'Change', 'Full'];

const TABS = new Set(['shares', 'sessions', 'openfiles']);

function isManagedShare(name) {
  return MANAGED_RE.test(String(name || ''));
}

// JSON 行解析：单对象 → 数组
function rows(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  const d = JSON.parse(s);
  return Array.isArray(d) ? d : [d];
}

// ---- 浏览 ----

// 共享目录 + 访问权限（access = 'DOMAIN\user:Right,...' 逗号串，展示与 diff 预填共用）
async function listShares(t) {
  const cmd = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
    + 'Get-SmbShare | Sort-Object Name | ForEach-Object { $s = $_; '
    + '$acc = (Get-SmbShareAccess -Name $s.Name | ForEach-Object { $_.AccountName + ":" + $_.AccessRight }) -join ","; '
    + '[pscustomobject]@{ name=$s.Name; path=$s.Path; desc=$s.Description; type=[string]$s.ShareType; users=[int]$s.CurrentUsers; access=$acc } '
    + '} | ConvertTo-Json -Compress -Depth 2';
  const r = await ps.execute(cmd, { timeoutMs: 30000, sessionKey: 'smb-mgmt' });
  if (!r.ok) throw new Error(String(r.output || '').slice(0, 300));
  // everyone 标志：权限列表中含 Everyone 账户（列表警示徽章 + 「仅看 Everyone 暴露」筛选共用）
  return rows(r.output).map((x) => ({
    ...x,
    managed: isManagedShare(x.name),
    everyone: String(x.access || '').split(',').some((a) => /everyone$/i.test(a.split(':')[0].trim())),
  }));
}

// 客户端会话
async function listSessions(t) {
  const cmd = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
    + 'Get-SmbSession | Sort-Object ClientUserName | ForEach-Object { '
    + '[pscustomobject]@{ id=[string]$_.SessionId; client=[string]$_.ClientComputerName; user=[string]$_.ClientUserName; conns=[int]$_.NumConnections; idle=[string]$_.IdleTime; since=$_.CreateTime.ToString("s") } '
    + '} | ConvertTo-Json -Compress -Depth 2';
  const r = await ps.execute(cmd, { timeoutMs: 30000, sessionKey: 'smb-mgmt' });
  if (!r.ok) throw new Error(String(r.output || '').slice(0, 300));
  return rows(r.output);
}

// 服务端被打开的文件
async function listOpenFiles(t) {
  const cmd = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
    + 'Get-SmbOpenFile | Sort-Object Path | ForEach-Object { '
    + '[pscustomobject]@{ id=[string]$_.FileId; path=[string]$_.Path; user=[string]$_.ClientUserName; client=[string]$_.ClientComputerName; opens=[int]$_.NumOpens; locks=[int]$_.NumLocks } '
    + '} | ConvertTo-Json -Compress -Depth 2';
  const r = await ps.execute(cmd, { timeoutMs: 30000, sessionKey: 'smb-mgmt' });
  if (!r.ok) throw new Error(String(r.output || '').slice(0, 300));
  return rows(r.output);
}

// ---- 管理（全部 fresh + env 注入）----

// 新建共享：read/change/full = 账户数组（Full 为锁定保留项）；返回新共享名
async function createShare(name, sharePath, desc, read, change, full, t) {
  const env = {
    WRA_SMB_NAME: name,
    WRA_SMB_PATH: sharePath,
    WRA_SMB_READ: read.join(';'),
    WRA_SMB_CHANGE: change.join(';'),
    WRA_SMB_FULL: full.join(';'),
  };
  let cmd = '$p = @{ Name = $env:WRA_SMB_NAME; Path = $env:WRA_SMB_PATH; '
    + 'FullAccess = ($env:WRA_SMB_FULL -split \';\' | Where-Object { $_ })';
  if (read.length) cmd += '; ReadAccess = ($env:WRA_SMB_READ -split \';\' | Where-Object { $_ })';
  if (change.length) cmd += '; ChangeAccess = ($env:WRA_SMB_CHANGE -split \';\' | Where-Object { $_ })';
  if (desc) {
    env.WRA_SMB_DESC = desc;
    cmd += '; Description = $env:WRA_SMB_DESC';
  }
  cmd += ' }; New-SmbShare @p | Out-Null';
  const r = await ps.execute(cmd, { timeoutMs: 30000, fresh: true, env });
  if (!r.ok) return { ok: false, error: String(r.output || '').slice(0, 200) };
  return { ok: true };
}

// 取消共享（管理共享由路由层前置拦截）
async function removeShare(name, t) {
  const r = await ps.execute('Remove-SmbShare -Name $env:WRA_SMB_NAME -Force', {
    timeoutMs: 30000, fresh: true, env: { WRA_SMB_NAME: name },
  });
  if (!r.ok) return { ok: false, error: String(r.output || '').slice(0, 200) };
  return { ok: true };
}

// 断开会话 / 关闭打开文件
async function closeSession(id, t) {
  const r = await ps.execute('Close-SmbSession -SessionId $env:WRA_SMB_ID -Force', {
    timeoutMs: 30000, fresh: true, env: { WRA_SMB_ID: String(id) },
  });
  if (!r.ok) return { ok: false, error: String(r.output || '').slice(0, 200) };
  return { ok: true };
}
async function closeOpenFile(id, t) {
  const r = await ps.execute('Close-SmbOpenFile -FileId $env:WRA_SMB_ID -Force', {
    timeoutMs: 30000, fresh: true, env: { WRA_SMB_ID: String(id) },
  });
  if (!r.ok) return { ok: false, error: String(r.output || '').slice(0, 200) };
  return { ok: true };
}

// 权限 diff：current/desired = [{account, right}]；返回 revoke 账户数组 + grant [account, right] 数组
// 规则：移除 = Revoke；新增 = Grant；级别变更 = Revoke + Grant（先收后授，不中断连接）
function accessDiff(current, desired) {
  const cur = new Map(current.map((a) => [a.account.toLowerCase(), a.right]));
  const des = new Map(desired.map((a) => [a.account.toLowerCase(), a.right]));
  const revoke = [];
  const grant = [];
  cur.forEach((right, acc) => {
    const d = des.get(acc);
    if (!d) revoke.push(acc);
    else if (d !== right) {
      revoke.push(acc);
      grant.push([acc, d]);
    }
  });
  des.forEach((right, acc) => {
    if (!cur.has(acc)) grant.push([acc, right]);
  });
  return { revoke, grant };
}

// 应用权限 diff：revoke = 账户数组；grant = [account, right] 数组（env 以 account|right 分号串注入）
async function editAccess(name, revoke, grant, t) {
  const env = {
    WRA_SMB_NAME: name,
    WRA_SMB_REVOKE: revoke.join(';'),
    WRA_SMB_GRANT: grant.map((g) => g[0] + '|' + g[1]).join(';'),
  };
  const cmd = '$rev = $env:WRA_SMB_REVOKE -split \';\' | Where-Object { $_ }; '
    + 'foreach ($a in $rev) { Revoke-SmbShareAccess -Name $env:WRA_SMB_NAME -AccountName $a -Force | Out-Null } '
    + '$gr = $env:WRA_SMB_GRANT -split \';\' | Where-Object { $_ }; '
    + 'foreach ($g in $gr) { $pair = $g -split \'\\|\'; Grant-SmbShareAccess -Name $env:WRA_SMB_NAME -AccountName $pair[0] -AccessRight $pair[1] -Force | Out-Null }';
  const r = await ps.execute(cmd, { timeoutMs: 30000, fresh: true, env });
  if (!r.ok) return { ok: false, error: String(r.output || '').slice(0, 200) };
  return { ok: true };
}

// access 逗号串 → [{account, right}]（从 listShares 输出解析，供权限编辑预填/校验）
function parseAccess(access) {
  return String(access || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.lastIndexOf(':');
    return { account: i === -1 ? s : s.slice(0, i), right: i === -1 ? 'Read' : s.slice(i + 1) };
  });
}

module.exports = {
  SHARE_NAME_RE,
  ACCOUNT_RE,
  SHARE_PATH_RE,
  RIGHTS,
  TABS,
  isManagedShare,
  listShares,
  listSessions,
  listOpenFiles,
  createShare,
  removeShare,
  closeSession,
  closeOpenFile,
  accessDiff,
  editAccess,
  parseAccess,
};
