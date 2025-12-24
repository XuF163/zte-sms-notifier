/**
 * ZTE短信通知 - Popup脚本
 */

document.addEventListener('DOMContentLoaded', init);

let currentStatus = null;
let config = null;

// DOM元素
const els = {
  badge: document.getElementById('status-badge'),
  unreadCount: document.getElementById('unread-count'),
  lastCheck: document.getElementById('last-check'),
  btnToggle: document.getElementById('btn-toggle'),
  btnCheck: document.getElementById('btn-check'),
  btnReset: document.getElementById('btn-reset'),
  errorContainer: document.getElementById('error-container'),
  errorMessage: document.getElementById('error-message'),
  linkOptions: document.getElementById('link-options'),
  linkRouter: document.getElementById('link-router'),
};

async function init() {
  // 获取配置
  config = await chrome.storage.sync.get({
    routerUrl: 'http://192.168.0.1',
    routerPassword: '271497',
    enabled: true,
  });

  // 设置路由器链接
  const routerUrl = String(config.routerUrl || '').trim();
  els.linkRouter.href = /^https?:\/\//i.test(routerUrl) ? routerUrl : `http://${routerUrl}`;

  // 绑定事件
  els.btnToggle.addEventListener('click', togglePolling);
  els.btnCheck.addEventListener('click', checkNow);
  els.btnReset.addEventListener('click', resetNotification);
  els.linkOptions.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // 获取状态并更新UI
  await updateStatus();

  // 监听后台消息
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'status') {
      updateStatusDisplay(message.unreadCount, message.timestamp);
    } else if (message.type === 'error') {
      showError(message.message);
      const unread = parseInt(els.unreadCount.textContent, 10);
      updateStatusDisplay(Number.isFinite(unread) ? unread : 0, message.timestamp);
    }
  });
}

async function updateStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'getStatus' });
    currentStatus = response;

    // 更新UI
    const isRunning = response.isRunning;
    els.badge.textContent = isRunning ? '运行中' : '已停止';
    els.badge.className = `badge ${isRunning ? 'running' : 'stopped'}`;

    els.btnToggle.innerHTML = isRunning
      ? '<span class="icon">⏸</span><span class="text">停止轮询</span>'
      : '<span class="icon">▶</span><span class="text">开始轮询</span>';

    updateStatusDisplay(response.lastUnreadCount || 0, response.timestamp);
    hideError();
  } catch (e) {
    showError('无法获取状态: ' + e.message);
  }
}

function updateStatusDisplay(unreadCount, timestamp) {
  els.unreadCount.textContent = unreadCount;
  els.unreadCount.style.color = unreadCount > 0 ? '#F44336' : '#2196F3';

  if (timestamp) {
    const date = new Date(timestamp);
    els.lastCheck.textContent = formatTime(date);
  }
}

async function togglePolling() {
  try {
    if (currentStatus?.isRunning) {
      await chrome.runtime.sendMessage({ type: 'stop' });
    } else {
      await chrome.runtime.sendMessage({ type: 'start' });
    }
    await updateStatus();
  } catch (e) {
    showError('操作失败: ' + e.message);
  }
}

async function checkNow() {
  els.btnCheck.classList.add('loading');
  els.btnCheck.querySelector('.icon').textContent = '⏳';

  try {
    // 强制轮询一次（不改变“启用自动轮询”的配置）
    const response = await chrome.runtime.sendMessage({ type: 'pollNow' });
    if (response && response.success === false) {
      throw new Error(response.message || '后台执行失败');
    }
    await updateStatus();
  } catch (e) {
    showError('检查失败: ' + e.message);
  } finally {
    els.btnCheck.classList.remove('loading');
    els.btnCheck.querySelector('.icon').textContent = '🔄';
  }
}

async function resetNotification() {
  try {
    await chrome.runtime.sendMessage({ type: 'resetNotified' });
    els.unreadCount.textContent = '0';
    els.unreadCount.style.color = '#2196F3';
    showToast('通知已重置');
  } catch (e) {
    showError('重置失败: ' + e.message);
  }
}

function showError(message) {
  els.errorMessage.textContent = message;
  els.errorContainer.classList.remove('hidden');
}

function hideError() {
  els.errorContainer.classList.add('hidden');
}

function showToast(message) {
  // 临时显示消息
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    bottom: 10px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0,0,0,0.8);
    color: white;
    padding: 8px 16px;
    border-radius: 4px;
    font-size: 12px;
    z-index: 1000;
  `;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2000);
}

function formatTime(date) {
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;

  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
