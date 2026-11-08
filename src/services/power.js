'use strict';

// 重启/关机管理：本机操作（shutdown.exe 延迟计划 + 可中止）与远程操作（DCOM/WMI 优先，WinRM 可选）
// 动态值（理由/目标/账号/密码）全部 env 注入，绝不拼接进命令串；密码不落日志、不进审计
const ps = require('./powershell');

const OPS = ['restart', 'shutdown'];
const CHANNELS = ['dcom', 'winrm'];
const DELAY_MAX = 600; // 秒（10 分钟，留足中止窗口）
const REASON_MAX = 200; // shutdown /c 上限 512，取保守值
const HOST_RE = /^[A-Za-z0-9._\-]{1,100}$/; // 主机名 / IPv4（IPv6 含冒号不适用 shutdown /m 语法，不支持）
const USER_RE = /^[A-Za-z0-9._\- \\@]{1,100}$/; // 支持 DOMAIN\user 与 user@domain

// Win32_OperatingSystem.Win32ShutdownTracker Flags：2=重启 1=关机 8=断电，+4=强制
const FLAGS = { restart: 6, shutdown: 12 };
const OP_FLAG = { restart: '/r', shutdown: '/s' };

// PSCredential 构造（密码走 env:WRA_PWR_PWD，进程环境变量不落命令日志）
const CRED = '$c = New-Object System.Management.Automation.PSCredential($env:WRA_PWR_USER, '
  + '(ConvertTo-SecureString $env:WRA_PWR_PWD -AsPlainText -Force)); ';

// 关机/重启动作公共校验
function validOp(op) { return OPS.includes(op); }
function validDelay(n) { return Number.isInteger(n) && n >= 0 && n <= DELAY_MAX; }
function validHost(h) { return HOST_RE.test(h); }
function validUser(u) { return USER_RE.test(u); }
function validReason(r) { return r.length <= REASON_MAX; }

// 本机：shutdown.exe 延迟计划（事件 1074 记录理由，/d p:4:1 计划内维护）
// 哨兵判定：statement 级错误非终止性，退出码不可靠，必须以 stdout 的 WRA_OK 为准
function localShutdown(op, delay, reason, t) {
  const cmd = '& "$env:SystemRoot\\System32\\shutdown.exe" ' + OP_FLAG[op]
    + ' /t ' + delay + ' /c $env:WRA_PWR_REASON /d p:4:1; '
    + 'if ($LASTEXITCODE -eq 0) { \'WRA_OK\' } else { \'WRA_ERR: shutdown exit \' + $LASTEXITCODE }';
  return ps.execute(cmd, { fresh: true, timeoutMs: 30000, env: { WRA_PWR_REASON: reason || '' } })
    .then(parseSentinel);
}

// 统一解析哨兵输出：WRA_OK=成功；WRA_ERR: 后跟错误消息（stdout UTF8，无 stderr 乱码问题）
function parseSentinel(r) {
  const out = String(r.output || '');
  if (out.includes('WRA_OK')) return { ok: true, error: null };
  const m = out.match(/WRA_ERR:\s*([\s\S]{0,200})/);
  return { ok: false, error: (m ? m[1] : out.slice(0, 200)).trim() || 'unknown error' };
}

// 中止已计划的关机（shutdown /a）；无待执行计划时 exitCode 非零
function abortShutdown(t) {
  const cmd = '& "$env:SystemRoot\\System32\\shutdown.exe" /a; '
    + 'if ($LASTEXITCODE -eq 0) { \'WRA_ABORTED\' } else { exit 1116 }';
  return ps.execute(cmd, { fresh: true, timeoutMs: 30000 })
    .then((r) => ({ ok: !!r.ok, none: !r.ok, error: r.ok ? null : String(r.output || '').slice(0, 200) }));
}

// 远程：DCOM/WMI（Win32ShutdownTracker 自带延迟 + 理由；目标机需放行 RPC 135）
// 注意：Invoke-CimMethod 没有 -Credential 参数，必须经 New-CimSession（DCOM 协议）携带凭据
function remoteDcom(op) {
  return CRED
    + 'try { $s = New-CimSession -ComputerName $env:WRA_PWR_TARGET -Credential $c '
    + '-SessionOption (New-CimSessionOption -Protocol DCOM) -ErrorAction Stop; '
    + 'Invoke-CimMethod -ClassName Win32_OperatingSystem -MethodName Win32ShutdownTracker -CimSession $s '
    + '-Arguments @{ Timeout = [uint32]$env:WRA_PWR_DELAY; Comment = $env:WRA_PWR_REASON; Flags = [uint32]' + FLAGS[op] + ' } '
    + '-ErrorAction Stop | Out-Null; Remove-CimSession $s; \'WRA_OK\' } '
    + 'catch { \'WRA_ERR: \' + ($_.Exception.Message -replace "\\s+", " ") }';
}

// 远程：WinRM（Invoke-Command 原生支持 -Credential；目标机需启用 WinRM 5985；参数经 ArgumentList 传入远端会话）
function remoteWinrm(op) {
  return CRED
    + 'try { Invoke-Command -ComputerName $env:WRA_PWR_TARGET -Credential $c -ErrorAction Stop '
    + '-ArgumentList ([uint32]$env:WRA_PWR_DELAY, $env:WRA_PWR_REASON, \'' + OP_FLAG[op] + '\') '
    + '-ScriptBlock { param($d, $r, $f) & "$env:SystemRoot\\System32\\shutdown.exe" $f /t $d /c $r /d p:4:1 }; \'WRA_OK\' } '
    + 'catch { \'WRA_ERR: \' + ($_.Exception.Message -replace "\\s+", " ") }';
}

// 远程统一入口：注入全部动态值后按通道分发
function remoteShutdown(target, user, pwd, op, delay, reason, channel, t) {
  const env = {
    WRA_PWR_TARGET: target,
    WRA_PWR_USER: user,
    WRA_PWR_PWD: pwd,
    WRA_PWR_DELAY: String(delay),
    WRA_PWR_REASON: reason || '',
  };
  const cmd = channel === 'winrm' ? remoteWinrm(op) : remoteDcom(op);
  return ps.execute(cmd, { fresh: true, timeoutMs: 60000, env })
    .then(parseSentinel);
}

// 连通性预检：DCOM 探 TCP 135（3 秒超时）；WinRM 用 Test-WSMan
function probe(target, channel, t) {
  const cmd = channel === 'winrm'
    ? 'try { Test-WSMan -ComputerName $env:WRA_PWR_TARGET -ErrorAction Stop | Out-Null; \'WRA_REACH\' } catch { \'WRA_UNREACH\' }'
    : '$c = New-Object System.Net.Sockets.TcpClient; '
    + '$t = $c.BeginConnect($env:WRA_PWR_TARGET, 135, $null, $null); '
    + 'if ($t.AsyncWaitHandle.WaitOne(3000) -and $c.Connected) { \'WRA_REACH\' } else { \'WRA_UNREACH\' }; '
    + '$c.Close()';
  return ps.execute(cmd, { fresh: true, timeoutMs: 30000, env: { WRA_PWR_TARGET: target } })
    .then((r) => {
      const out = String(r.output || '');
      const ok = !!r.ok && out.includes('WRA_REACH');
      const err = ok ? null
        : (out.includes('WRA_UNREACH') ? t('p.unreach')
          : (out.trim().slice(0, 200) || t('p.unreach')));
      return { ok, error: err };
    });
}

// 近 24h 关机/重启事件（System 日志 1074：操作发起者、理由、类型），页面展示与审计闭环
async function recentEvents(t) {
  const cmd = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
    + '$ev = @(Get-WinEvent -FilterHashtable @{ LogName=\'System\'; Id=1074; StartTime=(Get-Date).AddHours(-24) } '
    + '-MaxEvents 8 -ErrorAction SilentlyContinue | ForEach-Object { '
    + '[pscustomobject]@{ time = $_.TimeCreated.ToString(\'MM-dd HH:mm:ss\'); '
    + 'msg = ([string]$_.Message -replace "\\s+", " ") } }); '
    + '@{ n = $ev.Count; r = $ev } | ConvertTo-Json -Compress -Depth 3';
  const r = await ps.execute(cmd, { sessionKey: 'pw-mgmt', timeoutMs: 30000 });
  if (!r.ok) throw new Error(t('p.recentErr') + ' ' + String(r.output || '').slice(0, 160));
  const raw = String(r.output || '').trim();
  if (!raw) return [];
  const data = JSON.parse(raw);
  return Array.isArray(data.r) ? data.r : [data.r].filter(Boolean);
}

module.exports = {
  OPS, CHANNELS, DELAY_MAX, REASON_MAX,
  validOp, validDelay, validHost, validUser, validReason,
  localShutdown, abortShutdown, remoteShutdown, probe, recentEvents,
};
