'use strict';

// 审计辅助：统一附带 username / ip，写入 audit 流
function audit(request, event, fields = {}) {
  const logger = request.server.auditLog;
  if (!logger) return;
  logger.info({
    event,
    username: (request.session && request.session.get('username')) || 'anonymous',
    ip: request.ip,
    ...fields,
  });
}

module.exports = audit;
