'use strict';

// 部署向导 /setup：NSSM 服务安装说明 + 本机环境检测（纯只读，无审计/确认需求）
// 检测分两层：Node 侧直接读进程/文件系统；Windows 侧用 fresh 一次性 PowerShell 查询
// （nssm 路径、WRA 服务状态），动态值（服务名）经 env 注入，绝不拼接命令串。
const path = require('node:path');
const fs = require('node:fs');
const ps = require('../services/powershell');

const ROOT = path.join(__dirname, '..', '..');
const SVC_NAME = 'WRA'; // 默认服务名，与 scripts/service.ps1 保持一致

// 一次性查询 nssm 路径与 WRA 服务状态（10s 超时；查询失败按未检测到处理，不阻塞页面）
async function detectWindows() {
  const cmd =
    '$n = Get-Command nssm.exe -ErrorAction SilentlyContinue; ' +
    '$s = Get-Service -Name $env:WRA_SVC_NAME -ErrorAction SilentlyContinue; ' +
    '$r = @{ nssm = $null; status = $null; startType = $null }; ' +
    'if ($n) { $r.nssm = $n.Source }; ' +
    'if ($s) { $r.status = [string]$s.Status; $r.startType = [string]$s.StartType }; ' +
    '$r | ConvertTo-Json -Compress';
  try {
    const out = await ps.execute(cmd, { timeoutMs: 10000, fresh: true, env: { WRA_SVC_NAME: SVC_NAME } });
    if (!out.ok) return { nssm: null, status: null, startType: null };
    return JSON.parse(String(out.output || '').trim());
  } catch (e) {
    return { nssm: null, status: null, startType: null };
  }
}

module.exports = async function setupRoutes(app) {
  // 整页
  app.get('/setup', async (request, reply) => {
    return reply.renderPage('pages/setup', {
      title: request.t('setup.title'),
      active: 'setup',
      appDir: ROOT,
      nodePath: process.execPath,
      port: app.config.port,
    });
  });

  // 环境检测（partial：页面加载时自动触发 + 手动重新检测）
  app.post('/setup/check', async (request, reply) => {
    const t = request.t;
    const win = await detectWindows();
    const data = {
      t,
      nodeVersion: process.version,
      nodePath: process.execPath,
      appDir: ROOT,
      entryOk: fs.existsSync(path.join(ROOT, 'server.js')),
      scriptOk: fs.existsSync(path.join(ROOT, 'Service.cmd')),
      envExists: fs.existsSync(path.join(ROOT, '.env')),
      envExample: fs.existsSync(path.join(ROOT, '.env.example')),
      nssm: win.nssm,
      svcStatus: win.status, // Running / Stopped / null(未安装)
      svcStartType: win.startType,
      svcName: SVC_NAME,
      labels: {
        nodeVersion: t('setup.nodeVersion'),
        nodePath: t('setup.nodePath'),
        appDir: t('setup.appDir'),
        entryFile: t('setup.entryFile'),
        envFile: t('setup.envFile'),
        scriptFile: t('setup.scriptFile'),
        nssm: t('setup.nssm'),
        service: t('setup.service'),
        startMode: t('setup.startMode'),
        present: t('setup.present'),
        missing: t('setup.missing'),
        envFound: t('setup.envFound'),
        envMissing: t('setup.envMissing'),
        nssmMissing: t('setup.nssmMissing'),
        svcRunning: t('setup.svcRunning'),
        svcStopped: t('setup.svcStopped'),
        svcMissing: t('setup.svcMissing'),
      },
    };
    return reply.view('partials/setup-check', data);
  });
};
