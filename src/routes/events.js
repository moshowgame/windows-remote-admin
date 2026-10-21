'use strict';

// 事件查看器路由：Windows 事件日志查询（只读，无写操作）
// 动态值（日志名/起止时间/级别）经 fresh 模式 spawn env 注入 + $env:XXX 引用，绝不拼接进命令串
const ps = require('../services/powershell');

const LOGS = ['System', 'Application', 'Security'];
const LEVELS = [1, 2, 3, 4, 5];
const MAX_EVENTS = 500;
const MSG_MAX = 500;

// datetime-local 值格式：2026-10-21T22:05
const DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

async function queryEvents(app, log, level, start, end, t) {
  const cmd = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
    + '$st = [datetime]::ParseExact($env:WRA_EV_START, \'yyyy-MM-ddTHH:mm\', [Globalization.CultureInfo]::InvariantCulture); '
    + '$et = [datetime]::ParseExact($env:WRA_EV_END, \'yyyy-MM-ddTHH:mm\', [Globalization.CultureInfo]::InvariantCulture); '
    + '$lv = $env:WRA_EV_LEVEL -split \',\' | ForEach-Object { [int]$_ }; '
    + '$r = @(); $t = 0; '
    + 'try { '
    + '$evs = @(Get-WinEvent -FilterHashtable @{ LogName=$env:WRA_EV_LOG; StartTime=$st; EndTime=$et; Level=$lv } -MaxEvents ' + MAX_EVENTS + ' -ErrorAction Stop); '
    + '$t = $evs.Count; '
    + '$r = @($evs | ForEach-Object { $m = $_.Message; if ($m) { $m = ($m -replace \'\\s+\', \' \'); if ($m.Length -gt ' + (MSG_MAX - 1) + ') { $m = $m.Substring(0, ' + (MSG_MAX - 1) + ') + \'…\' } } else { $m = \'\' }; '
    + '[PSCustomObject]@{ t = $_.TimeCreated.ToString(\'yyyy-MM-dd HH:mm:ss\'); p = $_.ProviderName; i = $_.Id; l = [int]$_.Level; m = $m } }) '
    + '} catch {} '
    + '@{ t = $t; r = $r } | ConvertTo-Json -Compress -Depth 3';
  const env = {
    WRA_EV_LOG: log,
    WRA_EV_LEVEL: level.join(','),
    WRA_EV_START: start,
    WRA_EV_END: end,
  };
  const out = await ps.execute(cmd, { timeoutMs: 45000, fresh: true, env });
  if (!out.ok) throw new Error(t('events.listFailed').replace('{n}', String(out.output || '').slice(0, 160)));
  const raw = String(out.output || '').trim();
  if (!raw) return { total: 0, rows: [] };
  const data = JSON.parse(raw);
  const rows = Array.isArray(data.r) ? data.r : [data.r].filter(Boolean);
  return { total: data.t || rows.length, rows };
}

function matchKw(row, kw) {
  if (!kw) return true;
  const hay = `${row.t} ${row.p || ''} ${row.i} ${row.m || ''}`.toLowerCase();
  return hay.includes(kw);
}

module.exports = async function eventsRoutes(app) {
  const defaultRange = () => {
    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const end = new Date();
    const start = new Date(end.getTime() - 24 * 3600 * 1000);
    return { start: fmt(start), end: fmt(end) };
  };

  const parseParams = (query, t) => {
    const range = defaultRange();
    const log = LOGS.includes(query.log) ? query.log : 'System';
    const level = (String(query.level || '').split(',').map((n) => parseInt(n, 10)).filter((n) => LEVELS.includes(n)));
    const lv = level.length ? level : LEVELS;
    const start = DT_RE.test(String(query.start || '')) ? query.start : range.start;
    const end = DT_RE.test(String(query.end || '')) ? query.end : range.end;
    if (new Date(start.replace('T', ' ')) > new Date(end.replace('T', ' '))) {
      throw Object.assign(new Error(t('events.dateInvalid')), { statusCode: 400 });
    }
    const kw = String(query.kw || '').trim().slice(0, 100).toLowerCase();
    return { log, level: lv, start, end, kw };
  };

  const renderList = (reply, result, params, msg) => {
    const rows = result.rows.filter((r) => matchKw(r, params.kw));
    return reply.view('partials/events-list', {
      rows, total: result.total, msg, maxEvents: MAX_EVENTS,
    });
  };

  // 整页
  app.get('/events', async (request, reply) => {
    const params = parseParams(request.query, request.t);
    const result = await queryEvents(app, params.log, params.level, params.start, params.end, request.t);
    return reply.renderPage('pages/events', {
      title: request.t('events.title'),
      active: 'events',
      params,
      rows: result.rows.filter((r) => matchKw(r, params.kw)),
      total: result.total,
      msg: null,
      maxEvents: MAX_EVENTS,
    });
  });

  // 列表片段（筛选/搜索后刷新）
  app.get('/events/list', async (request, reply) => {
    const params = parseParams(request.query, request.t);
    const result = await queryEvents(app, params.log, params.level, params.start, params.end, request.t);
    return renderList(reply, result, params, null);
  });
};
