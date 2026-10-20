'use strict';

// 设置页：快速访问配置（写入 config.json）+ 只读系统参数展示
const path = require('node:path');
const { saveUserConfig } = require('../config');
const { PathError } = require('../services/filesystem');
const audit = require('../hooks/audit');

// HX-Trigger 头不允许非 ASCII，中文消息打 enc: 前缀由前端解码
const encMsg = (m) => (/^[\x20-\x7E]*$/.test(m) ? m : 'enc:' + encodeURIComponent(m));
const toastHeader = (message, type) => ({
  'HX-Trigger': JSON.stringify({ toast: { message: encMsg(message), type: type || 'success' } }),
});

function settingsCtx(app) {
  return {
    quickAccess: app.config.quickAccess || [],
    readonly: {
      port: app.config.port,
      psTimeoutMs: app.config.psTimeoutMs,
      uploadMaxMb: app.config.uploadMaxMb,
      readMaxMb: app.config.readMaxMb,
      previewPageLines: app.config.previewPageLines,
      extractMaxMb: app.config.extractMaxMb,
      extractMaxFiles: app.config.extractMaxFiles,
      enableServerOpen: app.config.enableServerOpen,
      pathWhitelist: app.config.pathWhitelist || [],
      logRetentionDays: app.config.logRetentionDays,
    },
  };
}

module.exports = async function settingsRoutes(app) {
  // 设置页
  app.get('/settings', async (request, reply) => {
    return reply.renderPage('pages/settings', {
      title: '设置',
      active: 'settings',
      ...settingsCtx(app),
    });
  });

  // 保存快速访问：label[] 与 path[] 按下标配对，空行跳过
  app.post('/settings/quick-access', async (request, reply) => {
    app.assertWritable(request);
    const b = request.body || {};
    const labels = [].concat(b.label || []);
    const paths = [].concat(b.path || []);
    if (labels.length !== paths.length) throw new PathError('表单数据不完整，请刷新页面后重试');

    const list = [];
    for (let i = 0; i < labels.length; i++) {
      const label = String(labels[i] || '').trim();
      const raw = String(paths[i] || '').trim();
      if (!label && !raw) continue; // 空行忽略
      if (!label || !raw) throw new PathError(`第 ${i + 1} 行：名称与路径必须同时填写`);
      let resolved;
      try {
        resolved = path.resolve(raw);
      } catch {
        throw new PathError(`第 ${i + 1} 行：路径格式不正确`);
      }
      list.push({ label, path: resolved });
    }
    if (list.length > 20) throw new PathError('快速访问最多 20 条');

    saveUserConfig({ quickAccess: list });
    audit(request, '修改设置', { type: 'quickAccess', count: list.length });

    // OOB 刷新设置主区（表单回到已保存状态）+ Toast
    return reply.headers(toastHeader('设置已保存')).view('partials/settings-oob', settingsCtx(app));
  });
};
