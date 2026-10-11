'use strict';

// Dashboard 统计片段路由（HTMX 轮询用）
const systeminfo = require('../services/systeminfo');

module.exports = async function dashboardRoutes(app) {
  app.get('/dashboard/stats', async (request, reply) => {
    if (request.query.part === 'processes') {
      const procs = await systeminfo.getTopProcesses();
      return reply.view('partials/dashboard-processes', { procs });
    }
    const s = await systeminfo.getSnapshot();
    return reply.view('partials/dashboard-stats', { s });
  });
};
