/**
 * ZTE短信通知 - 选项页面脚本
 */

document.addEventListener('DOMContentLoaded', init);

const SHA256 = {
  async sha256HexUpper(input) {
    const data = new TextEncoder().encode(String(input ?? ""));
    const digest = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
  },
};

function normalizeRouterUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return DEFAULT_CONFIG.routerUrl;
  const hasScheme = /^https?:\/\//i.test(raw);
  const candidate = hasScheme ? raw : `http://${raw}`;
  try {
    const url = new URL(candidate);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

// DOM元素
const els = {
  routerUrl: document.getElementById('router-url'),
  devicePassword: document.getElementById('device-password'),
  pollInterval: document.getElementById('poll-interval'),
  enabled: document.getElementById('enabled'),
  notifyOnSms: document.getElementById('notify-on-sms'),
  markReadAfterNotify: document.getElementById('mark-read-after-notify'),
  btnSave: document.getElementById('btn-save'),
  btnReset: document.getElementById('btn-reset'),
  btnTest: document.getElementById('btn-test'),
  testResult: document.getElementById('test-result'),
  btnNotifyTest: document.getElementById('btn-notify-test'),
  notifyResult: document.getElementById('notify-result'),
  btnLogRefresh: document.getElementById('btn-log-refresh'),
  btnLogClear: document.getElementById('btn-log-clear'),
  logOutput: document.getElementById('log-output'),
};

const DEFAULT_CONFIG = {
  routerUrl: 'http://192.168.0.1',
  // 兼容：历史版本使用 routerPassword；新增 devicePassword 作为“设备密码”配置项
  routerPassword: '271497',//需要自己改
  // devicePassword 为空时，自动回退到 routerPassword
  devicePassword: '',
  pollInterval: 60,
  enabled: true,
  notifyOnSms: true,
  markReadAfterNotify: true,
};

async function init() {
  // 加载配置
  const config = await chrome.storage.sync.get(DEFAULT_CONFIG);
  els.routerUrl.value = normalizeRouterUrl(config.routerUrl) || String(config.routerUrl ?? '');
  els.devicePassword.value = config.devicePassword || config.routerPassword || DEFAULT_CONFIG.routerPassword;
  els.pollInterval.value = Math.max(10, Number(config.pollInterval) || DEFAULT_CONFIG.pollInterval);
  els.enabled.checked = config.enabled;
  els.notifyOnSms.checked = config.notifyOnSms;
  els.markReadAfterNotify.checked = config.markReadAfterNotify;

  // 绑定事件
  els.btnSave.addEventListener('click', saveConfig);
  els.btnReset.addEventListener('click', resetConfig);
  els.btnTest.addEventListener('click', testConnection);

  els.btnNotifyTest.addEventListener('click', testNotification);
  els.btnLogRefresh.addEventListener('click', refreshLogs);
  els.btnLogClear.addEventListener('click', clearLogs);

  await refreshLogs();
}

async function saveConfig() {
  const pollIntervalSecondsRaw = parseInt(els.pollInterval.value, 10);
  const pollIntervalSeconds = Math.min(
    600,
    Math.max(10, Number.isFinite(pollIntervalSecondsRaw) ? pollIntervalSecondsRaw : 10)
  );
  const routerUrl = normalizeRouterUrl(els.routerUrl.value);
  if (!routerUrl) {
    showToast('路由器地址格式不正确');
    return;
  }

  const config = {
    routerUrl,
    devicePassword: els.devicePassword.value || DEFAULT_CONFIG.routerPassword,
    // 写入旧键名，避免历史代码/缓存仍读取 routerPassword
    routerPassword: els.devicePassword.value || DEFAULT_CONFIG.routerPassword,
    pollInterval: pollIntervalSeconds,
    enabled: els.enabled.checked,
    notifyOnSms: els.notifyOnSms.checked,
    markReadAfterNotify: els.markReadAfterNotify.checked,
  };

  els.routerUrl.value = routerUrl;
  if (String(els.pollInterval.value) !== String(pollIntervalSeconds)) {
    els.pollInterval.value = String(pollIntervalSeconds);
  }

  await chrome.storage.sync.set(config);

  // 通知background更新
  await chrome.runtime.sendMessage({
    type: 'setConfig',
    config,
  });

  showToast('设置已保存');
}

async function resetConfig() {
  els.routerUrl.value = DEFAULT_CONFIG.routerUrl;
  els.devicePassword.value = DEFAULT_CONFIG.routerPassword;
  els.pollInterval.value = DEFAULT_CONFIG.pollInterval;
  els.enabled.checked = DEFAULT_CONFIG.enabled;
  els.notifyOnSms.checked = DEFAULT_CONFIG.notifyOnSms;
  els.markReadAfterNotify.checked = DEFAULT_CONFIG.markReadAfterNotify;

  showToast('已重置为默认');
}

async function testNotification() {
  els.btnNotifyTest.classList.add('loading');
  els.btnNotifyTest.querySelector('.icon').textContent = '⏳';

  try {
    const res = await chrome.runtime.sendMessage({ type: 'testNotification' });
    if (res && res.success === false) {
      throw new Error(res.message || '后台执行失败');
    }
    showNotifyResult('测试通知已发送（若未弹出，请检查 Windows/Chrome 通知设置）', true);
  } catch (e) {
    showNotifyResult('测试通知失败: ' + (e?.message ?? String(e)), false);
  } finally {
    els.btnNotifyTest.classList.remove('loading');
    els.btnNotifyTest.querySelector('.icon').textContent = '🔔';
    await refreshLogs();
  }
}

function formatLogEntry(entry) {
  const ts = Number(entry?.ts);
  const time = Number.isFinite(ts)
    ? new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '--:--:--';
  const level = String(entry?.level ?? 'info').toUpperCase();
  const message = String(entry?.message ?? '');
  let data = '';
  if (entry && Object.prototype.hasOwnProperty.call(entry, 'data') && entry.data != null) {
    try {
      data = JSON.stringify(entry.data);
    } catch {
      data = String(entry.data);
    }
  }
  return `[${time}] [${level}] ${message}${data ? ` ${data}` : ''}`;
}

async function refreshLogs() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'getLogs' });
    if (!res || res.success === false) {
      throw new Error(res?.message || '无法获取日志');
    }
    const logs = Array.isArray(res.logs) ? res.logs : [];
    els.logOutput.textContent = logs.length ? logs.map(formatLogEntry).join('\n') : '（暂无日志）';
  } catch (e) {
    els.logOutput.textContent = `（获取日志失败）${e?.message ?? String(e)}`;
  }
}

async function clearLogs() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'clearLogs' });
    if (res && res.success === false) {
      throw new Error(res.message || '清空失败');
    }
    els.logOutput.textContent = '（暂无日志）';
    showToast('日志已清空');
  } catch (e) {
    showToast('清空日志失败: ' + (e?.message ?? String(e)));
  }
}

async function testConnection() {
  const url = normalizeRouterUrl(els.routerUrl.value);
  const password = els.devicePassword.value;

  if (!url) {
    showTestResult('路由器地址格式不正确', false);
    return;
  }

  els.routerUrl.value = url;
  els.btnTest.classList.add('loading');
  els.btnTest.querySelector('.icon').textContent = '⏳';

  try {
    // 1. 获取LD
    const ldUrl = `${url}/goform/goform_get_cmd_process?isTest=false&cmd=LD&_=${Date.now()}`;
    const ldResponse = await fetch(ldUrl);
    if (!ldResponse.ok) throw new Error('无法连接到路由器');
    const ldData = await ldResponse.json();
    if (!ldData.LD) throw new Error('获取登录令牌失败');

    // 2. 登录
    const encPassword = await SHA256.sha256HexUpper(
      await SHA256.sha256HexUpper(password) + ldData.LD
    );
    const loginUrl = `${url}/goform/goform_set_cmd_process`;
    const formData = new URLSearchParams({
      isTest: 'false',
      goformId: 'LOGIN',
      password: encPassword,
    });

    const loginResponse = await fetch(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: formData,
    });

    const loginData = await loginResponse.json();
    const result = String(loginData?.result ?? '');
    if (!['0', '4', 'true'].includes(result)) {
      throw new Error('密码错误或登录失败');
    }

    showTestResult('连接成功！路由器登录正常', true);
  } catch (e) {
    showTestResult('连接失败: ' + e.message, false);
  } finally {
    els.btnTest.classList.remove('loading');
    els.btnTest.querySelector('.icon').textContent = '🔗';
  }
}

function showTestResult(message, success) {
  els.testResult.textContent = message;
  els.testResult.className = `test-result ${success ? 'success' : 'error'}`;
}

function showNotifyResult(message, success) {
  els.notifyResult.textContent = message;
  els.notifyResult.className = `test-result ${success ? 'success' : 'error'}`;
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    bottom: 30px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0,0,0,0.85);
    color: white;
    padding: 12px 24px;
    border-radius: 8px;
    font-size: 14px;
    z-index: 10000;
  `;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}
