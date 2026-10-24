# Windows Remote Admin - NSSM 服务管理脚本
# 用法（需管理员权限的为 install / uninstall）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\service.ps1 install
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\service.ps1 uninstall
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\service.ps1 start|stop|restart|status
# 常用参数：
#   -Name WRA                服务名（默认 WRA）
#   -Port 12306              可选：写入 AppEnvironmentExtra WRA_PORT=xxx
#   -NodePath "C:\...\node.exe"  可选：默认自动探测
#   -AppDir "D:\app\wra"     可选：默认为脚本上级目录（程序根目录）
#   -ExtraEnv "WRA_PS_TIMEOUT=60000","WRA_SESSION_SECRET=xxx"  可选：附加环境变量
param(
  [Parameter(Position = 0)][string]$Action = 'help',
  [string]$Name = 'WRA',
  [string]$AppDir = '',
  [string]$NodePath = '',
  [int]$Port = 0,
  [string[]]$ExtraEnv = @()
)

$ErrorActionPreference = 'Stop'

function Assert-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host '[错误] 该操作需要管理员权限，请以管理员身份运行（右键 -> 以管理员身份运行）。' -ForegroundColor Red
    exit 1
  }
}

function Test-ServiceExists {
  return $null -ne (Get-Service -Name $Name -ErrorAction SilentlyContinue)
}

function Resolve-Nssm {
  $cmd = Get-Command nssm.exe -ErrorAction SilentlyContinue
  if (-not $cmd) {
    Write-Host '[错误] 未找到 nssm.exe。请从 https://nssm.cc/download 下载，' -ForegroundColor Red
    Write-Host '       将对应架构的 nssm.exe 放入 PATH 目录或脚本同目录后重试。' -ForegroundColor Red
    exit 1
  }
  return $cmd.Source
}

function Resolve-Node {
  if ($NodePath) {
    if (-not (Test-Path $NodePath)) {
      Write-Host "[错误] 指定的 NodePath 不存在：$NodePath" -ForegroundColor Red
      exit 1
    }
    return (Resolve-Path $NodePath).Path
  }
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $cmd) {
    Write-Host '[错误] 未找到 node.exe，请安装 Node.js 20+ 或用 -NodePath 指定完整路径。' -ForegroundColor Red
    exit 1
  }
  return $cmd.Source
}

switch ($Action) {
  'install' {
    Assert-Admin
    $nssm = Resolve-Nssm
    $node = Resolve-Node
    if (-not $AppDir) { $AppDir = Split-Path -Parent $PSScriptRoot }
    $AppDir = (Resolve-Path $AppDir).Path
    $entry = Join-Path $AppDir 'server.js'
    if (-not (Test-Path $entry)) {
      Write-Host "[错误] 未找到入口文件：$entry" -ForegroundColor Red
      exit 1
    }
    if (Test-ServiceExists) {
      Write-Host "[错误] 服务 $Name 已存在。如需重装请先执行：uninstall" -ForegroundColor Red
      exit 1
    }
    Write-Host "[WRA] 安装服务 $Name ..."
    Write-Host "      node  = $node"
    Write-Host "      entry = $entry"
    Write-Host "      dir   = $AppDir"

    & $nssm install $Name $node $entry
    & $nssm set $Name AppDirectory $AppDir
    & $nssm set $Name Description 'Windows Remote Admin (Node.js)'
    & $nssm set $Name Start SERVICE_AUTO_START

    # 进程意外退出时自动重启（延迟 5 秒，避免崩溃循环）
    & $nssm set $Name AppExit Default Restart
    & $nssm set $Name AppRestartDelay 5000

    # 兜底日志：仅捕获启动崩溃等进程级输出；应用日志已由 pino-roll 写入 logs\ 并轮转
    $logs = Join-Path $AppDir 'logs'
    New-Item -ItemType Directory -Force -Path $logs | Out-Null
    & $nssm set $Name AppStdout (Join-Path $logs 'service-out.log')
    & $nssm set $Name AppStderr (Join-Path $logs 'service-err.log')
    & $nssm set $Name AppRotateFiles 1
    & $nssm set $Name AppRotateOnline 1
    & $nssm set $Name AppRotateBytes 10485760

    # 可选环境变量：-Port / -ExtraEnv（.env 文件由 server.js 自动加载，无需在此重复）
    $extra = @()
    if ($Port -gt 0) { $extra += "WRA_PORT=$Port" }
    if ($ExtraEnv.Count -gt 0) { $extra += $ExtraEnv }
    if ($extra.Count -gt 0) {
      & $nssm set $Name AppEnvironmentExtra $extra
    }

    & $nssm start $Name
    Write-Host "[WRA] 服务 $Name 已安装并启动。管理命令：Service.cmd 或 nssm $Name" -ForegroundColor Green
  }
  'uninstall' {
    Assert-Admin
    $nssm = Resolve-Nssm
    if (-not (Test-ServiceExists)) {
      Write-Host "[WRA] 服务 $Name 不存在，无需卸载。"
      exit 0
    }
    Write-Host "[WRA] 停止并卸载服务 $Name ..."
    & $nssm stop $Name | Out-Null
    & $nssm remove $Name confirm
    Write-Host "[WRA] 服务 $Name 已卸载。" -ForegroundColor Green
  }
  'start' {
    Assert-Admin
    & (Resolve-Nssm) start $Name
  }
  'stop' {
    Assert-Admin
    & (Resolve-Nssm) stop $Name
  }
  'restart' {
    Assert-Admin
    & (Resolve-Nssm) restart $Name
  }
  'status' {
    & (Resolve-Nssm) status $Name
  }
  default {
    Write-Host 'Windows Remote Admin - NSSM 服务管理'
    Write-Host ''
    Write-Host '用法: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\service.ps1 <action> [参数]'
    Write-Host 'action: install | uninstall | start | stop | restart | status'
    Write-Host '参数:   -Name WRA  -Port 12306  -NodePath <path>  -AppDir <path>  -ExtraEnv "K=V","K=V"'
    Write-Host ''
    Write-Host '示例: install -Port 12306 -ExtraEnv "WRA_PS_TIMEOUT=60000"'
  }
}
