'use strict';

// DNS / hosts 服务：
// - hosts 文件路径固定 C:\Windows\System32\drivers\etc\hosts，不开放自定义路径
// - hosts 读写走 node fs（服务进程具备相应权限；与编辑器/文件管理一致），写前自动时间戳备份
// - DNS 客户端缓存查看（Get-DnsClientCache）/ 清空（Clear-DnsClientCache）走 PowerShell
//   动态值不涉及（无参数命令），JSON stdout 解析与 envvars 同款

const fsp = require('node:fs/promises');
const path = require('node:path');
const ps = require('./powershell');

// hosts 文件固定路径（系统目录，不开放自定义）
const HOSTS_PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
// 备份上限：保留最近 N 份，超出自动清理最旧（防 etc 目录无限膨胀）
const MAX_BACKUPS = 20;
// 单次保存内容上限（hosts 文件实际通常几 KB，留足余量）
const MAX_CONTENT_LEN = 512 * 1024;

// DNS 记录类型号 → 名称（RFC 常见类型；未知类型回退 type(n)）
const TYPE_NAMES = {
  1: 'A', 2: 'NS', 5: 'CNAME', 6: 'SOA', 12: 'PTR', 15: 'MX',
  16: 'TXT', 28: 'AAAA', 33: 'SRV', 35: 'NAPTR', 39: 'DNAME',
  43: 'DS', 46: 'RRSIG', 47: 'NSEC', 48: 'DNSKEY', 65: 'HTTPS',
};
function typeName(n) {
  const t = Number(n) || 0;
  return TYPE_NAMES[t] || `type(${t})`;
}

// 读取 hosts 文件全文（utf8）
async function readHosts() {
  return fsp.readFile(HOSTS_PATH, 'utf8');
}

// 保存 hosts：先时间戳备份（hosts.bak-yyyyMMdd-HHmmss），再经临时文件原子替换
// 调用方须先做权限与审计；返回备份文件名
async function writeHosts(content) {
  const text = String(content == null ? '' : content);
  if (text.length > MAX_CONTENT_LEN) throw new Error(`content too large (>${MAX_CONTENT_LEN})`);
  if (!text.endsWith('\n')) text += '\n';
  const dir = path.dirname(HOSTS_PATH);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // yyyyMMddHHmmss(UTC)
  const bakName = `hosts.bak-${stamp.slice(0, 8)}-${stamp.slice(8)}`;
  await fsp.copyFile(HOSTS_PATH, path.join(dir, bakName));
  // 写临时文件后 rename 替换，避免半写状态（同目录保证同卷）
  const tmp = path.join(dir, `hosts.wra-tmp-${process.pid}`);
  await fsp.writeFile(tmp, text, 'utf8');
  try {
    await fsp.rename(tmp, HOSTS_PATH);
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
  // 清理最旧的备份，仅保留 MAX_BACKUPS 份
  try {
    const bakFiles = (await fsp.readdir(dir))
      .filter((f) => /^hosts\.bak-\d{8}-\d{6}$/.test(f))
      .sort();
    for (const f of bakFiles.slice(0, Math.max(0, bakFiles.length - MAX_BACKUPS))) {
      await fsp.unlink(path.join(dir, f)).catch(() => {});
    }
  } catch { /* 清理失败不影响保存结果 */ }
  return bakName;
}

// 列出 etc 目录下现有 hosts 备份（名称 + 大小 + 修改时间，降序）
async function listBackups() {
  const dir = path.dirname(HOSTS_PATH);
  const names = (await fsp.readdir(dir)).filter((f) => /^hosts\.bak-\d{8}-\d{6}$/.test(f));
  const items = [];
  for (const name of names) {
    try {
      const st = await fsp.stat(path.join(dir, name));
      items.push({ name, size: st.size, mtime: st.mtime.toISOString().replace('T', ' ').slice(0, 19) });
    } catch { /* 文件可能已被并发清理 */ }
  }
  return items.sort((a, b) => (a.name < b.name ? 1 : -1));
}

// DNS 客户端缓存列表（entry/data/type/ttl）
async function listCache(timeoutMs, t) {
  const cmd = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
    + '$c=Get-DnsClientCache; '
    + '$c | ForEach-Object { [pscustomobject]@{ entry=[string]$_.Entry; data=[string]$_.Data; type=$_.Type; ttl=$_.TimeToLive } } '
    + '| ConvertTo-Json -Compress';
  const r = await ps.execute(cmd, { timeoutMs, sessionKey: 'dns-mgmt' });
  if (!r.ok) throw new Error(t('dns.cacheFailed').replace('{n}', String(r.output || '').slice(0, 200)));
  const raw = String(r.output || '').trim();
  if (!raw) return [];
  const data = JSON.parse(raw);
  const rows = Array.isArray(data) ? data : [data];
  return rows.map((row) => ({
    entry: String(row.entry || ''),
    data: String(row.data || ''),
    type: typeName(row.type),
    ttl: Number(row.ttl) || 0,
  }));
}

// 清空 DNS 缓存（Clear-DnsClientCache，无参数命令）
async function flushCache(timeoutMs, t) {
  const r = await ps.execute('Clear-DnsClientCache; if ($?) { "OK" }', { timeoutMs, sessionKey: 'dns-mgmt' });
  return { ok: !!r.ok, error: r.ok ? null : String(r.output || '').slice(0, 200) };
}

module.exports = {
  HOSTS_PATH,
  MAX_CONTENT_LEN,
  typeName,
  readHosts,
  writeHosts,
  listBackups,
  listCache,
  flushCache,
};
