'use strict';

// 环境变量服务：Machine / User 两级读写
// 动态值（变量名/值/作用域）经 fresh 模式 spawn env 注入 + $env:XXX 引用，绝不拼接进命令串

const ps = require('./powershell');

// 作用域白名单（前端只传短名）
const SCOPES = new Set(['Machine', 'User']);
// 系统关键变量：禁止删除（大小写不敏感）
const CRITICAL_VARS = new Set([
  'path', 'pathext', 'os', 'systemroot', 'windir', 'comspec', 'systemdrive',
  'programdata', 'programfiles', 'programfiles(x86)', 'programw6432',
  'processor_architecture', 'number_of_processors', 'driverdata',
  'temp', 'tmp', 'username', 'userprofile', 'homedrive', 'homepath',
  'allusersprofile', 'appdata', 'localappdata', 'commonprogramfiles',
  'psmodulepath', 'public', 'sessionname', 'computername',
]);
// 敏感变量名：值默认打码（查看走 /env/reveal 且审计）
const SENSITIVE_RE = /pass|pwd|token|secret|key|credential|apikey/i;

const NAME_RE = /^[A-Za-z0-9_.\-\s()]{1,255}$/;
const MAX_VALUE_LEN = 32000; // 注册表单值上限约 32KB

function isCritical(name) {
  return CRITICAL_VARS.has(String(name || '').toLowerCase());
}
function isSensitive(name) {
  return SENSITIVE_RE.test(String(name || ''));
}

// 拉取一个作用域的变量列表（name/value，按名称排序）
async function listEnv(scope, timeoutMs, t) {
  if (!SCOPES.has(scope)) throw new Error(t('env.invalidScope'));
  const cmd = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
    + `$d=[Environment]::GetEnvironmentVariables('${scope}'); `
    + '$d.Keys | ForEach-Object { [pscustomobject]@{ name=$_; value=[string]$d[$_] } } '
    + '| Sort-Object name | ConvertTo-Json -Compress';
  const r = await ps.execute(cmd, { timeoutMs, sessionKey: 'env-mgmt' });
  if (!r.ok) throw new Error(t('env.listFailed').replace('{n}', String(r.output || '').slice(0, 200)));
  const raw = String(r.output || '').trim();
  if (!raw) return [];
  const data = JSON.parse(raw);
  return Array.isArray(data) ? data : [data];
}

// 新增/修改变量（value 非空；置空请走删除）
async function setEnv(name, value, scope, t) {
  if (!SCOPES.has(scope)) throw new Error(t('env.invalidScope'));
  if (!NAME_RE.test(name)) throw new Error(t('env.invalidName'));
  if (!value || String(value).length > MAX_VALUE_LEN) throw new Error(t('env.invalidValue').replace('{n}', String(MAX_VALUE_LEN)));
  const cmd = '[Environment]::SetEnvironmentVariable($env:WRA_ENV_NAME, $env:WRA_ENV_VALUE, $env:WRA_ENV_SCOPE); '
    + 'if ($?) { "OK" } else { throw "set failed" }';
  const r = await ps.execute(cmd, {
    timeoutMs: 20000, fresh: true,
    env: { WRA_ENV_NAME: name, WRA_ENV_VALUE: String(value), WRA_ENV_SCOPE: scope },
  });
  return { ok: !!r.ok, error: r.ok ? null : String(r.output || '').slice(0, 200) };
}

// 删除变量（关键变量由路由拦截；此处再次防御）
async function deleteEnv(name, scope, t) {
  if (!SCOPES.has(scope)) throw new Error(t('env.invalidScope'));
  if (!NAME_RE.test(name)) throw new Error(t('env.invalidName'));
  if (isCritical(name)) throw new Error(t('env.criticalProtected'));
  const cmd = '[Environment]::SetEnvironmentVariable($env:WRA_ENV_NAME, $null, $env:WRA_ENV_SCOPE); '
    + 'if ($?) { "OK" } else { throw "delete failed" }';
  const r = await ps.execute(cmd, {
    timeoutMs: 20000, fresh: true,
    env: { WRA_ENV_NAME: name, WRA_ENV_SCOPE: scope },
  });
  return { ok: !!r.ok, error: r.ok ? null : String(r.output || '').slice(0, 200) };
}

// 单变量原值（敏感信息查看，调用方须审计）
async function getEnv(name, scope, t) {
  if (!SCOPES.has(scope)) throw new Error(t('env.invalidScope'));
  if (!NAME_RE.test(name)) throw new Error(t('env.invalidName'));
  const cmd = `[Environment]::GetEnvironmentVariable($env:WRA_ENV_NAME, '${scope}')`;
  const r = await ps.execute(cmd, { timeoutMs: 20000, fresh: true, env: { WRA_ENV_NAME: name } });
  if (!r.ok) throw new Error(String(r.output || '').slice(0, 200));
  return { value: String(r.output || '') };
}

module.exports = {
  SCOPES,
  NAME_RE,
  MAX_VALUE_LEN,
  isCritical,
  isSensitive,
  listEnv,
  setEnv,
  deleteEnv,
  getEnv,
};
