'use strict';

// i18n 多语言支持：en（默认）/ zh-CN
// - 语言偏好存 cookie wra_lang（1 年），detect 从请求读取
// - 字典按页面命名空间；t(key) 缺失时回退 en，再回退 key 本身
// - 模板用法：<%= t('files.title') %>；内联 JS：'<%= t("files.confirmDelete") %>'
// - 各页面段落由独立维护区追加，段与段之间不要互相依赖

const LANGS = ['en', 'zh-CN'];
const COOKIE = 'wra_lang';

const en = {
  // common / nav
  'common.appName': 'Windows Remote Admin',
  'common.confirm': 'Confirm',
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.delete': 'Delete',
  'common.loading': 'Loading…',
  'common.readonlyDenied': 'Read-only account is not allowed to perform this operation',
  'common.roleAdmin': 'Administrator',
  'common.roleReadonly': 'Read-only',
  'nav.dashboard': 'Overview',
  'nav.console': 'PowerShell',
  'nav.files': 'Files',
  'nav.editor': 'Editor',
  'nav.logs': 'Logs',
  'nav.services': 'Services',
  'nav.net': 'Network',
  'nav.events': 'Event Viewer',
  'nav.users': 'Users',
  'nav.settings': 'Settings',
  'nav.logout': 'Logout',
  'nav.theme': 'Toggle theme',
  'nav.lang': 'Language',
  'error.badRequest': 'Bad request',
  'error.tooLarge': 'Request body too large',
  'error.rateLimited': 'Too many requests, please retry later',
  'error.forbidden': 'Security check failed, please refresh and retry',
  'error.server': 'Internal server error',
  'error.generic': 'Request failed',
  'error.notFound': 'Page not found',
  'error.notFoundDetail': 'Page not found',
  'error.pageTitle': 'Error',
};

const zhCN = {
  'common.appName': 'Windows 远程管理',
  'common.confirm': '确认',
  'common.cancel': '取消',
  'common.close': '关闭',
  'common.delete': '删除',
  'common.loading': '加载中…',
  'common.readonlyDenied': '只读账号无权执行此操作',
  'common.roleAdmin': '管理员',
  'common.roleReadonly': '只读',
  'nav.dashboard': '系统概览',
  'nav.console': 'PowerShell',
  'nav.files': '文件管理',
  'nav.editor': '文本编辑器',
  'nav.logs': '日志监控',
  'nav.services': '服务管理',
  'nav.net': '端口/网络',
  'nav.events': '事件查看器',
  'nav.users': '本地用户',
  'nav.settings': '设置',
  'nav.logout': '登出',
  'nav.theme': '切换主题',
  'nav.lang': '语言',
  'error.badRequest': '请求参数错误',
  'error.tooLarge': '请求体过大，超出限制',
  'error.rateLimited': '操作过于频繁，请稍后再试',
  'error.forbidden': '安全校验失败，请刷新页面重试',
  'error.server': '服务器内部错误',
  'error.generic': '请求失败',
  'error.notFound': '页面不存在',
  'error.notFoundDetail': '页面不存在',
  'error.pageTitle': '错误',
};

// ---- 各页面字典段（独立文件维护，启动时合并；新增页面新建 part 文件并在此注册）----
for (const part of ['./i18n-parts/pages-a', './i18n-parts/files', './i18n-parts/pages-c']) {
  const m = require(part);
  Object.assign(en, m.en || {});
  Object.assign(zhCN, m['zh-CN'] || {});
}

const dict = { en, 'zh-CN': zhCN };

// 从请求解析语言：cookie > 默认 en
function detect(request) {
  const raw = request && request.cookies ? request.cookies[COOKIE] : '';
  return LANGS.includes(raw) ? raw : 'en';
}

// 返回当前语言的翻译函数
function of(request) {
  const lang = detect(request);
  const table = dict[lang] || {};
  const enTable = dict.en;
  return function t(key) {
    if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
    if (Object.prototype.hasOwnProperty.call(enTable, key)) return enTable[key];
    return key;
  };
}

module.exports = { LANGS, COOKIE, detect, of, dict };
