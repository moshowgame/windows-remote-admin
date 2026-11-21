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

// SMB 权限级别 → NTFS icacls 权限标记（(OI)(CI) 让权限继承到子目录/文件）
const NTFS_RIGHT = { Read: 'RX', Change: 'M', Full: 'F' };

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

// 共享目录 + 访问权限（share access = 'DOMAIN\user:Right,...' 逗号串；ntfs = NTFS ACL 条目数组）
async function listShares(t) {
  const cmd = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
    + 'Get-SmbShare | Sort-Object Name | ForEach-Object { $s = $_; '
    + '$acc = (Get-SmbShareAccess -Name $s.Name | ForEach-Object { $_.AccountName + ":" + $_.AccessRight }) -join ","; '
    + '$ntfs = @(); $owner = ""; '
    + 'try { $acl = Get-Acl -LiteralPath $s.Path -ErrorAction Stop; $owner = [string]$acl.Owner; '
    + '$ntfs = @($acl.Access | ForEach-Object { [pscustomobject]@{ id=[string]$_.IdentityReference; t=[string]$_.AccessControlType; r=[string]$_.FileSystemRights; inh=[bool]$_.IsInherited } }) } catch { } '
    + '[pscustomobject]@{ name=$s.Name; path=$s.Path; desc=$s.Description; type=[string]$s.ShareType; users=[int]$s.CurrentUsers; access=$acc; owner=$owner; ntfs=$ntfs } '
    + '} | ConvertTo-Json -Compress -Depth 3';
  const r = await ps.execute(cmd, { timeoutMs: 30000, sessionKey: 'smb-mgmt' });
  if (!r.ok) throw new Error(String(r.output || '').slice(0, 300));
  // everyone 标志：共享权限 / NTFS ACL 任一含 Everyone 账户（列表警示徽章 + 「仅看 Everyone 暴露」筛选共用）
  const items = rows(r.output).map((x) => {
    const ntfs = Array.isArray(x.ntfs) ? x.ntfs : (x.ntfs ? [x.ntfs] : []);
    return {
      ...x,
      ntfs,
      owner: String(x.owner || ''),
      managed: isManagedShare(x.name),
      everyone: String(x.access || '').split(',').some((a) => /everyone$/i.test(a.split(':')[0].trim()))
        || ntfs.some((e) => /everyone$/i.test(String(e.id || ''))),
      ntfsEveryone: ntfs.some((e) => /everyone$/i.test(String(e.id || ''))),
    };
  });
  return items;
}

// NTFS ACL 详情（模态展示用）：owner + 访问条目（identity/type/rights/inherited）
async function listNtfs(sharePath, t) {
  const cmd = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
    + 'try { $acl = Get-Acl -LiteralPath $env:WRA_SMB_PATH -ErrorAction Stop; '
    + '$ntfs = @($acl.Access | ForEach-Object { [pscustomobject]@{ id=[string]$_.IdentityReference; t=[string]$_.AccessControlType; r=[string]$_.FileSystemRights; inh=[bool]$_.IsInherited } }); '
    + '[pscustomobject]@{ owner=[string]$acl.Owner; ntfs=$ntfs; err="" } | ConvertTo-Json -Compress -Depth 3 } '
    + 'catch { $msg = ($_ | Out-String).Trim() -replace "\\r?\\n", " " -replace \'"\', "\'\'"; '
    + '[Console]::Out.WriteLine(\'{"owner":"","ntfs":[],"err":"\' + $msg + \'"}\') }';
  const r = await ps.execute(cmd, { timeoutMs: 30000, fresh: true, env: { WRA_SMB_PATH: sharePath } });
  if (!r.ok) return { ok: false, error: String(r.output || '').slice(0, 200) };
  let d;
  try {
    d = JSON.parse(r.output.trim().split('\n').filter((l) => l.trim().startsWith('{')).join('\n') || '{}');
  } catch (e) {
    return { ok: false, error: String(e.message).slice(0, 200) };
  }
  if (d.err) return { ok: false, error: String(d.err).slice(0, 200) };
  return { ok: true, owner: String(d.owner || ''), items: Array.isArray(d.ntfs) ? d.ntfs : (d.ntfs ? [d.ntfs] : []) };
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

// ---- NTFS ACL（icacls，账户经 env 注入；共享权限变更时同步应用，保持两层一致）----

// 授予 NTFS 权限：grants = [account, smbRight]；返回 {ok, error}
// icacls 标记映射 Read→RX / Change→M(修改) / Full→F，(OI)(CI) 继承到子目录与文件
async function applyNtfsGrant(sharePath, grants) {
  if (!grants.length) return { ok: true };
  const env = {
    WRA_SMB_PATH: sharePath,
    WRA_SMB_NTFS_GRANT: grants.map((g) => g[0] + '|' + (NTFS_RIGHT[g[1]] || g[1])).join(';'),
  };
  const cmd = '$g = $env:WRA_SMB_NTFS_GRANT -split \';\' | Where-Object { $_ }; '
    + '$errs = @(); '
    + 'foreach ($item in $g) { $pair = $item -split \'\\|\', 2; '
    + '& icacls.exe $env:WRA_SMB_PATH /grant ($pair[0] + ":(OI)(CI)" + $pair[1]) | Out-Null; '
    + 'if ($LASTEXITCODE -ne 0) { $errs += $pair[0] } } '
    + 'if ($errs.Count) { [Console]::Error.WriteLine(($errs -join \', \') + " grant failed"); exit 1 }';
  const r = await ps.execute(cmd, { timeoutMs: 30000, fresh: true, env });
  if (!r.ok) return { ok: false, error: String(r.output || '').slice(0, 200) };
  return { ok: true };
}

// 移除 NTFS 显式授权（仅显式条目；继承条目 icacls 会失败并计入错误）：accounts = 账户数组
async function applyNtfsRevoke(sharePath, accounts) {
  if (!accounts.length) return { ok: true };
  const env = { WRA_SMB_PATH: sharePath, WRA_SMB_NTFS_REVOKE: accounts.join(';') };
  const cmd = '$rev = $env:WRA_SMB_NTFS_REVOKE -split \';\' | Where-Object { $_ }; '
    + '$errs = @(); '
    + 'foreach ($a in $rev) { & icacls.exe $env:WRA_SMB_PATH /remove:g $a | Out-Null; '
    + 'if ($LASTEXITCODE -ne 0) { $errs += $a } } '
    + 'if ($errs.Count) { [Console]::Error.WriteLine(($errs -join \', \') + " remove failed"); exit 1 }';
  const r = await ps.execute(cmd, { timeoutMs: 30000, fresh: true, env });
  if (!r.ok) return { ok: false, error: String(r.output || '').slice(0, 200) };
  return { ok: true };
}

// 新建共享：read/change/full = 账户数组（Full 为锁定保留项）；同时把同等权限应用到 NTFS ACL；返回 {ok, warn?}
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
  // NTFS ACL 同步（共享层之外的实际文件系统权限）；失败不回滚共享，返回警告
  const grants = [
    ...read.map((a) => [a, 'Read']),
    ...change.map((a) => [a, 'Change']),
    ...full.map((a) => [a, 'Full']),
  ];
  const ntfs = await applyNtfsGrant(sharePath, grants);
  if (!ntfs.ok) return { ok: true, warn: 'NTFS: ' + ntfs.error };
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
// sharePath 传入时同步镜像到 NTFS ACL（icacls）；NTFS 失败不回滚共享权限，返回 warn
async function editAccess(name, revoke, grant, t, sharePath) {
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
  if (sharePath) {
    const ntfsRevoke = await applyNtfsRevoke(sharePath, revoke);
    const ntfsGrant = ntfsRevoke.ok ? await applyNtfsGrant(sharePath, grant) : { ok: true };
    if (!ntfsRevoke.ok || !ntfsGrant.ok) {
      return { ok: true, warn: 'NTFS: ' + ((ntfsRevoke.error || ntfsGrant.error || '').slice(0, 150)) };
    }
  }
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
  NTFS_RIGHT,
  isManagedShare,
  listShares,
  listNtfs,
  listSessions,
  listOpenFiles,
  createShare,
  removeShare,
  closeSession,
  closeOpenFile,
  accessDiff,
  editAccess,
  parseAccess,
  applyNtfsGrant,
  applyNtfsRevoke,
};
