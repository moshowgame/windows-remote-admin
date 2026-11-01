'use strict';

// 证书服务：LocalMachine 常用存储区的浏览 / 详情 / 导入 / 导出 / 删除
// 动态值（存储区/指纹/密码/临时文件路径）经 fresh 模式 spawn env 注入 + $env:XXX 引用，绝不拼接进命令串

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ps = require('./powershell');

// 存储区白名单（仅 LocalMachine）
const STORES = new Set(['My', 'WebHosting', 'Root', 'CA', 'TrustedPeople', 'TrustedPublisher']);
// SHA-1 指纹
const TP_RE = /^[0-9a-fA-F]{40}$/;
// pfx 导出密码有效期（秒），超时未下载作废
const PWD_TTL_MS = 5 * 60 * 1000;

// 指纹→密码 一次性缓存（仅内存，服务重启作废）
const pfxTokens = new Map();

function storePath(store) {
  return `Cert:\\LocalMachine\\${store}`;
}

// 证书字段投影：For-EachObject 脚本块体（先算变量再进 pscustomobject——try 语句不能直接作哈希表值）
function selectFields() {
  return [
    '$san = (($_.Extensions | Where-Object { $_.Oid.FriendlyName -eq "Subject Alternative Name" } | ForEach-Object { $_.Format($false) }) -join ";");',
    '$eku = (($_.Extensions | Where-Object { $_.Oid.FriendlyName -match "Enhanced Key Usage" } | ForEach-Object { ($_.EnhancedKeyUsages | ForEach-Object { $_.FriendlyName }) }) -join ";");',
    '$alg = try { [string]$_.PublicKey.Oid.FriendlyName } catch { "" };',
    '$ks = try { [int]$_.PublicKey.Key.KeySize } catch { 0 };',
    '[pscustomobject]@{ tp=$_.Thumbprint; subj=$_.Subject; iss=$_.Issuer; nb=$_.NotBefore.ToString("s"); na=$_.NotAfter.ToString("s"); sn=$_.SerialNumber; pk=[bool]$_.HasPrivateKey; self=($_.Subject -eq $_.Issuer); alg=$alg; ks=$ks; san=$san; eku=$eku }',
  ].join(' ');
}

// 列表：按到期日升序（最紧急在前）
async function listCerts(store, timeoutMs, t) {
  if (!STORES.has(store)) throw new Error(t('certs.invalidStore'));
  const cmd = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
    + `Get-ChildItem ${storePath(store)} -ErrorAction Stop | ForEach-Object { ${selectFields()} } `
    + '| Sort-Object na | ConvertTo-Json -Compress';
  const r = await ps.execute(cmd, { timeoutMs, sessionKey: 'cert-mgmt' });
  if (!r.ok) throw new Error(t('certs.listFailed').replace('{n}', String(r.output || '').slice(0, 200)));
  const raw = String(r.output || '').trim();
  if (!raw) return [];
  const data = JSON.parse(raw);
  return Array.isArray(data) ? data : [data];
}

// 单证书详情
async function getCert(store, thumbprint, timeoutMs, t) {
  if (!STORES.has(store)) throw new Error(t('certs.invalidStore'));
  if (!TP_RE.test(thumbprint)) throw new Error(t('certs.invalidTp'));
  const cmd = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
    + `Get-ChildItem ${storePath(store)} -ErrorAction Stop | Where-Object Thumbprint -eq $env:WRA_CERT_TP `
    + `| ForEach-Object { ${selectFields()} } | ConvertTo-Json -Compress`;
  // env 注入按调用生效 → 必须 fresh（长驻会话进程的 env 在启动时固定）
  const r = await ps.execute(cmd, { timeoutMs, fresh: true, env: { WRA_CERT_TP: thumbprint } });
  if (!r.ok) throw new Error(String(r.output || '').slice(0, 200));
  const raw = String(r.output || '').trim();
  return raw ? JSON.parse(raw) : null;
}

// 导出：kind = cer（DER 公钥）| pem（PEM 公钥文本）| pfx（含私钥，pwd 保护）；返回 Buffer + pfx 密码
async function exportCert(store, thumbprint, kind, t) {
  if (!STORES.has(store)) throw new Error(t('certs.invalidStore'));
  if (!TP_RE.test(thumbprint)) throw new Error(t('certs.invalidTp'));
  if (!['cer', 'pem', 'pfx'].includes(kind)) throw new Error(t('certs.invalidKind'));

  let cmd;
  const env = { WRA_CERT_TP: thumbprint };
  if (kind === 'pfx') {
    const pwd = 'W' + Math.random().toString(36).slice(2, 12) + '!7Xz';
    env.WRA_CERT_PWD = pwd;
    cmd = `$c = Get-ChildItem ${storePath(store)} | Where-Object Thumbprint -eq $env:WRA_CERT_TP; `
      + 'if (-not $c) { throw "not found" }; '
      + 'if (-not $c.HasPrivateKey) { throw "no private key" }; '
      + '[Convert]::ToBase64String($c.Export("Pfx", $env:WRA_CERT_PWD))';
  } else {
    cmd = `$c = Get-ChildItem ${storePath(store)} | Where-Object Thumbprint -eq $env:WRA_CERT_TP; `
      + 'if (-not $c) { throw "not found" }; '
      + '[Convert]::ToBase64String($c.Export("Cert"))';
  }
  const r = await ps.execute(cmd, { timeoutMs: 30000, fresh: true, env });
  if (!r.ok) throw new Error(String(r.output || '').slice(0, 300));
  const b64 = String(r.output || '').trim();
  const buf = Buffer.from(b64, 'base64');
  if (kind === 'pem') {
    const pem = '-----BEGIN CERTIFICATE-----\r\n' + b64.replace(/(.{64})/g, '$1\r\n') + '-----END CERTIFICATE-----\r\n';
    return { buf: Buffer.from(pem, 'utf8'), pwd: null };
  }
  return { buf, pwd: kind === 'pfx' ? env.WRA_CERT_PWD : null };
}

// pfx 一次性下载令牌（密码先返回给用户，文件随后凭 token 下载）
function issuePfxToken(store, thumbprint) {
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  pfxTokens.set(token, { store, thumbprint, ts: Date.now() });
  // 顺带清过期
  for (const [k, v] of pfxTokens) {
    if (Date.now() - v.ts > PWD_TTL_MS) pfxTokens.delete(k);
  }
  return token;
}
function takePfxToken(token) {
  const v = pfxTokens.get(String(token || ''));
  pfxTokens.delete(String(token || ''));
  if (!v || Date.now() - v.ts > PWD_TTL_MS) return null;
  return v;
}

// 导入证书：buf = 文件内容，pwd = pfx/p12 导入密码（公钥证书可空）
// .pem 文本在 Node 侧剥头尾后转 DER 落临时文件；pfx/p12 原样落盘由 Import-PfxCertificate 处理
async function importCert(store, buf, filename, pwd, t) {
  if (!STORES.has(store)) throw new Error(t('certs.invalidStore'));
  if (!buf || !buf.length) throw new Error(t('certs.invalidFile'));
  if (buf.length > 100 * 1024) throw new Error(t('certs.fileTooBig'));

  const lower = String(filename || '').toLowerCase();
  const isPfx = /\.pfx$|\.p12$/.test(lower);
  if (isPfx && !pwd) throw new Error(t('certs.pwdRequired'));

  let data = buf;
  if (!isPfx && buf.slice(0, 256).toString('utf8').includes('-----BEGIN')) {
    const b64 = buf.toString('utf8')
      .replace(/-----BEGIN CERTIFICATE-----/, '')
      .replace(/-----END CERTIFICATE-----/, '')
      .replace(/\s+/g, '');
    data = Buffer.from(b64, 'base64');
    if (!data.length) throw new Error(t('certs.invalidFile'));
  }

  const tmp = path.join(os.tmpdir(), `wra-imp-${Date.now().toString(36)}-${process.pid}${isPfx ? '.pfx' : '.cer'}`);
  fs.writeFileSync(tmp, data);
  try {
    const env = { WRA_CERT_FILE: tmp };
    if (isPfx) env.WRA_CERT_PWD = pwd;
    const cmd = (isPfx
      ? `$c = Import-PfxCertificate -FilePath $env:WRA_CERT_FILE -CertStoreLocation Cert:\\LocalMachine\\${store} -Password (ConvertTo-SecureString $env:WRA_CERT_PWD -AsPlainText -Force) -ErrorAction Stop`
      : `$c = Import-Certificate -FilePath $env:WRA_CERT_FILE -CertStoreLocation Cert:\\LocalMachine\\${store} -ErrorAction Stop`)
      + '; if ($c -is [array]) { $c = $c[0] }; "TP=" + $c.Thumbprint + "|SUBJ=" + $c.Subject';
    const r = await ps.execute(cmd, { timeoutMs: 30000, fresh: true, env });
    if (!r.ok) return { ok: false, error: String(r.output || '').slice(0, 200) };
    const m = String(r.output || '').match(/TP=([0-9a-fA-F]{40})\|SUBJ=(.*)/);
    return { ok: true, tp: m ? m[1] : '', subj: m ? m[2].trim() : '' };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件清理失败不影响结果 */ }
  }
}

// 删除证书
async function deleteCert(store, thumbprint, t) {
  if (!STORES.has(store)) throw new Error(t('certs.invalidStore'));
  if (!TP_RE.test(thumbprint)) throw new Error(t('certs.invalidTp'));
  const cmd = `$c = Get-ChildItem ${storePath(store)} | Where-Object Thumbprint -eq $env:WRA_CERT_TP; `
    + 'if (-not $c) { throw "not found" }; '
    + 'Remove-Item -Path ("Cert:\\LocalMachine\\' + store + '\\$env:WRA_CERT_TP") -Force -ErrorAction Stop; "OK"';
  const r = await ps.execute(cmd, { timeoutMs: 30000, fresh: true, env: { WRA_CERT_TP: thumbprint } });
  return { ok: !!r.ok, error: r.ok ? null : String(r.output || '').slice(0, 200) };
}

module.exports = {
  STORES,
  TP_RE,
  listCerts,
  getCert,
  exportCert,
  importCert,
  issuePfxToken,
  takePfxToken,
  deleteCert,
};
