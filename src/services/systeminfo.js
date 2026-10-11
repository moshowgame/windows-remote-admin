'use strict';

// 系统信息采集服务（Dashboard 用）
// 单条命令合并采集 OS/CPU/内存/磁盘/启动时间，5s 超时；失败返回 ok:false，前端降级显示 N/A
const ps = require('./powershell');

const QUICK_TIMEOUT_MS = 5000;

// 合并快照命令（ConvertTo-Json 输出，便于稳定解析）
const SNAPSHOT_CMD = `
$ErrorActionPreference='SilentlyContinue'
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3"
[pscustomobject]@{
  os = $os.Caption
  version = $os.Version
  build = $os.BuildNumber
  memTotal = [long]$os.TotalVisibleMemorySize
  memFree = [long]$os.FreePhysicalMemory
  boot = $os.LastBootUpTime.ToString('yyyy-MM-ddTHH:mm:ss')
  cpuLoad = $cpu.LoadPercentage
  cpuName = $cpu.Name
  disks = @($disks | ForEach-Object { @{ id = $_.DeviceID; size = [long]$_.Size; free = [long]$_.FreeSpace } })
} | ConvertTo-Json -Depth 3 -Compress`;

// 内存占用 Top 10 进程
const PROCESS_CMD = `
$ErrorActionPreference='SilentlyContinue'
@(
  Get-Process | Sort-Object WS -Descending | Select-Object -First 10 |
    ForEach-Object { @{ name = $_.ProcessName; id = $_.Id; ws = [math]::Round($_.WS/1MB, 1); cpu = $_.CPU } }
) | ConvertTo-Json -Compress`;

function safeJson(text) {
  try { return JSON.parse(text); } catch { /* 继续尝试提取 */ }
  // 兜底：输出尾部可能混入噪声，提取第一个 { [ 到最后一个 } ] 的子串
  if (!text) return null;
  const start = text.search(/[{[]/);
  if (start < 0) return null;
  const endObj = text.lastIndexOf('}');
  const endArr = text.lastIndexOf(']');
  const end = Math.max(endObj, endArr);
  if (end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

// 字节数 → 可读文本
function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return 'N/A';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// 启动时间 → "x 天 x 小时 x 分"
function formatUptime(bootStr) {
  const boot = new Date(bootStr).getTime();
  if (isNaN(boot)) return 'N/A';
  let ms = Date.now() - boot;
  if (ms < 0) return 'N/A';
  const days = Math.floor(ms / 86400000); ms %= 86400000;
  const hours = Math.floor(ms / 3600000); ms %= 3600000;
  const minutes = Math.floor(ms / 60000);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分钟`;
}

// 系统快照（OS/CPU/内存/磁盘/运行时间）
// sessionKey 'system'：独立长驻会话，与控制台用户会话互不干扰；轮询时免 PowerShell 冷启动
async function getSnapshot() {
  const r = await ps.execute(SNAPSHOT_CMD, { timeoutMs: QUICK_TIMEOUT_MS, sessionKey: 'system' });
  const d = r.ok ? safeJson(r.output) : null;
  if (!d) return { ok: false };

  const memTotal = Number(d.memTotal) * 1024;
  const memFree = Number(d.memFree) * 1024;
  const memUsed = memTotal - memFree;

  return {
    ok: true,
    os: d.os || 'N/A',
    version: d.version || '',
    build: d.build || '',
    cpuName: d.cpuName || '',
    cpuLoad: d.cpuLoad == null ? null : Number(d.cpuLoad),
    memTotal,
    memUsed,
    memPct: memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : null,
    memUsedText: formatBytes(memUsed),
    memTotalText: formatBytes(memTotal),
    uptimeText: formatUptime(d.boot),
    disks: (Array.isArray(d.disks) ? d.disks : []).map((disk) => {
      const total = Number(disk.size);
      const used = total - Number(disk.free);
      return {
        id: disk.id,
        usedText: formatBytes(used),
        totalText: formatBytes(total),
        pct: total > 0 ? Math.round((used / total) * 100) : 0,
      };
    }),
  };
}

// Top 10 进程
async function getTopProcesses() {
  const r = await ps.execute(PROCESS_CMD, { timeoutMs: QUICK_TIMEOUT_MS, sessionKey: 'system' });
  const arr = safeJson(r.output);
  if (!Array.isArray(arr)) return [];
  return arr.map((p) => ({
    name: p.name || 'N/A',
    id: p.id,
    wsText: `${Number(p.ws).toFixed(1)} MB`,
    cpuText: p.cpu == null ? 'N/A' : Number(p.cpu).toFixed(1),
  }));
}

module.exports = { getSnapshot, getTopProcesses };
