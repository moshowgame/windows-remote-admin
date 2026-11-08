'use strict';

// API 调试路由：单次 HTTP 请求代理（简易 Postman / curl 调试）
// - 无状态：请求与响应均不落盘、不保存历史、不携带/存储 Cookie（服务端 fetch 天然无 Cookie）
// - 方法白名单 + URL 必须为 http(s)；header/query 由文本行解析（"K: V" / "k=v"）
// - 响应 2MB 截断 + 60s 超时（AbortSignal）；审计仅记 method/url/结果，不记 header 与 body（防敏感 payload 泄漏）

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const audit = require('../hooks/audit');
const MAX_BODY = 2 * 1024 * 1024; // 响应体上限 2MB，超出截断
const TIMEOUT_MS = 60000;

// 文本行 → [key, value] 数组：headers 用 "K: V"，query 用 "k=v"；分隔符后内容原样保留
function parseLines(text, sep) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const idx = s.indexOf(sep);
    if (idx <= 0) continue;
    out.push([s.slice(0, idx).trim(), s.slice(idx + sep.length).trim()]);
  }
  return out;
}

// query 追加到 URL（处理已有 ? / 末尾悬空 &）
function appendQuery(url, pairs) {
  if (!pairs.length) return url;
  const enc = pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return url + (url.includes('?') ? (/[?&]$/.test(url) ? '' : '&') : '?') + enc;
}

module.exports = async function httpRoutes(app) {
  // 整页
  app.get('/http', async (request, reply) => {
    return reply.renderPage('pages/http', {
      title: request.t('http.title'),
      active: 'http',
    });
  });

  // 发送请求：服务端 fetch 代理，单次执行无状态
  app.post('/http/send', async (request, reply) => {
    app.assertWritable(request);
    const body = request.body || {};
    const bad = (key) => Object.assign(new Error(request.t(key)), { statusCode: 400 });

    const method = String(body.method || 'GET').toUpperCase();
    if (!METHODS.has(method)) throw bad('http.invalidMethod');
    let url = String(body.url || '').trim();
    if (!/^https?:\/\/[^\s]+$/i.test(url)) throw bad('http.invalidUrl');
    url = appendQuery(url, parseLines(body.query, '='));

    const headers = {};
    for (const [k, v] of parseLines(body.headers, ':')) headers[k] = v;
    const hasBody = !['GET', 'HEAD'].includes(method);
    const rawBody = hasBody ? String(body.body || '') : '';
    // 有请求体且未显式指定 Content-Type 时默认 JSON（可自行覆盖）
    if (rawBody && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }

    const started = Date.now();
    let res = null;
    let text = '';
    let err = null;
    let truncated = false;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: rawBody || undefined,
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      text = await res.text();
      if (text.length > MAX_BODY) {
        text = text.slice(0, MAX_BODY);
        truncated = true;
      }
    } catch (e) {
      err = String((e && e.message) || e);
    }
    const durationMs = Date.now() - started;

    audit(request, 'API 调试请求', { method, url, ok: !!res, status: res ? res.status : null });
    const resHeaders = [];
    if (res) res.headers.forEach((v, k) => resHeaders.push([k, v]));

    return reply.send({
      ok: !!res,
      error: err,
      status: res ? res.status : 0,
      statusText: res ? res.statusText : '',
      durationMs,
      headers: resHeaders,
      body: text,
      truncated,
    });
  });
};
