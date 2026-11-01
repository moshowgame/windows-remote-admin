'use strict';

// 打包脚本，两种模式：
//   默认（pack:code）：「code & web only」分发包——不含 vendor 静态资源，接收方 Run.cmd 首次运行补齐
//   --deploy（pack:deploy）：/deploy 简易部署专用包——只含部署白名单条目，public/ 全量（含 vendor），
//     因为原地更新不执行 npm install，静态资源必须随包携带
const fs = require('node:fs');
const path = require('node:path');
const archiver = require('archiver');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const { version } = require(path.join(ROOT, 'package.json'));
const DEPLOY_MODE = process.argv.includes('--deploy');

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

// 收集目录下全部文件（rel 相对 base 的 / 分隔路径；keepGenerated=true 时保留 vendor 生成物，部署包用）
function collect(dir, base = dir, keepGenerated = false) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = path.relative(base, abs).replace(/\\/g, '/');
    if (!keepGenerated && GENERATED.has(rel)) continue;
    if (fs.statSync(abs).isDirectory()) out.push(...collect(abs, base, keepGenerated));
    else out.push({ abs, rel });
  }
  return out;
}

async function main() {
  const entries = [];

  if (DEPLOY_MODE) {
    // 部署包：仅白名单条目（/deploy 预检对其他条目一律拒绝），public/ 全量含 vendor
    for (const f of ['server.js', 'package.json']) {
      entries.push({ abs: path.join(ROOT, f), rel: f });
    }
    for (const d of ['src', 'views', 'scripts']) {
      for (const e of collect(path.join(ROOT, d))) {
        entries.push({ abs: e.abs, rel: `${d}/${e.rel}` });
      }
    }
    for (const e of collect(path.join(ROOT, 'public'), path.join(ROOT, 'public'), true)) {
      entries.push({ abs: e.abs, rel: `public/${e.rel}` });
    }
  } else {
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
  }

  fs.mkdirSync(DIST, { recursive: true });
  const target = DEPLOY_MODE
    ? path.join(DIST, `wra-deploy-v${version}.zip`)
    : path.join(DIST, `windows-remote-admin-code-web-v${version}.zip`);
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
  if (DEPLOY_MODE) {
    console.log(`[pack] 部署专用包（含 vendor 静态资源）：打开 /deploy 页面上传该文件即可，建议版本号 ${version}`);
  } else {
    console.log('[pack] 接收方解压后双击 Run.cmd 即可（首次运行自动安装依赖并复制静态资源）');
  }
}

main().catch((err) => {
  console.error(`[pack] 打包失败：${err.message}`);
  process.exit(1);
});
