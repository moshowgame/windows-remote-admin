'use strict';

// 端口/网络视图路由：TCP/UDP 连接列表（关联进程）+ 结束进程（写操作审计）
// 动态值（PID）经 fresh 模式 spawn env 注入 + $env:XXX 引用，绝不拼接进命令串
const ps = require('../services/powershell');
const audit = require('../hooks/audit');

// 行数上限：防止极端环境下连接表过大拖垮渲染
const MAX_ROWS = 5000;

// 结束进程白名单：PID 必须是正整数；0(Idle)/4(System) 为系统关键进程直接拒绝
const PID_RE = /^[1-9][0-9]{0,5}$/;
const PROTECTED_PIDS = new Set([0, 4, 8]);

// 一次查询 TCP + UDP 并关联进程名（缩写字段减小 JSON 体积）
async function listConnections(timeoutMs, t) {
  const cmd = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; '
    + '$p=@{}; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { $p[[uint32]$_.ProcessId] = @{ n = $_.Name; c = $_.CommandLine } }; '
    + '$r=@(); '
    + 'Get-NetTCPConnection -ErrorAction SilentlyContinue | ForEach-Object { $r += [PSCustomObject]@{ proto=\'TCP\'; la=$_.LocalAddress; lp=$_.LocalPort; ra=$_.RemoteAddress; rp=$_.RemotePort; st=[string]$_.State; x=$_.OwningProcess; pn=$p[[uint32]$_.OwningProcess].n; pc=$p[[uint32]$_.OwningProcess].c } }; '
    + 'Get-NetUDPEndpoint -ErrorAction SilentlyContinue | ForEach-Object { $r += [PSCustomObject]@{ proto=\'UDP\'; la=$_.LocalAddress; lp=$_.LocalPort; ra=\'*\'; rp=0; st=\'Listen\'; x=$_.OwningProcess; pn=$p[[uint32]$_.OwningProcess].n; pc=$p[[uint32]$_.OwningProcess].c } }; '
    + '@{ t = $r.Count; r = @($r | Select-Object -First ' + MAX_ROWS + ') } | ConvertTo-Json -Compress -Depth 3';
  const out = await ps.execute(cmd, { timeoutMs, sessionKey: 'net-mgmt' });
  if (!out.ok) throw new Error(t('net.listFailed').replace('{n}', String(out.output || '').slice(0, 200)));
  const raw = String(out.output || '').trim();
  if (!raw) return { total: 0, rows: [] };
  const data = JSON.parse(raw);
  const rows = Array.isArray(data.r) ? data.r : [data.r].filter(Boolean);
  // System/Idle 等 Win32_Process 查不到的 PID 补齐进程名
  for (const row of rows) {
    if (!row.pn) row.pn = row.x === 4 ? 'System' : (row.x === 0 ? 'Idle Process' : '');
  }
  return { total: data.t || rows.length, rows };
}

function matchKw(row, kw) {
  if (!kw) return true;
  const hay = `${row.la} ${row.lp} ${row.ra} ${row.rp} ${row.st} ${row.x} ${row.pn || ''}`.toLowerCase();
  return hay.includes(kw);
}

function filterByState(rows, state) {
  if (!state || state === 'all') return rows;
  if (state === 'listen') return rows.filter((r) => r.st === 'Listen');
  if (state === 'established') return rows.filter((r) => r.st === 'Established');
  return rows.filter((r) => r.st !== 'Listen' && r.st !== 'Established');
}

function computeStats(rows) {
  return {
    total: rows.length,
    listen: rows.filter((r) => r.st === 'Listen').length,
    established: rows.filter((r) => r.st === 'Established').length,
  };
}

function renderList(reply, allRows, kw, state, role, msg) {
  const filtered = filterByState(allRows, state).filter((r) => matchKw(r, kw));
  // 端口升序，同端口协议/地址稳定
  filtered.sort((a, b) => (a.lp - b.lp) || (a.la < b.la ? -1 : 1));
  return reply.view('partials/net-list', {
    rows: filtered, kw, state, stats: computeStats(allRows), role, msg,
    truncated: allRows.length > MAX_ROWS,
  });
}

module.exports = async function netRoutes(app) {
  // 整页
  app.get('/net', async (request, reply) => {
    const { total, rows } = await listConnections(app.config.psTimeoutMs, request.t);
    const kw = String(request.query.kw || '').trim();
    const state = String(request.query.state || 'listen');
    return reply.renderPage('pages/net', {
      title: request.t('net.title'),
      active: 'net',
      rows: filterByState(rows, state).filter((r) => matchKw(r, kw)).sort((a, b) => (a.lp - b.lp) || (a.la < b.la ? -1 : 1)),
      kw,
      state,
      stats: computeStats(rows),
      totalCount: total,
      truncated: total > MAX_ROWS,
      msg: null,
    });
  });

  // 列表片段（搜索/筛选/操作后刷新）
  app.get('/net/list', async (request, reply) => {
    const { total, rows } = await listConnections(app.config.psTimeoutMs, request.t);
    const kw = String(request.query.kw || '').trim();
    const state = String(request.query.state || 'listen');
    const role = request.session.get('role') || 'admin';
    return renderList(reply, rows, kw, state, role, null);
  });

  // 结束进程（admin）
  app.post('/net/kill', async (request, reply) => {
    app.assertWritable(request);
    const body = request.body || {};
    const pid = String(body.pid || '').trim();
    if (!PID_RE.test(pid) || PROTECTED_PIDS.has(Number(pid))) {
      throw Object.assign(new Error(request.t('net.invalidPid')), { statusCode: 400 });
    }
    const r = await ps.execute('Stop-Process -Id $env:WRA_PID -Force -ErrorAction Stop', {
      timeoutMs: 15000,
      fresh: true,
      env: { WRA_PID: pid },
    });
    const ok = !!r.ok;
    audit(request, '结束进程', { pid, proc: String(body.pname || '').slice(0, 80), ok });

    const { rows } = await listConnections(app.config.psTimeoutMs, request.t);
    const kw = String(body.kw || '').trim();
    const state = String(body.state || 'listen');
    const role = request.session.get('role') || 'admin';
    const toastMsg = 'enc:' + encodeURIComponent(
      ok ? request.t('net.killDone').replace('{n}', pid) : request.t('net.killFailed').replace('{n}', pid)
    );
    reply.header('HX-Trigger', JSON.stringify({ toast: { message: toastMsg, type: ok ? 'success' : 'error' } }));
    return renderList(reply, rows, kw, state, role, ok ? null : String(r.output || '').slice(0, 120));
  });
};
