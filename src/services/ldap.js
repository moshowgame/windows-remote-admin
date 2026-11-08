'use strict';

// 企业级 LDAP / AD 认证服务（零 npm 依赖：PowerShell 调 .NET）
// - type=ad：System.DirectoryServices.AccountManagement.PrincipalContext('Domain').ValidateCredentials
// - type=ldap：System.DirectoryServices.Protocols.LdapConnection + bindTemplate（如 CORP\{username} 或 uid={username},ou=people,dc=corp）
// - 密码经 spawn 环境变量注入（WRA_LDAP_USER / WRA_LDAP_PASS），绝不进命令串 / 日志
// - 认证成功后查询组（AD: memberOf；通用 LDAP: groupFilter 模板）供组角色映射
// - 角色映射：data/auth-map.csv（staffid,role），每次登录读盘（改完即生效）；
//   优先级 staffid 精确匹配 > 组匹配 > 默认拒绝（未映射 = 无法登录）
// - 错误码语义（LdapConnection）：49=凭据错误；81=服务不可达（可触发本地回退）；53=拒绝；其余=拒绝
const fs = require('node:fs');
const path = require('node:path');
const powershell = require('./powershell');

const MAP_FILE = 'auth-map.csv';
const AUTH_TIMEOUT_MS = 15000; // LDAP 认证超时（含 PowerShell 进程启动）

// ---- 结果状态常量 ----
// ok            认证成功（返回 groups）
// bad-credentials  凭据错误（49 / 校验 false / 密码为空）：直接拒绝，绝不兜底
// denied        服务端明确拒绝（53 等）：直接拒绝，不兜底
// unavailable   服务不可达 / 超时（81 类）：视 allowLocalFallback 决定是否回退本地账号
const OK = 'ok';
const BAD_CREDENTIALS = 'bad-credentials';
const DENIED = 'denied';
const UNAVAILABLE = 'unavailable';

// RFC 4515 过滤器转义：防止用户名注入 LDAP 搜索过滤器
function escapeFilter(text) {
  return String(text)
    .replace(/[\\\u0000]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'))
    .replace(/\*/g, '\\2a')
    .replace(/\(/g, '\\28')
    .replace(/\)/g, '\\29');
}

// JSON stdout 解析：PS 输出可能混入警告行，取首个 { ... } 片段
function parseResult(output) {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`LDAP 认证器输出无法解析：${output.slice(0, 200)}`);
  }
  return JSON.parse(output.slice(start, end + 1));
}

// 生成认证脚本（Base64 后经 freshExecute 执行；凭据只走环境变量）
function buildScript(cfg, bindUser, escapedName) {
  const type = cfg.type === 'ldap' ? 'ldap' : 'ad';
  if (type === 'ad') {
    // AD：PrincipalContext 校验凭据；成功后 DirectorySearcher 查 memberOf 组
    return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.DirectoryServices.AccountManagement
Add-Type -AssemblyName System.DirectoryServices
$u = $env:WRA_LDAP_USER
$p = $env:WRA_LDAP_PASS
if (-not $u -or -not $p) { [Console]::Out.WriteLine('{"ok":false,"errorCode":-1,"groups":[],"empty":true}'); exit }
$host_ = '${cfg.host}'
try {
  $ctx = New-Object System.DirectoryServices.AccountManagement.PrincipalContext(
    [System.DirectoryServices.AccountManagement.ContextType]::Domain, $host_)
  $ok = $ctx.ValidateCredentials($u, $p)
  if (-not $ok) { [Console]::Out.WriteLine('{"ok":false,"errorCode":49,"groups":[]}'); exit }
  $groups = @()
  try {
    $searcher = New-Object System.DirectoryServices.DirectorySearcher
    $searcher.Filter = '(&(objectClass=user)(sAMAccountName=${escapedName}))'
    $searcher.PropertiesToLoad.Add('memberOf') | Out-Null
    $entry = $searcher.FindOne()
    if ($entry) {
      foreach ($dn in $entry.Properties['memberof']) {
        $m = [regex]::Match($dn, 'CN=([^,]+)')
        if ($m.Success) { $groups += $m.Groups[1].Value }
      }
    }
  } catch { }
  $out = @{ ok = $true; errorCode = $null; groups = $groups } | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($out)
} catch {
  $code = 81
  if ($_.Exception.ErrorCode) { $code = [int]$_.Exception.ErrorCode }
  $out = @{ ok = $false; errorCode = $code; groups = @() } | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($out)
}`.trim();
  }
  // 通用 LDAP：LdapConnection 绑定 bindTemplate；成功后按 groupFilter 模板搜索组
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.DirectoryServices.Protocols
$u = $env:WRA_LDAP_USER
$p = $env:WRA_LDAP_PASS
if (-not $u -or -not $p) { [Console]::Out.WriteLine('{"ok":false,"errorCode":-1,"groups":[],"empty":true}'); exit }
try {
  $conn = New-Object System.DirectoryServices.Protocols.LdapConnection('${cfg.url}')
  $conn.SessionOptions.SecureSocketLayer = (${JSON.stringify(cfg.ssl)})
  $conn.AuthType = [System.DirectoryServices.Protocols.AuthType]::Basic
  $conn.Timeout = New-TimeSpan -Seconds 10
  $nc = New-Object System.Net.NetworkCredential($u, $p)
  $conn.Bind($nc)
  $groups = @()
  $filter = '${cfg.groupFilter}'
  $baseDN = '${cfg.baseDN}'
  if ($filter -and $baseDN) {
    $req = New-Object System.DirectoryServices.Protocols.SearchRequest($baseDN, $filter, [System.DirectoryServices.Protocols.SearchScope]::Subtree)
    $req.Attributes.Add('cn') | Out-Null
    $rsp = $conn.SendRequest($req)
    foreach ($e in $rsp.Entries) {
      foreach ($v in $e.Attributes['cn']) { $groups += [string]$v }
    }
  }
  $out = @{ ok = $true; errorCode = $null; groups = $groups } | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($out)
} catch [System.DirectoryServices.Protocols.LdapException] {
  $out = @{ ok = $false; errorCode = [int]$_.Exception.ErrorCode; groups = @() } | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($out)
} catch {
  $out = @{ ok = $false; errorCode = 81; groups = @() } | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($out)
}`.trim();
}

// 分类 PS 结果 → 统一状态
function classify(r) {
  if (r && r.ok) {
    // PS 5.1 ConvertTo-Json 单元素数组会退化为标量，这里统一包回数组
    const g = r.groups == null ? [] : (Array.isArray(r.groups) ? r.groups : [r.groups]);
    return { status: OK, groups: g.map(String) };
  }
  const code = Number(r && r.errorCode);
  if (r && r.empty) return { status: BAD_CREDENTIALS, errorCode: 0 }; // 密码为空：不发起请求直接拒绝
  if (code === 49) return { status: BAD_CREDENTIALS, errorCode: code };
  if (code === 81 || code === -1) return { status: UNAVAILABLE, errorCode: code };
  if (code === 53) return { status: DENIED, errorCode: code };
  return { status: DENIED, errorCode: code };
}

// LDAP/AD 认证：返回 { status, groups, errorCode }
// cfg：app.config.auth.ldap（url / type / bindTemplate / staffidAttr / baseDN / groupFilter）
async function authenticate(cfg, username, password) {
  const ldapCfg = cfg || {};
  const type = ldapCfg.type === 'ldap' ? 'ldap' : 'ad';
  const host = (() => {
    const url = String(ldapCfg.url || '');
    const m = url.match(/^[a-z]+:\/\/([^:/]+)/i);
    return m ? m[1] : url;
  })();
  const ssl = /^ldaps:/i.test(String(ldapCfg.url || ''));
  const bindUser = type === 'ldap'
    ? String(ldapCfg.bindTemplate || '').replace(/\{username\}/g, username)
    : username;
  const filterTpl = String(ldapCfg.groupFilter || '');
  const groupFilter = filterTpl.replace(/\{username\}/g, escapeFilter(username));

  // 配置不完整：视为服务不可用（走回退路径并给出可诊断日志）
  if (!ldapCfg.url || (type === 'ldap' && !bindUser)) {
    return { status: UNAVAILABLE, errorCode: 81, configError: true };
  }

  const script = buildScript(
    { host, url: String(ldapCfg.url), ssl, groupFilter, baseDN: String(ldapCfg.baseDN || '') },
    bindUser,
    escapeFilter(username),
  );
  const res = await powershell.freshExecute(script, {
    timeoutMs: AUTH_TIMEOUT_MS,
    // WRA_LDAP_USER 即绑定账号：ad 模式为用户名，ldap 模式为 bindTemplate 展开结果；
    // 密码只走环境变量，不进命令串 / 日志
    env: {
      WRA_LDAP_USER: bindUser,
      WRA_LDAP_PASS: String(password),
    },
  });
  if (!res.ok && !res.output) {
    // PS 进程都起不来 / 超时：归为服务不可用
    return { status: UNAVAILABLE, errorCode: 81, detail: res.output || res.exitCode };
  }
  try {
    return classify(parseResult(res.output || ''));
  } catch (err) {
    return { status: UNAVAILABLE, errorCode: 81, detail: err.message };
  }
}

// ---- auth-map.csv 角色映射 ----
// 格式：staffid,role（admin / readonly）；# 开头行为注释；表头（staffid,role）忽略
function parseMap(content) {
  const rows = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(',');
    if (idx <= 0) continue;
    const staffid = trimmed.slice(0, idx).trim();
    const role = trimmed.slice(idx + 1).trim().toLowerCase();
    if (/^staffid$/i.test(staffid)) continue; // 表头行
    if (!staffid || (role !== 'admin' && role !== 'readonly')) continue;
    rows.push({ staffid, role });
  }
  return rows;
}

// 查映射：staffid 精确匹配 > 组匹配（groupRoleMap：[{group, role}]）> null（默认拒绝）
function mapRole(dataDir, staffid, groups, groupRoleMap) {
  const file = path.join(dataDir, MAP_FILE);
  let rows = [];
  try {
    if (fs.existsSync(file)) rows = parseMap(fs.readFileSync(file, 'utf8'));
  } catch {
    rows = [];
  }
  const hit = rows.find((r) => r.staffid === staffid);
  if (hit) return hit.role;
  const groupList = (groups || []).map((g) => String(g).toLowerCase());
  for (const gm of Array.isArray(groupRoleMap) ? groupRoleMap : []) {
    if (!gm || !gm.group || !gm.role) continue;
    if (groupList.includes(String(gm.group).toLowerCase())) {
      return gm.role === 'readonly' ? 'readonly' : 'admin';
    }
  }
  return null;
}

module.exports = { authenticate, mapRole, escapeFilter, parseMap, OK, BAD_CREDENTIALS, DENIED, UNAVAILABLE };
