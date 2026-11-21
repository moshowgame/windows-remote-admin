'use strict';

// DNS / hosts 路由：hosts 查看全员、编辑（非只读）+ 清空缓存（非只读），写操作审计
// hosts 内容读写走 node fs（services/dns.js），缓存走 PowerShell
const dns = require('../services/dns');
const audit = require('../hooks/audit');

function role(request) {
  return (request.session && request.session.get('role')) || 'admin';
}

// 缓存列表拉取 + 关键字过滤（页面 / 片段共用）
async function cacheItems(request, kw) {
  const k = String(kw || '').trim().toLowerCase();
  try {
    const items = await dns.listCache(request.server.config.psTimeoutMs, request.t);
    return { items: k ? items.filter((i) => `${i.entry} ${i.data} ${i.type}`.toLowerCase().includes(k)) : items, err: null };
  } catch (e) {
    return { items: [], err: String(e.message || '').slice(0, 200) };
  }
}

module.exports = async function dnsRoutes(app) {
  // 整页：hosts 内容 + DNS 缓存
  app.get('/dns', async (request, reply) => {
    const hosts = await dns.readHosts();
    const backups = await dns.listBackups().catch(() => []);
    const cache = await cacheItems(request, request.query.kw);
    return reply.renderPage('pages/dns', {
      title: request.t('dns.title'),
      active: 'dns',
      hosts,
      hostsWithComment: dns.HOSTS_PATH,
      backups,
      cache: cache.items,
      cacheErr: cache.err,
      kw: String(request.query.kw || ''),
      role: role(request),
    });
  });

  // 缓存片段（刷新 / 搜索 / 清空后）
  app.get('/dns/cache', async (request, reply) => {
    const cache = await cacheItems(request, request.query.kw);
    return reply.view('partials/dns-cache', {
      items: cache.items,
      total: cache.items.length,
      cacheErr: cache.err,
      kw: String(request.query.kw || ''),
      t: request.t,
      role: role(request),
      msg: null,
    });
  });

  // 保存 hosts（全文替换；写前自动时间戳备份，非只读 + 审计）
  app.post('/dns/hosts', async (request, reply) => {
    app.assertWritable(request);
    const body = request.body || {};
    const content = String(body.content == null ? '' : body.content);
    if (content.length > dns.MAX_CONTENT_LEN) {
      throw Object.assign(new Error(request.t('dns.tooLarge').replace('{n}', String(dns.MAX_CONTENT_LEN))), { statusCode: 400 });
    }
    const bak = await dns.writeHosts(content);
    audit(request, '保存hosts文件', { bytes: Buffer.byteLength(content, 'utf8'), backup: bak });
    reply.header('HX-Trigger', JSON.stringify({
      toast: { message: 'enc:' + encodeURIComponent(request.t('dns.hostsSaved').replace('{n}', bak)), type: 'success' },
      refreshBackups: new Date().toISOString(),
    }));
    return reply.code(204).send();
  });

  // 清空 DNS 缓存（非只读 + 审计；返回刷新后的缓存片段）
  app.post('/dns/flush', async (request, reply) => {
    app.assertWritable(request);
    const body = request.body || {};
    const r = await dns.flushCache(request.server.config.psTimeoutMs, request.t);
    audit(request, '清空DNS缓存', { ok: r.ok });
    const toast = 'enc:' + encodeURIComponent(r.ok
      ? request.t('dns.flushed')
      : request.t('dns.flushFailed').replace('{n}', r.error || ''));
    reply.header('HX-Trigger', JSON.stringify({ toast: { message: toast, type: r.ok ? 'success' : 'warning' } }));
    const cache = await cacheItems(request, body.kw);
    return reply.view('partials/dns-cache', {
      items: cache.items,
      total: cache.items.length,
      cacheErr: cache.err,
      kw: String(body.kw || ''),
      t: request.t,
      role: role(request),
      msg: null,
    });
  });

  // 备份列表片段（保存后 HX-Trigger refreshBackups 触发刷新）
  app.get('/dns/backups', async (request, reply) => {
    const backups = await dns.listBackups().catch(() => []);
    return reply.view('partials/dns-backups', { backups, t: request.t, role: role(request) });
  });

  // 查看备份内容（只读；名称白名单校验防路径穿越）
  app.get('/dns/backup-content', async (request, reply) => {
    const name = String(request.query.name || '').trim();
    if (!/^hosts\.bak-\d{8}-\d{6}$/.test(name)) {
      throw Object.assign(new Error(request.t('dns.backupNotFound')), { statusCode: 400 });
    }
    const dir = require('node:path').dirname(dns.HOSTS_PATH);
    let content = '';
    try {
      content = await require('node:fs/promises').readFile(require('node:path').join(dir, name), 'utf8');
    } catch {
      throw Object.assign(new Error(request.t('dns.backupNotFound')), { statusCode: 404 });
    }
    return { name, content };
  });
};
