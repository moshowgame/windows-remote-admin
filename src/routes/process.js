'use strict';

// 进程管理路由：全量进程列表（内存 / CPU 占用率排序）+ 结束进程（写操作审计）
// 复用 /net 页的确认框 + 审计模式：PID 白名单校验、系统关键进程保护、动态值经 spawn env 注入
const ps = require('../services/powershell');
const audit = require('../hooks/audit');

// 展示行数上限：普通系统进程数远低于此，超出提示截断
const MAX_ROWS = 3000;

// 结束进程白名单：PID 必须是正整数；0(Idle)/4(System)/8(System) 为系统关键进程直接拒绝
const PID_RE = /^[1-9][0-9]{0,5}$/;
const PROTECTED_PIDS = new Set([0, 4, 8]);
const SORTS = new Set(['mem', 'cpu', 'pid', 'name']);

// CPU 占用率采样间隔（毫秒）：两次 Get-Process 差分计算 %，贴近任务管理器口径
const SAMPLE_MS = 1500;

// 一次拉取全量进程（进程名/PID/内存/CPU 占用率/CPU 累计时间/线程/启动时间/路径），JSON 压缩输出
// CPU 占用率：命令内两次采样差分 u = (cpu2-cpu1)/间隔秒/核心数*100；新启动进程无前值 → null
async function listProcesses(timeoutMs, t) {
  const cmd = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ErrorActionPreference=\'SilentlyContinue\'; '
    + '$c=[Environment]::ProcessorCount; $a=@{}; '
    + 'Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $a[$_.Id]=$_.CPU }; '
    + '$sw=[Diagnostics.Stopwatch]::StartNew(); Start-Sleep -Milliseconds ' + SAMPLE_MS + '; $sw.Stop(); '
    + '$iv=[math]::Max($sw.Elapsed.TotalSeconds,0.1); '
    + '$r=@(); '
    + 'Get-Process -ErrorAction SilentlyContinue | ForEach-Object { '
    + '$s=$null; try { $s=$_.StartTime } catch {}; $pt=$null; try { $pt=$_.Path } catch {}; '
    + '$u=$null; $c1=$a[$_.Id]; if(($null -ne $c1) -and ($null -ne $_.CPU)){ $u=[math]::Round(($_.CPU-$c1)/$iv/$c*100,1) }; '
    + "$r += [PSCustomObject]@{ n=$_.ProcessName; id=$_.Id; ws=[math]::Round($_.WS/1MB,1); pm=[math]::Round($_.PM/1MB,1); cpu=$_.CPU; u=$u; th=$_.Threads.Count; st=$(if($s){$s.ToString('yyyy-MM-dd HH:mm:ss')}else{$null}); p=$pt } "
    + '}; '
    + '@{ t = $r.Count; r = $r } | ConvertTo-Json -Compress -Depth 3';
  const out = await ps.execute(cmd, { timeoutMs, sessionKey: 'proc-mgmt' });
  if (!out.ok) throw new Error(t('process.listFailed').replace('{n}', String(out.output || '').slice(0, 200)));
  const raw = String(out.output || '').trim();
  if (!raw) return { total: 0, rows: [] };
  const data = JSON.parse(raw);
  const rows = Array.isArray(data.r) ? data.r : [data.r].filter(Boolean);
  return { total: data.t || rows.length, rows };
}

function matchKw(row, kw) {
  if (!kw) return true;
  const hay = `${row.id} ${row.n || ''} ${row.p || ''}`.toLowerCase();
  return hay.includes(kw);
}

// 排序：mem=内存(WS) 降序（默认）/ cpu=CPU 占用率降序（无采样值靠后）/ pid 升序 / name 字典序
function sortRows(rows, sort) {
  if (sort === 'cpu') rows.sort((a, b) => (b.u == null ? -1 : b.u) - (a.u == null ? -1 : a.u));
  else if (sort === 'pid') rows.sort((a, b) => a.id - b.id);
  else if (sort === 'name') rows.sort((a, b) => String(a.n || '').localeCompare(String(b.n || '')));
  else rows.sort((a, b) => (b.ws || 0) - (a.ws || 0));
  return rows;
}

function computeStats(rows) {
  return {
    total: rows.length,
    mem: rows.reduce((sum, r) => sum + (Number(r.ws) || 0), 0),
  };
}

function renderList(reply, allRows, kw, sort, role, msg) {
  const filtered = sortRows(allRows.filter((r) => matchKw(r, kw)), sort);
  return reply.view('partials/process-list', {
    rows: filtered.slice(0, MAX_ROWS), kw, sort, stats: computeStats(allRows), role, msg,
    truncated: filtered.length > MAX_ROWS,
  });
}

module.exports = async function processRoutes(app) {
  // 整页
  app.get('/process', async (request, reply) => {
    const { rows } = await listProcesses(app.config.psTimeoutMs, request.t);
    const kw = String(request.query.kw || '').trim();
    const sort = String(request.query.sort || 'mem');
    return reply.renderPage('pages/process', {
      title: request.t('process.title'),
      active: 'process',
      rows: sortRows(rows.filter((r) => matchKw(r, kw)), sort).slice(0, MAX_ROWS),
      kw,
      sort: SORTS.has(sort) ? sort : 'mem',
      stats: computeStats(rows),
      truncated: rows.length > MAX_ROWS,
      msg: null,
    });
  });

  // 列表片段（搜索/排序/操作后刷新）
  app.get('/process/list', async (request, reply) => {
    const { rows } = await listProcesses(app.config.psTimeoutMs, request.t);
    const kw = String(request.query.kw || '').trim();
    const sort = String(request.query.sort || 'mem');
    const role = request.session.get('role') || 'admin';
    return renderList(reply, rows, kw, SORTS.has(sort) ? sort : 'mem', role, null);
  });

  // 结束进程（admin）
  app.post('/process/kill', async (request, reply) => {
    app.assertWritable(request);
    const body = request.body || {};
    const pid = String(body.pid || '').trim();
    if (!PID_RE.test(pid) || PROTECTED_PIDS.has(Number(pid))) {
      throw Object.assign(new Error(request.t('process.invalidPid')), { statusCode: 400 });
    }
    const r = await ps.execute('Stop-Process -Id $env:WRA_PID -Force -ErrorAction Stop', {
      timeoutMs: 15000,
      fresh: true,
      env: { WRA_PID: pid },
    });
    const ok = !!r.ok;
    audit(request, '结束进程', { pid, proc: String(body.pname || '').slice(0, 80), ok });

    const { rows } = await listProcesses(app.config.psTimeoutMs, request.t);
    const kw = String(body.kw || '').trim();
    const sort = String(body.sort || 'mem');
    const role = request.session.get('role') || 'admin';
    const toastMsg = 'enc:' + encodeURIComponent(
      ok ? request.t('process.killDone').replace('{n}', pid) : request.t('process.killFailed').replace('{n}', pid)
    );
    reply.header('HX-Trigger', JSON.stringify({ toast: { message: toastMsg, type: ok ? 'success' : 'error' } }));
    return renderList(reply, rows, kw, SORTS.has(sort) ? sort : 'mem', role, ok ? null : String(r.output || '').slice(0, 120));
  });
};
