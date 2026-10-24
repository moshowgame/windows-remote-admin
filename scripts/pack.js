'use strict';

// 打包「code & web only」分发压缩包：仅源码 + 页面模板 + 本地静态资源
// node_modules / vendor 静态资源 / 运行数据不打入包内，接收方首次运行 Run.cmd 时自动补齐
const fs = require('node:fs');
const path = require('node:path');
const archiver = require('archiver');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const { version } = require(path.join(ROOT, 'package.json'));

// copy-assets.js 生成到 public/ 的 vendor 资源清单（与其保持同步），不入包
const GENERATED = new Set([
  'css/tabler.min.css',
  'css/tabler-icons.min.css',
  'css/fonts',            // 目录：图标字体
  'js/tabler.min.js',
  'js/htmx.min.js',
  'js/ext/sse.js',
]);

const ROOT_FILES = [
  'server.js',
  'package.json',
  'package-lock.json',
  'config.default.json',
  '.env.example',
  'README.md',
  'Run.cmd',
  'Build.cmd',
  'Pack.cmd',
  'Service.cmd',
];

const CODE_DIRS = ['src', 'views', 'scripts'];

// 收集目录下全部文件（rel 相对 base 的 / 分隔路径，用于排除 vendor 生成物）
function collect(dir, base = dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = path.relative(base, abs).replace(/\\/g, '/');
    if (GENERATED.has(rel)) continue;
    if (fs.statSync(abs).isDirectory()) out.push(...collect(abs, base));
    else out.push({ abs, rel });
  }
  return out;
}

async function main() {
  const entries = [];

  for (const f of ROOT_FILES) {
    const abs = path.join(ROOT, f);
    if (fs.existsSync(abs)) entries.push({ abs, rel: f });
  }
  for (const d of CODE_DIRS) {
    for (const e of collect(path.join(ROOT, d))) {
      entries.push({ abs: e.abs, rel: `${d}/${e.rel}` });
    }
  }
  for (const e of collect(path.join(ROOT, 'public'))) {
    entries.push({ abs: e.abs, rel: `public/${e.rel}` });
  }

  fs.mkdirSync(DIST, { recursive: true });
  const target = path.join(DIST, `windows-remote-admin-code-web-v${version}.zip`);
  fs.rmSync(target, { force: true });

  const output = fs.createWriteStream(target);
  const archive = archiver('zip', { zlib: { level: 9 } });
  const finished = new Promise((resolve, reject) => {
    output.on('close', () => resolve());
    archive.on('error', reject);
  });
  archive.pipe(output);
  for (const { abs, rel } of entries) archive.file(abs, { name: rel });
  archive.finalize();
  await finished;

  const size = fs.statSync(target).size;
  const kb = size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.round(size / 1024)} KB`;
  console.log(`[pack] 产物：${target}`);
  console.log(`[pack] 共 ${entries.length} 个文件，${kb}`);
  console.log('[pack] 接收方解压后双击 Run.cmd 即可（首次运行自动安装依赖并复制静态资源）');
}

main().catch((err) => {
  console.error(`[pack] 打包失败：${err.message}`);
  process.exit(1);
});
