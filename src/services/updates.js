'use strict';

// Windows Update 已安装更新查看服务（只读）：Get-HotFix 枚举
// InstalledOn 为 DateTime，PS5 的 ConvertTo-Json 会输出 /Date(ms)/ 格式，
// 在 PowerShell 侧先统一格式化为 yyyy-MM-dd 再输出 JSON

const ps = require('./powershell');

// 已安装更新列表（desc/id/on/by），按安装日期降序
async function listHotfix(timeoutMs, t) {
  const cmd = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
    + 'Get-HotFix | Sort-Object InstalledOn -Descending | ForEach-Object { '
    + '[pscustomobject]@{ desc=[string]$_.Description; id=[string]$_.HotFixID; '
    + 'on=$(if ($_.InstalledOn) { $_.InstalledOn.ToString(\'yyyy-MM-dd\') } else { \'\' }); '
    + 'by=[string]$_.InstalledBy } } | ConvertTo-Json -Compress';
  const r = await ps.execute(cmd, { timeoutMs, sessionKey: 'updates-mgmt' });
  if (!r.ok) throw new Error(t('updates.listFailed').replace('{n}', String(r.output || '').slice(0, 200)));
  const raw = String(r.output || '').trim();
  if (!raw) return [];
  const data = JSON.parse(raw);
  const rows = Array.isArray(data) ? data : [data];
  return rows.map((row) => ({
    desc: String(row.desc || ''),
    id: String(row.id || ''),
    on: String(row.on || ''),
    by: String(row.by || ''),
  }));
}

module.exports = { listHotfix };
