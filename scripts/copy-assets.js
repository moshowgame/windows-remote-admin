'use strict';

// postinstall：从 node_modules 复制 Tabler / Tabler Icons / HTMX 静态资源到 public/
// 保持全离线特性，不依赖 CDN
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');

// [源（相对 node_modules）, 目标（相对 public）]
const tasks = [
  ['@tabler/core/dist/css/tabler.min.css', 'css/tabler.min.css'],
  ['@tabler/core/dist/js/tabler.min.js', 'js/tabler.min.js'],
  ['@tabler/icons-webfont/dist/tabler-icons.min.css', 'css/tabler-icons.min.css'],
  ['@tabler/icons-webfont/dist/fonts/tabler-icons.woff2', 'css/fonts/tabler-icons.woff2'],
  ['@tabler/icons-webfont/dist/fonts/tabler-icons.woff', 'css/fonts/tabler-icons.woff'],
  ['htmx.org/dist/htmx.min.js', 'js/htmx.min.js'],
  ['htmx-ext-sse/dist/sse.min.js', 'js/ext/sse.js'],
];

let ok = 0;
for (const [src, dest] of tasks) {
  const from = path.join(ROOT, 'node_modules', src);
  const to = path.join(PUB, dest);
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    ok += 1;
    console.log(`[copy-assets] ${src} -> public/${dest}`);
  } catch (err) {
    console.warn(`[copy-assets] 跳过 ${src}: ${err.message}`);
  }
}
console.log(`[copy-assets] 完成，共 ${ok}/${tasks.length} 项`);
