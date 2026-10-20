'use strict';

// 文本编辑器路由：加载（只读可选）+ 保存（先备份再覆盖）
const path = require('node:path');
const fsp = require('node:fs/promises');
const filesystem = require('../services/filesystem');
const { PathError } = filesystem;
const audit = require('../hooks/audit');

module.exports = async function editorRoutes(app) {
  const maxBytes = () => (app.config.readMaxMb || 10) * 1024 * 1024;

  // 编辑页（无 path 时显示引导空态）
  app.get('/editor', async (request, reply) => {
    const p = request.query.path;
    if (!p) {
      return reply.renderPage('pages/editor', { title: '文本编辑器', active: 'editor', noFile: true });
    }
    const full = filesystem.resolveUserPath(p);
    const kind = await filesystem.kindOf(full);
    if (kind === 'dir') throw new PathError('不能编辑目录，请选择文件');
    if (kind !== 'text') throw new PathError('仅支持编辑文本文件');
    const f = await filesystem.readTextFile(full);
    // 只读账号强制只读模式（保存接口另有服务端兜底）
    const readonly = request.query.readonly === '1' || request.query.readonly === 'true'
      || request.session.get('role') === 'readonly';
    return reply.renderPage('pages/editor', {
      title: '文本编辑器',
      active: 'editor',
      noFile: false,
      path: full,
      name: path.basename(full),
      parentDir: path.dirname(full),
      content: f.content,
      sizeText: f.sizeText,
      mtimeText: f.mtimeText,
      readonly,
    });
  });

  // 保存：先复制 .bak 时间戳备份，再覆盖写入
  app.post('/editor/save', async (request, reply) => {
    app.assertWritable(request);
    const b = request.body || {};
    if (b.readonly === '1' || b.readonly === 'true') throw new PathError('只读模式不允许保存');
    const full = filesystem.resolveUserPath(b.path);
    const st = await fsp.stat(full).catch(() => null);
    if (!st || st.isDirectory()) throw new PathError('目标文件不存在');
    const incoming = typeof b.content === 'string' ? b.content : '';
    if (Buffer.byteLength(incoming, 'utf8') > maxBytes()) {
      throw new PathError(`内容超过 ${app.config.readMaxMb} MB 上限`);
    }
    let backup = null;
    try {
      backup = `${full}.${filesystem.stampNow()}.bak`;
      await fsp.copyFile(full, backup);
    } catch (e) {
      backup = null;
      app.log.warn({ err: e, path: full }, '保存前备份失败');
    }
    await fsp.writeFile(full, incoming, 'utf8');
    audit(request, '保存文件', { path: full, backup: backup || '无（新文件或备份失败）', bytes: Buffer.byteLength(incoming, 'utf8') });
    return reply.send(''); // 前端 afterRequest 提示保存成功
  });
};
