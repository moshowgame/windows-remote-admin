'use strict';

// 文件系统服务：路径解析（白名单）/ 目录列举 / 文件分类 / 文本分页读取
const fsp = require('node:fs/promises');
const path = require('node:path');
const { config } = require('../config');

// 业务路径错误（错误处理器按 400 透出 message）
class PathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathError';
    this.statusCode = 400;
  }
}

// 文本文件扩展名（未列出的扩展名做二进制嗅探兜底）
const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.log', '.json', '.jsonc', '.xml', '.yml', '.yaml', '.ini', '.cfg', '.conf', '.env',
  '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.vue', '.css', '.scss', '.less', '.html', '.htm', '.ejs', '.hbs',
  '.csv', '.tsv', '.sql', '.bat', '.cmd', '.ps1', '.psm1', '.psd1', '.sh', '.py', '.rb', '.php', '.java', '.cs',
  '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.properties', '.toml', '.gitignore', '.gitattributes', '.editorconfig',
]);

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);

// 图片 Content-Type 白名单（/files/raw 直接输出用）
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};

// 用户输入解析为绝对路径：去引号 → resolve 规范化 → 白名单校验
// 空输入回退 fallbackDir（文件管理器默认根目录）
function resolveUserPath(input, fallbackDir) {
  let p = String(input == null ? '' : input).trim();
  if (!p) {
    if (fallbackDir) return path.resolve(fallbackDir);
    throw new PathError('请提供路径');
  }
  // 资源管理器“复制文件地址”常带引号
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1).trim();
  }
  // 注入/命令行攻击加固：长度、控制字符、UNC 网络路径、Windows 非法字符
  if (p.length > 1000) throw new PathError('路径过长');
  if (/[\x00-\x1f\x7f]/.test(p)) throw new PathError('路径包含非法控制字符');
  if (p.startsWith('\\\\') || p.startsWith('//')) throw new PathError('不支持网络（UNC）路径，仅允许本地目录');
  // <>|*?" 为 Windows 文件名非法字符（' 合法故放行，由调用方按需转义）
  if (/[<>|*?"]/.test(p)) throw new PathError('路径包含 Windows 非法字符 < > | * ? "');
  let resolved;
  try {
    resolved = path.resolve(p);
  } catch {
    throw new PathError('路径格式不正确');
  }
  // 盘符冒号外不允许出现第二个冒号（阻断 NTFS 备用数据流，如 file.txt:stream）
  if (resolved.length > 2 && resolved.slice(2).includes(':')) throw new PathError('路径包含非法冒号（疑似 NTFS 数据流）');
  // Windows 保留设备名（CON/NUL/COM1...）不可作为路径段
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..+)?$/i.test(path.basename(resolved))) {
    throw new PathError('路径包含 Windows 保留设备名');
  }
  const list = config.pathWhitelist || [];
  if (list.length > 0) {
    const ok = list.some((root) => {
      const r = path.resolve(root);
      const lower = resolved.toLowerCase();
      return lower === r.toLowerCase() || lower.startsWith(r.toLowerCase() + path.sep);
    });
    if (!ok) throw new PathError('路径不在允许访问的目录内');
  }
  return resolved;
}

// 父目录；盘符根（如 C:\）返回 null
function parentOf(p) {
  const parent = path.dirname(p);
  return parent === p ? null : parent;
}

// 面包屑：C:\Users\Admin → [{name:'C:\',...},{name:'Users',...},{name:'Admin',...}]
function crumbsOf(p) {
  const parts = [];
  let cur = path.resolve(p);
  for (;;) {
    parts.unshift({ name: path.basename(cur) || cur, path: cur });
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return parts;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// yyyyMMddHHmmss（备份/解压目录/上传重命名用）
function stampNow(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function sizeText(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function timeText(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// Tabler 图标类（含语义色）
function iconFor(kind, name) {
  if (kind === 'dir') return 'ti-folder text-warning';
  if (kind === 'image') return 'ti-photo text-info';
  if (kind === 'zip') return 'ti-file-zip text-warning';
  if (kind === 'text') {
    return name && name.toLowerCase().endsWith('.log') ? 'ti-file-text text-cyan' : 'ti-file-text text-secondary';
  }
  return 'ti-file text-secondary';
}

// 二进制嗅探：读前 512B，含 NUL 即判定二进制
async function sniffIsText(fullPath, sizeBytes) {
  if (sizeBytes === 0) return true;
  let fh = null;
  try {
    fh = await fsp.open(fullPath, 'r');
    const buf = Buffer.alloc(Math.min(512, sizeBytes));
    await fh.read(buf, 0, buf.length, 0);
    return !buf.includes(0);
  } catch {
    return false; // 读不了的按二进制处理
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

// 文件分类：dir | text | image | zip | binary
async function kindOf(fullPath, st) {
  if (!st) st = await fsp.stat(fullPath).catch(() => null);
  if (!st) return 'binary';
  if (st.isDirectory()) return 'dir';
  const ext = path.extname(fullPath).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ext === '.zip') return 'zip';
  if (TEXT_EXTS.has(ext)) return 'text';
  return (await sniffIsText(fullPath, st.size)) ? 'text' : 'binary';
}

// 列目录：目录优先，name 用本地化自然排序，size/mtime 数值排序，desc 反转
async function listDir(dir, sort = 'name', order = 'asc') {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') throw new PathError('目录不存在');
    if (err.code === 'ENOTDIR') throw new PathError('路径不是目录');
    if (err.code === 'EACCES' || err.code === 'EPERM') throw new PathError('没有权限读取该目录');
    throw new PathError(`读取目录失败（${err.code || err.message}）`);
  }

  const items = await Promise.all(
    entries.map(async (d) => {
      const full = path.join(dir, d.name);
      let st = null;
      try {
        st = await fsp.stat(full);
      } catch {
        // 竞态/权限问题，给占位值
      }
      const isDirectory = d.isDirectory();
      const sizeBytes = st && !isDirectory ? st.size : 0;
      const mtimeMs = st ? st.mtimeMs : 0;
      let kind;
      if (isDirectory) {
        kind = 'dir';
      } else {
        const ext = path.extname(d.name).toLowerCase();
        if (IMAGE_EXTS.has(ext)) kind = 'image';
        else if (ext === '.zip') kind = 'zip';
        else if (TEXT_EXTS.has(ext)) kind = 'text';
        else kind = (await sniffIsText(full, sizeBytes)) ? 'text' : 'binary';
      }
      return {
        name: d.name,
        path: full,
        isDirectory,
        kind,
        sizeBytes,
        sizeText: isDirectory ? '—' : sizeText(sizeBytes),
        mtimeMs,
        mtimeText: st ? timeText(st.mtime) : '—',
        icon: iconFor(kind, d.name),
      };
    })
  );

  items.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    let r;
    if (sort === 'size') r = a.sizeBytes - b.sizeBytes;
    else if (sort === 'mtime') r = a.mtimeMs - b.mtimeMs;
    else r = a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
    if (r === 0) r = a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
    return order === 'desc' ? -r : r;
  });

  return items;
}

// 文本分页读取（预览用）：整读限 readMaxMb，行级截断 2000 字符
const LINE_MAX = 2000;

async function readTextPage(file, page = 1) {
  const pageSize = config.previewPageLines || 500;
  const st = await fsp.stat(file).catch(() => null);
  if (!st) throw new PathError('文件不存在或已被移动');
  if (st.size > (config.readMaxMb || 10) * 1024 * 1024) {
    throw new PathError(`文件超过 ${config.readMaxMb} MB，不支持预览`);
  }
  const buf = await fsp.readFile(file);
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去 BOM
  const lines = text.split(/\r\n|\r|\n/);
  const totalLines = lines.length;
  const pages = Math.max(1, Math.ceil(totalLines / pageSize));
  const cur = Math.min(Math.max(1, page | 0 || 1), pages);
  const slice = lines.slice((cur - 1) * pageSize, cur * pageSize).map((l) =>
    l.length > LINE_MAX ? `${l.slice(0, LINE_MAX)} …（截断，行长 ${l.length}）` : l
  );
  return { lines: slice, page: cur, pages, totalLines, sizeBytes: st.size, sizeText: sizeText(st.size) };
}

// 整文件读取（编辑器用）
async function readTextFile(file) {
  const st = await fsp.stat(file).catch(() => null);
  if (!st) throw new PathError('文件不存在或已被移动');
  if (st.size > (config.readMaxMb || 10) * 1024 * 1024) {
    throw new PathError(`文件超过 ${config.readMaxMb} MB，不支持在线编辑`);
  }
  const buf = await fsp.readFile(file);
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { content: text, sizeBytes: st.size, sizeText: sizeText(st.size), mtimeText: timeText(st.mtime) };
}

module.exports = {
  PathError,
  TEXT_EXTS,
  IMAGE_EXTS,
  IMAGE_MIME,
  resolveUserPath,
  parentOf,
  crumbsOf,
  stampNow,
  sizeText,
  timeText,
  iconFor,
  kindOf,
  listDir,
  readTextPage,
  readTextFile,
};
