'use strict';

// Windows 防火墙管理服务：配置文件状态 + 规则浏览/启停/新建/删除
// 动态值（规则 ID/名称/端口/描述）经 fresh 模式 spawn env 注入 + $env:XXX 引用，绝不拼接进命令串
// 规则枚举用 PortFilter InstanceID 批量映射（实测 496 规则 ~2s），避免逐规则管道查询的分钟级开销

const ps = require('./powershell');

// 规则 Name（内部键）白名单：系统生成的规则名以字母数字、点、下划线、连字符、花括号 GUID 组成
const RULE_ID_RE = /^[A-Za-z0-9._\-\{\}]{1,160}$/;
// 显示名称：禁止路径分隔与控制字符（允许中文/空格）
const RULE_NAME_RE = /^[^<>:"/\\|?*\u0000-\u001f]{1,120}$/;
// 本地端口列表：80,443,5000-6000 形式，最多 100 段（范围校验在函数内做）
const PORTS_RE = /^(\d{1,5}(-\d{1,5})?)(,\d{1,5}(-\d{1,5})?){0,99}$/;
const PROTOCOLS = ['TCP', 'UDP', 'ICMPv4', 'ICMPv6', 'Any'];
const DIRECTIONS = ['Inbound', 'Outbound'];
const ACTIONS = ['Allow', 'Block'];
const PROFILE_NAMES = ['Any', 'Domain', 'Private', 'Public'];

// Profiles 位掩码（UInt16）→ 名称数组：1=Domain 2=Private 4=Public；0 / 0x7FFFFFFF = Any
function profileNames(v) {
  const n = Number(v) || 0;
  if (n === 0 || n >= 2147483647) return ['Any'];
  const out = [];
  if (n & 1) out.push('Domain');
  if (n & 2) out.push('Private');
  if (n & 4) out.push('Public');
  return out.length ? out : ['Any'];
}

// 端口列表校验：格式 + 每段 1-65535、范围起<=止
function validPorts(raw) {
  if (!PORTS_RE.test(String(raw || ''))) return false;
  return String(raw).split(',').every((seg) => {
    if (!seg.includes('-')) return +seg >= 1 && +seg <= 65535;
    const [a, b] = seg.split('-').map(Number);
    return a >= 1 && b <= 65535 && a <= b;
  });
}

function rows(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  const d = JSON.parse(s);
  return Array.isArray(d) ? d : [d];
}

// ---- 浏览（持久会话，二次加载走预热缓存）----

// 三个配置文件（Domain/Private/Public）状态：启用 + 默认入站/出站动作
async function listProfiles(t) {
  const cmd = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
    + 'Get-NetFirewallProfile | ForEach-Object { '
    + '[pscustomobject]@{ name=[string]$_.Name; on=($_.Enabled.ToString() -eq \'True\'); '
    + 'in=[string]$_.DefaultInboundAction; out=[string]$_.DefaultOutboundAction } '
    + '} | ConvertTo-Json -Compress -Depth 2';
  const r = await ps.execute(cmd, { timeoutMs: 30000, sessionKey: 'fw-mgmt' });
  if (!r.ok) throw new Error(String(r.output || '').slice(0, 300));
  return rows(r.output);
}

// 全量规则（含端口信息）：PortFilter 批量映射后单次投影输出
async function listRules(t) {
  const cmd = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
    + '$pf = @{}; '
    + 'Get-NetFirewallPortFilter | ForEach-Object { $pf[[string]$_.InstanceID] = $_ }; '
    + 'Get-NetFirewallRule | Sort-Object DisplayName | ForEach-Object { '
    + '$p = $pf[[string]$_.InstanceID]; '
    + '$d = [string]$_.Description; if ($d.Length -gt 100) { $d = $d.Substring(0, 100) }; '
    + '[pscustomobject]@{ id=[string]$_.Name; name=$_.DisplayName; grp=[string]$_.Group; '
    + 'dir=[string]$_.Direction; act=[string]$_.Action; prof=[uint32][string]$_.Profiles; '
    + 'on=($_.Enabled.ToString() -eq \'True\'); '
    + 'proto=if ($p) { [string]$p.Protocol } else { \'\' }; '
    + 'lp=if ($p) { (@($p.LocalPort) | Where-Object { $_ -and $_ -ne \'Any\' }) -join \',\' } else { \'\' }; '
    + 'desc=$d } '
    + '} | ConvertTo-Json -Compress -Depth 2';
  const r = await ps.execute(cmd, { timeoutMs: 60000, sessionKey: 'fw-mgmt' });
  if (!r.ok) throw new Error(String(r.output || '').slice(0, 300));
  return rows(r.output).map((x) => ({ ...x, profNames: profileNames(x.prof) }));
}

// ---- 管理（全部 fresh + env 注入）----

// 启用/禁用规则（on = 'True'/'False'，PS 自动转 GpoBoolean 枚举）
async function toggleRule(id, on, t) {
  const r = await ps.execute('Set-NetFirewallRule -Name $env:WRA_FW_ID -Enabled $env:WRA_FW_ON', {
    timeoutMs: 30000, fresh: true, env: { WRA_FW_ID: id, WRA_FW_ON: on ? 'True' : 'False' },
  });
  if (!r.ok) return { ok: false, error: String(r.output || '').slice(0, 200) };
  return { ok: true };
}

// 新建规则：proto 为 TCP/UDP 时才允许端口；prof=Any 时省略（默认 Any）；ICMP 协议忽略端口
async function createRule(name, dir, act, proto, lport, prof, desc, t) {
  const env = {
    WRA_FW_NAME: name,
    WRA_FW_DIR: dir,
    WRA_FW_ACT: act,
    WRA_FW_PROTO: proto,
    WRA_FW_LP: (proto === 'TCP' || proto === 'UDP') && lport ? lport : '',
    WRA_FW_PROF: prof,
    WRA_FW_DESC: desc || '',
  };
  let cmd = '$p = @{ DisplayName = $env:WRA_FW_NAME; Direction = $env:WRA_FW_DIR; Action = $env:WRA_FW_ACT; Protocol = $env:WRA_FW_PROTO }';
  cmd += '; if ($env:WRA_FW_LP) { $p.LocalPort = ($env:WRA_FW_LP -split \',\') }';
  cmd += '; if ($env:WRA_FW_PROF -ne \'Any\') { $p.Profile = ($env:WRA_FW_PROF -split \',\') }';
  cmd += '; if ($env:WRA_FW_DESC) { $p.Description = $env:WRA_FW_DESC }';
  cmd += '; New-NetFirewallRule @p | Out-Null';
  const r = await ps.execute(cmd, { timeoutMs: 30000, fresh: true, env });
  if (!r.ok) return { ok: false, error: String(r.output || '').slice(0, 200) };
  return { ok: true };
}

// 删除规则（按规则 Name 内部键）
async function deleteRule(id, t) {
  const r = await ps.execute('Remove-NetFirewallRule -Name $env:WRA_FW_ID', {
    timeoutMs: 30000, fresh: true, env: { WRA_FW_ID: id },
  });
  if (!r.ok) return { ok: false, error: String(r.output || '').slice(0, 200) };
  return { ok: true };
}

// 启用/禁用配置文件（高危：整个防火墙域开关，路由层必须确认框 + 审计）
async function toggleProfile(name, on, t) {
  const r = await ps.execute('Set-NetFirewallProfile -Name $env:WRA_FW_PROF -Enabled $env:WRA_FW_ON', {
    timeoutMs: 30000, fresh: true, env: { WRA_FW_PROF: name, WRA_FW_ON: on ? 'True' : 'False' },
  });
  if (!r.ok) return { ok: false, error: String(r.output || '').slice(0, 200) };
  return { ok: true };
}

module.exports = {
  RULE_ID_RE,
  RULE_NAME_RE,
  PROTOCOLS,
  DIRECTIONS,
  ACTIONS,
  PROFILE_NAMES,
  profileNames,
  validPorts,
  listProfiles,
  listRules,
  toggleRule,
  createRule,
  deleteRule,
  toggleProfile,
};
