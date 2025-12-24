/**
 * ZTE路由器短信通知 - 后台脚本
 * 负责轮询检查短信和发送系统通知
 */

// ==================== 配置 ====================
const DEFAULT_CONFIG = {
  routerUrl: 'http://192.168.0.1',
  routerPassword: '271497',//自己改
  pollInterval: 60, // 秒（Chrome 120+ 已安装扩展最小约 30 秒；未打包扩展开发模式不受限）
  enabled: true,
  notifyOnSms: true,
};

// 运行时状态
let state = {
  isRunning: false,
  lastUnreadCount: 0,
  lastNotifiedIds: new Set(),
  polling: false,
  lastCheckAt: 0,
};

const RUNTIME_STATE_KEY = 'zteSmsNotifierRuntimeState';

async function loadRuntimeState() {
  try {
    const data = await chrome.storage.local.get(RUNTIME_STATE_KEY);
    const saved = data?.[RUNTIME_STATE_KEY];
    if (!saved || typeof saved !== 'object') return;

    const lastUnreadCount = Number(saved.lastUnreadCount);
    if (Number.isFinite(lastUnreadCount)) state.lastUnreadCount = lastUnreadCount;

    const lastCheckAt = Number(saved.lastCheckAt);
    if (Number.isFinite(lastCheckAt)) state.lastCheckAt = lastCheckAt;

    const ids = Array.isArray(saved.lastNotifiedIds) ? saved.lastNotifiedIds : [];
    state.lastNotifiedIds = new Set(ids.map((x) => String(x)));
  } catch (e) {
    console.warn('[ZTE-SMS] loadRuntimeState failed:', e?.message ?? String(e));
  }
}

async function saveRuntimeState() {
  try {
    const ids = Array.from(state.lastNotifiedIds).slice(-200);
    await chrome.storage.local.set({
      [RUNTIME_STATE_KEY]: {
        lastUnreadCount: state.lastUnreadCount,
        lastCheckAt: state.lastCheckAt,
        lastNotifiedIds: ids,
      },
    });
  } catch (e) {
    console.warn('[ZTE-SMS] saveRuntimeState failed:', e?.message ?? String(e));
  }
}

const LOG_KEY = 'zteSmsNotifierLogs';
const MAX_LOG_ENTRIES = 200;
let logBuffer = [];
let logsLoaded = false;

const NOTIFICATION_META_KEY = 'zteSmsNotifierNotificationMeta';
const MAX_NOTIFICATION_META_ENTRIES = 200;
let notificationMeta = null; // { [notificationId]: { ts:number, clickUrl?:string, copyText?:string } }

async function loadNotificationMeta() {
  try {
    const data = await chrome.storage.local.get(NOTIFICATION_META_KEY);
    const saved = data?.[NOTIFICATION_META_KEY];
    notificationMeta = saved && typeof saved === 'object' ? saved : {};
  } catch (e) {
    notificationMeta = {};
    console.warn('[ZTE-SMS] loadNotificationMeta failed:', e?.message ?? String(e));
  }
}

async function saveNotificationMeta() {
  try {
    if (!notificationMeta) await loadNotificationMeta();
    const entries = Object.entries(notificationMeta || {});
    if (entries.length > MAX_NOTIFICATION_META_ENTRIES) {
      entries.sort((a, b) => (Number(a?.[1]?.ts) || 0) - (Number(b?.[1]?.ts) || 0));
      notificationMeta = Object.fromEntries(entries.slice(-MAX_NOTIFICATION_META_ENTRIES));
    }
    await chrome.storage.local.set({ [NOTIFICATION_META_KEY]: notificationMeta });
  } catch (e) {
    console.warn('[ZTE-SMS] saveNotificationMeta failed:', e?.message ?? String(e));
  }
}

async function loadLogs() {
  try {
    const data = await chrome.storage.local.get(LOG_KEY);
    const saved = data?.[LOG_KEY];
    logBuffer = Array.isArray(saved) ? saved : [];
    logsLoaded = true;
  } catch (e) {
    logBuffer = [];
    logsLoaded = true;
    console.warn('[ZTE-SMS] loadLogs failed:', e?.message ?? String(e));
  }
}

async function addLog(level, message, data) {
  if (!logsLoaded) {
    await loadLogs();
  }
  const entry = {
    ts: Date.now(),
    level: String(level || 'info'),
    message: String(message || ''),
    data: data == null ? null : data,
  };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_ENTRIES) {
    logBuffer = logBuffer.slice(-MAX_LOG_ENTRIES);
  }
  try {
    await chrome.storage.local.set({ [LOG_KEY]: logBuffer });
  } catch (e) {
    console.warn('[ZTE-SMS] addLog persist failed:', e?.message ?? String(e));
  }
}

async function clearLogs() {
  if (!logsLoaded) {
    await loadLogs();
  }
  logBuffer = [];
  try {
    await chrome.storage.local.remove(LOG_KEY);
  } catch (e) {
    console.warn('[ZTE-SMS] clearLogs failed:', e?.message ?? String(e));
  }
}

// ==================== Offscreen（剪贴板） ====================
const OFFSCREEN_URL = 'offscreen.html';
let offscreenInitPromise = null;

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) {
    throw new Error('offscreen API 不可用（Chrome 版本可能过旧）');
  }

  try {
    const has = await chrome.offscreen.hasDocument();
    if (has) return;
  } catch {
    // 某些版本可能没有 hasDocument；继续尝试 createDocument
  }

  if (offscreenInitPromise) {
    await offscreenInitPromise;
    return;
  }

  offscreenInitPromise = (async () => {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['CLIPBOARD'],
      justification: '从短信通知中一键复制验证码到剪贴板',
    });
  })();

  try {
    await offscreenInitPromise;
  } finally {
    offscreenInitPromise = null;
  }
}

async function copyToClipboard(text) {
  const value = String(text ?? '').trim();
  if (!value) return;
  await ensureOffscreenDocument();

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await chrome.runtime.sendMessage({
        __zteSmsNotifierTarget: 'offscreen',
        type: 'offscreenCopy',
        text: value,
      });
      if (res && res.success === false) {
        throw new Error(res.message || '复制失败');
      }
      return;
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message ?? e ?? '');
      if (
        msg.toLowerCase().includes('receiving end does not exist') ||
        msg.toLowerCase().includes('could not establish connection')
      ) {
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  throw new Error(lastErr?.message ?? String(lastErr ?? '复制失败'));
}

// ==================== SHA256（WebCrypto） ====================
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

// ==================== 路由器API ====================
const RouterAPI = {
  config: null,

  init(config) {
    let routerUrl = String(config?.routerUrl ?? DEFAULT_CONFIG.routerUrl).trim();
    if (routerUrl && !/^https?:\/\//i.test(routerUrl)) {
      routerUrl = `http://${routerUrl}`;
    }
    routerUrl = routerUrl.replace(/\/+$/, '');
    this.config = { ...DEFAULT_CONFIG, ...(config ?? {}), routerUrl };
  },

  async fetchJson(url, init) {
    const response = await fetch(url, { cache: 'no-store', credentials: 'include', ...init });
    if (!response.ok) {
      throw new Error(`请求失败: HTTP ${response.status} ${response.statusText}`);
    }
    try {
      return await response.json();
    } catch (e) {
      throw new Error('响应解析失败（非JSON）');
    }
  },

  async getLD() {
    const url = `${this.config.routerUrl}/goform/goform_get_cmd_process?isTest=false&cmd=LD&_=${Date.now()}`;
    const json = await this.fetchJson(url);
    if (!json || typeof json.LD !== 'string') {
      throw new Error(`获取LD失败: ${JSON.stringify(json)}`);
    }
    return json.LD;
  },

  async login() {
    const ld = await this.getLD();
    const encPassword = await SHA256.sha256HexUpper(
      await SHA256.sha256HexUpper(this.config.routerPassword) + ld
    );
    const url = `${this.config.routerUrl}/goform/goform_set_cmd_process`;
    const formData = new URLSearchParams({
      isTest: 'false',
      goformId: 'LOGIN',
      password: encPassword,
    });

    const json = await this.fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: formData,
    });
    const result = String(json?.result ?? '');
    const ok = result === '0' || result === '4' || result === 'true';
    if (!ok) {
      throw new Error(`登录失败: ${JSON.stringify(json)}`);
    }
    return json;
  },

  async getSmsStatus() {
    const url = `${this.config.routerUrl}/goform/goform_get_cmd_process?isTest=false&multi_data=1&cmd=sms_received_flag,sms_sts_received_flag,sms_unread_num&_=${Date.now()}`;
    return this.fetchJson(url);
  },

  async getSmsList(page = 0, count = 20) {
    const url = `${this.config.routerUrl}/goform/goform_get_cmd_process?isTest=false&cmd=sms_data_total&page=${page}&data_per_page=${count}&mem_store=1&tags=0&order_by=desc&_=${Date.now()}`;
    return this.fetchJson(url);
  },

  decodeSmsContent(base64Content) {
    if (!base64Content) return '';
    try {
      const cleaned = String(base64Content).replace(/\s+/g, '');
      const bin = atob(cleaned);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

      const isHexUcs2 = (s) => /^[0-9a-fA-F]+$/.test(s) && s.length >= 4 && s.length % 4 === 0;

      const decodeHexUcs2 = (hexText) => {
        const s = String(hexText || '');
        if (!isHexUcs2(s)) return s;
        let out = '';
        for (let i = 0; i < s.length; i += 4) {
          const code = parseInt(s.slice(i, i + 4), 16);
          if (!Number.isFinite(code)) return s;
          out += String.fromCharCode(code);
        }
        return out;
      };

      const decodeUtf16 = (byteArray, littleEndian) => {
        const len = byteArray.length - (byteArray.length % 2);
        let out = '';
        for (let i = 0; i < len; i += 2) {
          const code = littleEndian
            ? (byteArray[i] | (byteArray[i + 1] << 8))
            : ((byteArray[i] << 8) | byteArray[i + 1]);
          out += String.fromCharCode(code);
        }
        return out;
      };

      const decodeUtf8 = () => {
        try {
          return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        } catch {
          // 极老环境兜底：用“二进制字符串”方式（可能仍会乱码）
          return bin;
        }
      };

      const scoreText = (text) => {
        const s = String(text ?? '');
        let cjk = 0;
        let asciiPrintable = 0;
        let digit = 0;
        let whitespace = 0;
        let replacement = 0;
        let control = 0;
        let nul = 0;
        let surrogate = 0;
        let other = 0;

        for (let i = 0; i < s.length; i++) {
          const cp = s.codePointAt(i);
          if (cp > 0xffff) i++;

          if (cp === 0xfffd) replacement++;
          if (cp === 0) nul++;
          if (cp >= 0xd800 && cp <= 0xdfff) surrogate++;

          if (cp === 0x20 || cp === 0x09 || cp === 0x0a || cp === 0x0d) whitespace++;
          else if (cp >= 0x30 && cp <= 0x39) digit++;
          else if (cp >= 0x21 && cp <= 0x7e) asciiPrintable++;
          else if (
            (cp >= 0x4e00 && cp <= 0x9fff) ||
            (cp >= 0x3400 && cp <= 0x4dbf) ||
            (cp >= 0xf900 && cp <= 0xfaff)
          ) {
            cjk++;
          } else if (cp < 0x20) {
            control++;
          } else {
            other++;
          }
        }

        // 更偏好：中日韩字符/可见 ASCII/数字/空白；强烈惩罚：替换字符、NUL、控制字符、代理项
        const score =
          cjk * 6 +
          asciiPrintable * 2 +
          digit * 2 +
          whitespace -
          replacement * 20 -
          nul * 10 -
          control * 3 -
          surrogate * 6 -
          other;
        return { score, cjk, asciiPrintable, digit, whitespace, replacement, nul, control, surrogate, other };
      };

      // 1) 先按 zteAPI 的方式：Base64 -> UTF-8 字符串；如果是 UCS2(HEX) 再二次解码
      const utf8 = decodeUtf8();
      const trimmedUtf8 = utf8.trim();
      if (isHexUcs2(trimmedUtf8)) return decodeHexUcs2(trimmedUtf8);

      // 2) 如果包含 BOM，按 BOM 解码 UTF-16
      if (bytes.length >= 2) {
        const b0 = bytes[0];
        const b1 = bytes[1];
        if (b0 === 0xfe && b1 === 0xff) return decodeUtf16(bytes.slice(2), false);
        if (b0 === 0xff && b1 === 0xfe) return decodeUtf16(bytes.slice(2), true);
      }

      // 3) 如果 UTF-8 明显“不像正常文本”，尝试把 Base64 直接当 UCS2/UTF-16（有些固件会这样返回）
      const utf8Score = scoreText(utf8);
      const looksBadUtf8 = utf8Score.replacement > 0 || utf8Score.nul > 0 || utf8Score.control > 0;

      let utf16Hint = null; // 'be' | 'le' | null
      if (bytes.length >= 4) {
        let zeroEven = 0;
        let zeroOdd = 0;
        const pairs = Math.floor(bytes.length / 2);
        for (let i = 0; i + 1 < bytes.length; i += 2) {
          if (bytes[i] === 0) zeroEven++;
          if (bytes[i + 1] === 0) zeroOdd++;
        }
        const evenRatio = zeroEven / pairs;
        const oddRatio = zeroOdd / pairs;
        if (evenRatio > 0.2 && oddRatio < 0.05) utf16Hint = 'be';
        else if (oddRatio > 0.2 && evenRatio < 0.05) utf16Hint = 'le';
      }

      if ((looksBadUtf8 || utf16Hint) && bytes.length >= 2) {
        if (utf16Hint) {
          const hinted = decodeUtf16(bytes, utf16Hint === 'le');
          const hintedScore = scoreText(hinted);
          if (hintedScore.score > utf8Score.score + 5) return hinted;
        }

        const be = decodeUtf16(bytes, false);
        const le = decodeUtf16(bytes, true);
        const beScore = scoreText(be);
        const leScore = scoreText(le);
        const best = beScore.score >= leScore.score ? be : le;
        const bestScore = Math.max(beScore.score, leScore.score);
        if (bestScore > utf8Score.score + 10) return best;
      }

      return utf8;
    } catch (e) {
      return base64Content;
    }
  },

  getSmsMeta(tag) {
    const t = String(tag ?? '');
    const direction = t === '2' || t === '3' ? 'sent' : 'received';
    const unread = direction === 'received' && t === '1';
    return { tag: t, unread, direction };
  }
};

// ==================== 通知管理 ====================
const FALLBACK_NOTIFICATION_ICON_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAR9SURBVHhe7ZrNS1RRGMb9M2aW/QGt2roIWrWICKKFKykqkKLRokVFuJAgKUIqESoKTUZMIlN01CRzFkVkH2hlUpakIRlamNGHdOK94x3Hc+femTtzbvPxPA/8QC86eN753fe+54wVm5qXFcGlQr9AsKAA4FAAcCgAOBQAHAoADgUAhwKAQwHAoQDgUABwKAA4FAAcCgAOBQCHAoBDAcChAOBQAHAoADgUABwKAA4FAIcCgEMBwKEA4FAAcCgAOBQAHAoADgUAhwKAQwHAoQDgUABwAhEgfHQwQd2ACh/uXv+e+ONIjwrXxpLf63U2QaAChGpuq1D1DRU6EFXhSL9zgSQ9tTEVOti5Xru163qdTRCcAJFetfVYm6qsa7WQrxuu9ap4PE48uBSNqe0n2pN1E0KHEl1Ur7MJAhNAzE1dhM2e+g7V3j3kWDg6fUMjau/ZW456WQLsa7O6gl5nEwQmQDjSp6oaOq0F7Lw84aD14bz6vfpXMUp1jS2o3S0vHTWS2u06HU3MAqXWAQQxu+lmv6q68sqxOKH6+qR6OrOs1wMm0ws/1PGuaUddBBHiVEu3uv9gtERngDUBhMWVP+pM34xjkTbnBj9aP4MS6XzSAfU62IgUs0u/kvUreQHsyN0ud72+YEG6xPDrpQ2FKsdIDfa3vnGs367B3edfkj9bdgJIvv9c9bT/5J33lv3lFll30/CsY7029T0fHF2wLAWwMzm/omrapxyFEOT5J4NRuQyJ0tlymYPKWgA7bhOwIIKIKKUa6WRyZ+vrsmkembM6g1sgBJBkKtTV+CfPQhVjTIgNI4CdXFtlMUXe2EjHW8ffL/h9tMEJIJFByO+wVAzJNNzaWzs/gRTATqbtUmxiUf+VgiWo7S20AJJsD0wKFelEcoil/102+R5wwQtgR56rXkemhfhc4X/MKxRAi4nJOt9Ix3GTURAZTe1YKECaSEv12jLKAGnqDUiNdBgvAWXyNy0gBfCItGC3wUuuj0591X8l52RzahlEKECG5HK+7ify+nJap79u6usHOYRSgCwzPvfd9Q6VQS2XOzSorZ2fUAAfyWbLKP+AkSmFmjHShQLkkGymdLcto3wW77a1k0MpE1s7P6EAecTrzZTHReqbmY80QYYC5JlM7fzCvVnrk0a3rV22j42gQgEM5dG7b2kHui0NY2pz/RO14+L4hutBbu38hAIYTLot3bbzL1Rl47MN1/LdOpoMBQggqYc6cnrXOJD4MMf04ZGJUICAIgNd9PFnSwa524v1P44oAHgoAHgoAHgoAHgoAHgoAHgoAHgoAHgoAHgoAHgoAHgoAHgoAHgoAHgoAHgoAHgoAHgoAHgoAHgoAHgoAHgoAHjKRgCSHxQAnJIVgJhFr7MJKEAJodfZBIEIQEoHCgAOBQCHAoBDAcChAOBQAHAoADgUABwKAA4FAIcCgEMBwKEA4FAAcCgAOBQAHAoADgUAhwKAQwHAoQDgUABwKAA4FAAcCgAOBQCHAoBDAcChAOBQAHAoADgUABwKAA4FAOcf6JCfYynAZwMAAAAASUVORK5CYII=';

const NotificationManager = {
  extractVerificationCode(text) {
    const s = String(text ?? '');
    if (!s.includes('验证码')) return null;
    const idx = s.indexOf('验证码');
    const near = idx >= 0 ? s.slice(idx, Math.min(s.length, idx + 60)) : s;
    const m1 = near.match(/\d{4,6}/);
    if (m1) return m1[0];
    const m2 = s.match(/\d{4,6}/);
    return m2 ? m2[0] : null;
  },

  getSmsPageUrl() {
    const base = String(RouterAPI.config?.routerUrl ?? DEFAULT_CONFIG.routerUrl).replace(/\/+$/, '');
    return `${base}/#sms`;
  },

  async show(title, body, notificationId, onClickUrl, { buttons, copyText } = {}) {
    return new Promise((resolve, reject) => {
      const iconCandidates = [
        'icon128.png',
        'icon48.png',
        'icon16.png',
        FALLBACK_NOTIFICATION_ICON_URL,
      ].filter(Boolean);

      const create = (attemptIndex) => {
        const iconUrl = iconCandidates[Math.max(0, Math.min(iconCandidates.length - 1, attemptIndex))];
        chrome.notifications.create(
          notificationId,
          {
            type: 'basic',
            iconUrl,
            title: title,
            message: body,
            priority: 2,
            requireInteraction: true,
            ...(Array.isArray(buttons) && buttons.length ? { buttons: buttons.slice(0, 2) } : null),
          },
          async (createdId) => {
            const err = chrome.runtime.lastError;
            if (err) {
              const errMsg = err.message || String(err);
              void addLog('error', 'notification.create failed', {
                notificationId,
                title,
                iconUrl,
                error: errMsg,
              });
              if (
                typeof errMsg === 'string' &&
                errMsg.toLowerCase().includes('unable to download all specified images') &&
                attemptIndex + 1 < iconCandidates.length
              ) {
                void addLog('warn', 'notification.create retry with fallback icon', {
                  notificationId,
                  from: iconUrl,
                  to: iconCandidates[attemptIndex + 1],
                });
                create(attemptIndex + 1);
                return;
              }
              reject(new Error(errMsg));
              return;
            }
            if (!createdId) {
              void addLog('error', 'notification.create missing id', { notificationId, title, iconUrl });
              reject(new Error('notificationId missing'));
              return;
            }
            // 存储点击跳转URL
            if (onClickUrl) {
              this.clickUrlMap = this.clickUrlMap || {};
              this.clickUrlMap[createdId] = onClickUrl;
            }
            if (copyText) {
              this.copyTextMap = this.copyTextMap || {};
              this.copyTextMap[createdId] = String(copyText);
            }
            if (onClickUrl || copyText) {
              if (!notificationMeta) await loadNotificationMeta();
              notificationMeta[createdId] = {
                ...(notificationMeta?.[createdId] || {}),
                ts: Date.now(),
                ...(onClickUrl ? { clickUrl: onClickUrl } : null),
                ...(copyText ? { copyText: String(copyText) } : null),
              };
              await saveNotificationMeta();
            }
            void addLog('info', 'notification created', { notificationId: createdId, title });
            resolve(createdId);
          }
        );
      };

      create(0);
    });
  },

  async showSmsNotification(sms) {
    const full = String(sms?.content ?? '');
    const content = full.substring(0, 60) + (full.length > 60 ? '...' : '');
    const title = `新短信 (${this.maskNumber(sms.number)})`;
    const code = this.extractVerificationCode(full);
    const message = code ? `${content}\n验证码: ${code}` : content;
    const buttons = code ? [{ title: '复制验证码' }] : undefined;
    await this.show(title, message, `zte-sms-${sms.id}`, this.getSmsPageUrl(), { buttons, copyText: code });
  },

  maskNumber(num) {
    const s = String(num ?? '');
    if (s.length <= 4) return '***';
    return '*'.repeat(Math.max(4, s.length - 4)) + s.slice(-4);
  }
};

// ==================== 轮询逻辑 ====================
async function pollSms({ force = false } = {}) {
  if ((!state.isRunning && !force) || state.polling) return;

  state.polling = true;
  void addLog('info', 'poll start', { force: !!force });

  try {
    // 登录
    await RouterAPI.login();

    // 获取状态
    const status = await RouterAPI.getSmsStatus();
    const unreadCount = Number(status?.sms_unread_num ?? 0);
    state.lastUnreadCount = unreadCount;
    state.lastCheckAt = Date.now();
    void addLog('info', 'sms status', { unreadCount });

    // 发送状态更新到popup
    chrome.runtime.sendMessage({
      type: 'status',
      unreadCount,
      timestamp: state.lastCheckAt,
    }, () => void chrome.runtime.lastError);

    // 如果有未读且开启通知，获取列表并按短信 ID 去重
    if (unreadCount > 0 && RouterAPI.config?.notifyOnSms) {
      const perPage = Math.min(20, unreadCount);
      const smsListData = await RouterAPI.getSmsList(0, perPage);
      const messages = Array.isArray(smsListData?.messages) ? smsListData.messages : [];

      const smsItems = messages
        .map(m => ({
          id: String(m.id ?? ''),
          number: m.number,
          content: RouterAPI.decodeSmsContent(m.content),
          ...RouterAPI.getSmsMeta(m.tag),
        }))
        .filter(s => s.unread && s.id);
      void addLog('info', 'unread list', { fetched: messages.length, unread: smsItems.length });

      // 通知新短信
      let changed = false;
      let failed = 0;
      for (const sms of smsItems) {
        if (state.lastNotifiedIds.has(sms.id)) continue;
        try {
          await NotificationManager.showSmsNotification(sms);
          state.lastNotifiedIds.add(sms.id);
          changed = true;
        } catch (e) {
          failed++;
          const errMsg = e?.message ?? String(e);
          console.error('[ZTE-SMS] 通知创建失败:', errMsg);
          void addLog('error', 'showSmsNotification failed', { smsId: sms.id, error: errMsg });
        }
      }
      if (changed) await saveRuntimeState();
      if (failed > 0) {
        void addLog('warn', 'some notifications failed', { failed, total: smsItems.length });
      }
    }

    await saveRuntimeState();
  } catch (e) {
    const message = e?.message ?? String(e);
    state.lastCheckAt = Date.now();
    console.error('[ZTE-SMS] 轮询出错:', message);
    void addLog('error', 'poll error', { message });
    chrome.runtime.sendMessage({
      type: 'error',
      message,
      timestamp: state.lastCheckAt,
    }, () => void chrome.runtime.lastError);
  } finally {
    state.polling = false;
  }
}

// ==================== 定时器管理 ====================
function startPolling(interval) {
  const intervalSeconds = Math.max(10, Number(interval) || DEFAULT_CONFIG.pollInterval);
  state.isRunning = true;
  // 立即执行一次
  pollSms();
  // 设置定时器
  chrome.alarms.create('poll', { periodInMinutes: intervalSeconds / 60 });
  updateBadge();
}

function stopPolling() {
  state.isRunning = false;
  chrome.alarms.clear('poll');
  updateBadge();
}

function updateBadge() {
  const text = state.isRunning ? 'ON' : 'OFF';
  const color = state.isRunning ? '#4CAF50' : '#9E9E9E';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

// ==================== 事件监听 ====================

// 定时器事件
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'poll') {
    pollSms();
  }
});

// 扩展安装/更新
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install' || details.reason === 'update') {
    // 初始化配置
    const config = await chrome.storage.sync.get(DEFAULT_CONFIG);
    await chrome.storage.sync.set(config);

    // 如果启用，开始轮询
    if (config.enabled) {
      RouterAPI.init(config);
      startPolling(config.pollInterval);
    }
  }
});

// 消息处理
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 预留给 offscreen 文档的内部消息，避免被后台默认分支拦截
  if (message?.__zteSmsNotifierTarget === 'offscreen') return;

  (async () => {
    try {
      switch (message?.type) {
        case 'getStatus': {
          const config = await chrome.storage.sync.get(DEFAULT_CONFIG);
          sendResponse({
            isRunning: state.isRunning,
            polling: state.polling,
            lastUnreadCount: state.lastUnreadCount,
            timestamp: state.lastCheckAt,
            config,
          });
          break;
        }

        case 'start': {
          const cfg = await chrome.storage.sync.get(DEFAULT_CONFIG);
          RouterAPI.init(cfg);
          startPolling(cfg.pollInterval);
          sendResponse({ success: true });
          break;
        }

        case 'stop': {
          stopPolling();
          sendResponse({ success: true });
          break;
        }

        case 'pollNow': {
          const cfg = await chrome.storage.sync.get(DEFAULT_CONFIG);
          RouterAPI.init(cfg);
          await pollSms({ force: true });
          sendResponse({ success: true });
          break;
        }

        case 'setConfig': {
          await chrome.storage.sync.set(message.config);
          const nextConfig = await chrome.storage.sync.get(DEFAULT_CONFIG);
          RouterAPI.init(nextConfig);
          if (nextConfig.enabled && !state.isRunning) {
            startPolling(nextConfig.pollInterval);
          } else if (!nextConfig.enabled && state.isRunning) {
            stopPolling();
          } else if (state.isRunning) {
            // 更新轮询间隔
            stopPolling();
            startPolling(nextConfig.pollInterval);
          }
          sendResponse({ success: true });
          break;
        }

      case 'resetNotified': {
        state.lastNotifiedIds = new Set();
        state.lastUnreadCount = 0;
        state.lastCheckAt = 0;
        await chrome.storage.local.remove(RUNTIME_STATE_KEY);
        sendResponse({ success: true });
        break;
      }

        case 'testNotification': {
          const cfg = await chrome.storage.sync.get(DEFAULT_CONFIG);
          RouterAPI.init(cfg);
          const now = new Date();
          const id = `zte-sms-test-${Date.now()}`;
          void addLog('info', 'testNotification request', { at: now.toISOString() });
          await NotificationManager.show(
            'ZTE 短信通知（测试）',
            `这是一条测试通知：${now.toLocaleString('zh-CN')}`,
            id,
            NotificationManager.getSmsPageUrl()
          );
          sendResponse({ success: true });
          break;
        }

        case 'getLogs': {
          await loadLogs();
          sendResponse({ success: true, logs: logBuffer });
          break;
        }

        case 'clearLogs': {
          await clearLogs();
          sendResponse({ success: true });
          break;
        }

        default:
          sendResponse({ success: false, message: 'unknown message type' });
      }
    } catch (e) {
      const errMsg = e?.message ?? String(e);
      console.error('[ZTE-SMS] onMessage error:', errMsg);
      sendResponse({ success: false, message: errMsg });
    }
  })();
  return true; // 保持消息通道开放
});

// 通知点击事件
chrome.notifications.onClicked.addListener((notificationId) => {
  const url =
    NotificationManager.clickUrlMap?.[notificationId] ||
    notificationMeta?.[notificationId]?.clickUrl ||
    NotificationManager.getSmsPageUrl();
  if (url) {
    chrome.tabs.create({ url }, () => void chrome.runtime.lastError);
  }
  chrome.notifications.clear(notificationId);
  if (NotificationManager.clickUrlMap) delete NotificationManager.clickUrlMap[notificationId];
  if (NotificationManager.copyTextMap) delete NotificationManager.copyTextMap[notificationId];
  if (notificationMeta && notificationMeta[notificationId]) {
    delete notificationMeta[notificationId];
    void saveNotificationMeta();
  }
});

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  (async () => {
    if (buttonIndex !== 0) return;
    let text = NotificationManager.copyTextMap?.[notificationId];
    if (!text) {
      if (!notificationMeta) await loadNotificationMeta();
      text = notificationMeta?.[notificationId]?.copyText;
      if (text) {
        NotificationManager.copyTextMap = NotificationManager.copyTextMap || {};
        NotificationManager.copyTextMap[notificationId] = text;
      }
    }
    if (!text) {
      void addLog('warn', 'notification button clicked but no copy text', { notificationId, buttonIndex });
      return;
    }
    try {
      await copyToClipboard(text);
      void addLog('info', 'verification code copied', { notificationId, text });
      chrome.notifications.update(
        notificationId,
        { contextMessage: `已复制验证码: ${text}` },
        () => void chrome.runtime.lastError
      );
    } catch (e) {
      const errMsg = e?.message ?? String(e);
      void addLog('error', 'copyToClipboard failed', { notificationId, error: errMsg });
    }
  })();
});

// 初始化
(async () => {
  await loadRuntimeState();
  await loadLogs();
  await loadNotificationMeta();

  // 恢复通知的点击/复制信息（避免 MV3 Service Worker 休眠后丢失内存态）
  NotificationManager.clickUrlMap = {};
  NotificationManager.copyTextMap = {};
  for (const [id, meta] of Object.entries(notificationMeta || {})) {
    if (meta && typeof meta === 'object') {
      if (meta.clickUrl) NotificationManager.clickUrlMap[id] = String(meta.clickUrl);
      if (meta.copyText) NotificationManager.copyTextMap[id] = String(meta.copyText);
    }
  }

  const config = await chrome.storage.sync.get(DEFAULT_CONFIG);
  RouterAPI.init(config);
  if (config.enabled) {
    startPolling(config.pollInterval);
  }
})();
