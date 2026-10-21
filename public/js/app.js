/* 全局脚本：Toast 监听 / HTMX 错误兜底（保持精简，后续批次按需追加） */
(function () {
  'use strict';

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 全局 Toast（基于 Tabler/Bootstrap 5 的样式，纯 DOM 实现）
  // 注意：tabler.min.js 是 IIFE 打包，不暴露 window.bootstrap（无 bootstrap.Toast 可用），
  // 因此直接加 .show 类展示并定时移除；关闭按钮手动移除元素
  function showToast(message, type) {
    var container = document.querySelector('.toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container position-fixed top-0 end-0 p-3';
      container.style.zIndex = '2000';
      document.body.appendChild(container);
    }
    var el = document.createElement('div');
    var cls = type === 'error' ? 'text-bg-danger'
      : type === 'warning' ? 'text-bg-warning'
      : type === 'info' ? 'text-bg-primary' : 'text-bg-success';
    el.className = 'toast show align-items-center border-0 ' + cls;
    el.setAttribute('role', 'alert');
    el.innerHTML = '<div class="d-flex"><div class="toast-body">' + escapeHtml(message) +
      '</div><button type="button" class="btn-close btn-close-white me-2 m-auto" aria-label="关闭"></button></div>';
    container.appendChild(el);
    var close = function () { el.remove(); };
    el.querySelector('.btn-close').addEventListener('click', close);
    setTimeout(close, 4500);
  }

  // 服务端 HX-Trigger: {"toast": {"message": "...", "type": "success"}} 触发
  // 含中文的消息由服务端加 enc: 前缀并 URL 编码（HTTP 头不允许非 ASCII）
  document.body.addEventListener('toast', function (e) {
    var d = e.detail || {};
    var msg = d.message || '操作完成';
    if (typeof msg === 'string' && msg.indexOf('enc:') === 0) {
      try { msg = decodeURIComponent(msg.slice(4)); } catch (err) { /* 保持原文 */ }
    }
    showToast(msg, d.type);
  });

  // HTMX 请求错误兜底（429 限流 / 403 CSRF / 5xx 等）
  // 页面内已自行处理并标记 wraHandled 的错误（如文件预览）不重复提示
  document.body.addEventListener('htmx:responseError', function (e) {
    if (e.detail && e.detail.wraHandled) return;
    var xhr = e.detail && e.detail.xhr;
    if (!xhr) return;
    var redirect = xhr.getResponseHeader('HX-Redirect');
    if (redirect) { window.location.href = redirect; return; }
    showToast(decodeURIComponent(xhr.getResponseHeader('X-WRA-Error') || '') || ('请求失败（HTTP ' + xhr.status + '）'), 'error');
  });

  // 只读账号兜底拦截：即使 UI 未隐藏（缓存页面/新入口），写路由请求在前端直接取消并提示
  var WRITE_ROUTES = /^\/(files\/(upload|open|extract|compress|mkdir|rename|delete)|console\/execute|services\/(action|batch-action)|editor\/save|settings\/quick-access|net\/kill|users\/(action|resetpwd))$/;
  var WRA_ROLE = document.body.dataset.role || 'admin';
  document.body.addEventListener('htmx:beforeRequest', function (e) {
    if (WRA_ROLE !== 'readonly') return;
    var path = (e.detail && e.detail.pathInfo && e.detail.pathInfo.requestPath) || '';
    if (WRITE_ROUTES.test(path)) {
      e.preventDefault();
      showToast('只读账号无权执行此操作', 'warning');
    }
  });

  // 请求进行中禁用相关提交按钮（防重复提交；仅覆盖当前元素/所属表单）
  // 注意：必须先于进度条监听注册，防止重复请求被取消时进度计数泄漏
  document.body.addEventListener('htmx:beforeRequest', function (e) {
    var elt = e.detail && e.detail.elt;
    if (!elt) return;
    var scope = elt.tagName === 'FORM' ? elt : (elt.closest ? elt.closest('form') : null);
    var root = scope || elt;
    if (root.dataset && root.dataset.busy === '1') { e.preventDefault(); return; }
    root.dataset.busy = '1';
    root.querySelectorAll('button[type=submit]').forEach(function (b) { b.disabled = true; });
  });
  document.body.addEventListener('htmx:afterRequest', function (e) {
    var elt = e.detail && e.detail.elt;
    if (!elt) return;
    var scope = elt.tagName === 'FORM' ? elt : (elt.closest ? elt.closest('form') : null);
    var root = scope || elt;
    delete root.dataset.busy;
    root.querySelectorAll('button[type=submit]').forEach(function (b) { b.disabled = false; });
  });

  // 全局请求进度条（上传等真实进度由各页面自行处理，此处为整体活跃请求指示）
  var progressEl = null;
  var pendingCount = 0;
  function progressTick(delta) {
    pendingCount = Math.max(0, pendingCount + delta);
    if (!progressEl) {
      progressEl = document.createElement('div');
      progressEl.id = 'wra-progress';
      document.body.appendChild(progressEl);
    }
    if (pendingCount > 0) {
      progressEl.style.opacity = '1';
      progressEl.style.width = pendingCount > 1 ? '90%' : '40%';
    } else {
      progressEl.style.width = '100%';
      progressEl.style.opacity = '0';
      setTimeout(function () { if (progressEl) progressEl.style.width = '0'; }, 300);
    }
  }
  // 被防重逻辑取消的请求不计数（defaultPrevented），避免进度条永久卡住
  document.body.addEventListener('htmx:beforeRequest', function (e) {
    if (e.defaultPrevented) return;
    progressTick(1);
  });
  document.body.addEventListener('htmx:afterRequest', function () { progressTick(-1); });

  // 亮/暗主题切换（顶栏按钮，持久化到 localStorage）
  function syncThemeIcon() {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    var dark = document.documentElement.getAttribute('data-bs-theme') === 'dark';
    btn.innerHTML = '<i class="ti ' + (dark ? 'ti-sun' : 'ti-moon') + '"></i>';
  }
  document.body.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('#theme-toggle');
    if (!btn) return;
    e.preventDefault();
    var next = document.documentElement.getAttribute('data-bs-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-bs-theme', next);
    try { localStorage.setItem('wra_theme', next); } catch (err) { /* 忽略 */ }
    syncThemeIcon();
  });
  syncThemeIcon();

  window.WRA = { showToast: showToast, escapeHtml: escapeHtml };
})();
