'use strict';

// PowerShell 控制台路由 + 快捷命令分组（只读查询为主，运维常用场景）
const ps = require('../services/powershell');
const audit = require('../hooks/audit');

// 快捷命令分组：组名按请求语言渲染（PowerShell 命令本身不翻译）
function getQuickCommands(t) {
  return [
    {
      name: t('console.groupSystem'),
      icon: 'ti-device-desktop',
      items: [
        'Get-ComputerInfo | Select-Object WindowsProductName, OsBuildNumber, OsArchitecture',
        'systeminfo',
        'Get-Date -Format "yyyy-MM-dd HH:mm:ss"',
      ],
    },
    {
      name: t('console.groupProcesses'),
      icon: 'ti-list-details',
      items: [
        'Get-Process | Sort-Object WS -Descending | Select-Object -First 10 Name, Id, WS',
        'Get-Process | Where-Object { $_.CPU -gt 60 } | Select-Object Name, Id, CPU',
      ],
    },
    {
      name: t('console.groupServices'),
      icon: 'ti-settings',
      items: [
        'Get-Service | Where-Object Status -eq "Running" | Select-Object -First 20 Name, DisplayName',
        'Get-Service | Where-Object StartType -eq "Automatic" | Where-Object Status -ne "Running"',
      ],
    },
    {
      name: t('console.groupNetwork'),
      icon: 'ti-network',
      items: [
        'ipconfig /all',
        'Get-NetTCPConnection -State Listen | Select-Object LocalAddress, LocalPort, OwningProcess | Sort-Object LocalPort',
        'Test-Connection -ComputerName localhost -Count 2',
      ],
    },
    {
      name: t('console.groupDisk'),
      icon: 'ti-database',
      items: [
        'Get-Volume | Format-Table DriveLetter, FileSystemLabel, Size, SizeRemaining',
        'Get-PSDrive -PSProvider FileSystem',
      ],
    },
  ];
}

module.exports = async function consoleRoutes(app) {
  // 执行命令：返回终端输出片段（beforeend 追加）
  app.post('/console/execute', async (request, reply) => {
    app.assertWritable(request);
    const command = String((request.body && request.body.command) || '').trim();
    if (!command) {
      return reply.view('partials/console-output', {
        command: '',
        result: { ok: false, output: request.t('console.emptyCommand'), durationMs: 0, exitCode: -1, timedOut: false },
      });
    }

    // 连续会话：按用户名隔离，cd / 变量等状态跨命令保留
    const username = (request.session && request.session.get('username')) || 'anonymous';
    const result = await ps.execute(command, { timeoutMs: app.config.psTimeoutMs, sessionKey: `user:${username}` });
    audit(request, 'PowerShell 命令执行', { command, durationMs: result.durationMs, ok: result.ok });

    return reply.view('partials/console-output', { command, result });
  });
};

module.exports.getQuickCommands = getQuickCommands;
