'use strict';

// 简易部署：上传压缩包 → 预检 → 确认（备份+覆盖+写 pending 标记）→ 重启验证（失败自动回滚）
// 所有写操作 assertWritable + 审计；预检结构不合格直接报错，绝不覆盖 data/logs/backups/.env

const pipeline = require('node:util').promisify(require('node:stream').pipeline);
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '../..');
const deploy = require('../services/deploy');
const audit = require('../hooks/audit');

module.exports = async function deployRoutes(app) {
  // 启动时顺手清理超龄 staging（上传后一直未确认的 zip）
  deploy.cleanupStaging().catch(() => {});

  // 部署页：当前版本 + 建议版本（最新备份 +1）+ 备份列表 + 待验证状态 + 最近一次启动结果
  app.get('/deploy', async (request, reply) => {
    const [backups, pending, nextVersion, lastResult] = await Promise.all([
      deploy.listBackups(), deploy.readPending(), deploy.suggestNextVersion(), deploy.readLastResult(),
    ]);
    deploy.cleanupStaging().catch(() => {});
    // 门卫结果首次被看到时补写审计（回滚发生在进程外，无法在事发的请求内审计）
    let result = lastResult;
    if (lastResult && !lastResult.audited) {
      audit(request, '启动门卫部署结果', {
        username: 'system',
        outcome: lastResult.outcome,
        toVersion: lastResult.toVersion,
        backupId: lastResult.backupId,
        error: lastResult.error,
      });
      await deploy.markResultAudited(lastResult);
      result = { ...lastResult, audited: true };
    }
    const cur = JSON.parse(await fs.promises.readFile(path.join(ROOT, 'package.json'), 'utf8').catch(() => ({})));
    return reply.renderPage('pages/deploy', {
      title: request.t('deploy.title'),
      active: 'deploy',
      backups,
      pending,
      lastResult: result,
      curVersion: cur.version || '?',
      nextVersion,
      uploadMaxMb: app.config.uploadMaxMb || 100,
    });
  });

  // 备份列表局部刷新
  app.get('/deploy/backups', async (request, reply) => {
    return reply.view('partials/deploy-backups', {
      backups: await deploy.listBackups(),
      t: request.t,
      role: (request.session && request.session.get('role')) || 'admin',
    });
  });

  // 上传部署包：流式落盘 staging → 预检 → 返回预览（确认前不动任何现有代码）
  app.post('/deploy/upload', async (request, reply) => {
    app.assertWritable(request);
    if (!request.isMultipart()) throw new DeployErr(request.t('deploy.errNotMultipart'));
    let zipPath = null;
    let version = '';
    for await (const part of request.parts()) {
      if (part.type === 'field') {
        if (part.fieldname === 'version') version = String(part.value || '').trim();
        continue; // 仅支持单文件
      }
      if (!/\.zip$/i.test(part.filename || '')) {
        part.file.resume();
        throw new DeployErr(request.t('deploy.errNotZip'));
      }
      zipPath = await deploy.newStagingPath();
      try {
        await pipeline(part.file, fs.createWriteStream(zipPath));
        if (part.file.truncated) {
          await fs.promises.rm(zipPath, { force: true }).catch(() => {});
          zipPath = null;
          throw new DeployErr(request.t('deploy.errTooLarge').replace('{n}', app.config.uploadMaxMb));
        }
      } catch (e) {
        if (zipPath) await fs.promises.rm(zipPath, { force: true }).catch(() => {});
        if (e.statusCode === 400) throw e;
        throw new DeployErr(request.t('deploy.errSaveFailed').replace('{s}', e.code || e.message));
      }
      break; // 只取第一个文件
    }
    if (!zipPath) throw new DeployErr(request.t('deploy.errNoFile'));

    // 主版本标识：填写时仅允许数字与点（时间戳在确认部署时自动追加）；留空则回退 package.json 版本
    const ver = deploy.sanitizeVersion(version);
    if (version && !ver) throw new DeployErr(request.t('deploy.errVersionInvalid'));

    let analysis;
    try {
      analysis = await deploy.analyzePackage(zipPath);
    } catch (e) {
      await fs.promises.rm(zipPath, { force: true }).catch(() => {});
      throw e;
    }
    audit(request, '上传部署包', {
      toVersion: analysis.version,
      backupVersion: ver || null,
      files: analysis.fileCount,
      strippedNodeModules: analysis.strippedCount,
    });
    const token = zipPath.split(/[\\/]/).pop();
    return reply.view('partials/deploy-preview', { a: analysis, token, version: ver || '' });
  });

  // 确认部署：备份 → 覆盖解压 → 写 pending 标记 → 清 staging（解压失败自动恢复备份）
  app.post('/deploy/confirm', async (request, reply) => {
    app.assertWritable(request);
    const { token = '', depsAck = '', version = '' } = request.body || {};
    const zipPath = deploy.stagingPath(String(token));
    if (!zipPath || !fs.existsSync(zipPath)) throw new DeployErr(request.t('deploy.errStagingGone'));

    // 主版本标识再次校验（时间戳在备份时自动追加）
    const ver = deploy.sanitizeVersion(version);
    if (version && !ver) throw new DeployErr(request.t('deploy.errVersionInvalid'));

    const analysis = await deploy.analyzePackage(zipPath);
    if (analysis.depDiff.length && depsAck !== 'on') {
      throw new DeployErr(request.t('deploy.errDepsAck'));
    }

    deploy.beginDeploy();
    let backupId = null;
    try {
      const backup = await deploy.backupCurrent(ver);
      backupId = backup.backupId;
      try {
        await deploy.extractPackage(zipPath, analysis);
      } catch (e) {
        // 解压失败：恢复备份，保持原版本完整
        await deploy.restoreBackup(backupId).catch(() => {});
        throw new DeployErr(request.t('deploy.errExtractFailed').replace('{s}', e.message));
      }
      await deploy.writePending({ backupId, fromVersion: analysis.curVersion, toVersion: analysis.version });
    } finally {
      deploy.endDeploy();
      await fs.promises.rm(zipPath, { force: true }).catch(() => {});
    }

    audit(request, '执行部署', {
      fromVersion: analysis.curVersion,
      toVersion: analysis.version,
      backupId,
      files: analysis.fileCount,
    });
    reply.header('HX-Trigger', 'wra-refresh-backups');
    return reply.view('partials/deploy-result', {
      ok: true,
      rollback: false,
      pending: await deploy.readPending(),
      a: analysis,
      backupId,
      message: null,
    });
  });

  // 手动回滚：备份内容覆盖回程序目录（需重启生效）
  app.post('/deploy/rollback', async (request, reply) => {
    app.assertWritable(request);
    const { backupId = '' } = request.body || {};
    deploy.beginDeploy();
    let res;
    try {
      res = await deploy.restoreBackup(String(backupId));
    } finally {
      deploy.endDeploy();
    }
    audit(request, '回滚部署版本', { backupId: res.backupId, restored: res.restored });
    reply.header('HX-Trigger', 'wra-refresh-backups');
    return reply.view('partials/deploy-result', {
      ok: true,
      rollback: true,
      backupId: res.backupId,
      restored: res.restored,
      pending: null,
      a: null,
      message: null,
    });
  });
};

function DeployErr(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}
