'use strict';

// Windows Update 路由：仅查看已安装更新（Get-HotFix），全员可读、只读无写接口
// 更新量可达数百条，搜索筛选走前端 JS（单页内存过滤），刷新走 htmx 片段
const updates = require('../services/updates');

function role(request) {
  return (request.session && request.session.get('role')) || 'admin';
}

module.exports = async function updatesRoutes(app) {
  // 整页
  app.get('/updates', async (request, reply) => {
    const kw = String(request.query.kw || '');
    const items = await updates.listHotfix(app.config.psTimeoutMs, request.t);
    return reply.renderPage('pages/updates', {
      title: request.t('updates.title'),
      active: 'updates',
      items,
      total: items.length,
      kw,
      role: role(request),
    });
  });

  // 列表片段（刷新按钮）
  app.get('/updates/list', async (request, reply) => {
    const items = await updates.listHotfix(app.config.psTimeoutMs, request.t);
    return reply.view('partials/updates-list', {
      items,
      total: items.length,
      t: request.t,
      role: role(request),
    });
  });
};
