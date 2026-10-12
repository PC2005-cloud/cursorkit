/**
 * 隔离世界脚本（配置桥）。
 *
 * 它不挂载任何动效，只做一件事：把 chrome.storage 里的配置送进主世界。
 *
 * 为什么不在这里直接挂载：Edge 内容脚本的隔离环境里 window.customElements
 * 被置为 null，HTMLElement 子类无法注册也无法 new，动效组件根本起不来。
 * 主世界（effects.js）里 customElements 是完整的，但它读不到 chrome.storage。
 * 两者用 window.postMessage 对接。
 */

const MSG = 'cursorkit:settings';
const READY = 'cursorkit:ready';
const LOG = '[CursorKit]';

const DEFAULTS = {
  enabled: true,
  effect: 'snow',
  cursor: true,
  wheel: true,
  disabledSites: []
};

/** 最近一次读到的配置，主世界就绪时回送 */
let lastSettings = { ...DEFAULTS };

async function loadSettings() {
  try {
    const raw = await chrome.storage.sync.get(DEFAULTS);
    return { ...DEFAULTS, ...raw };
  } catch (err) {
    console.warn(`${LOG} 读取配置失败，使用默认值：${err && err.message}`);
    return { ...DEFAULTS };
  }
}

/** 把配置送进主世界 */
function push(settings) {
  lastSettings = settings;
  try {
    window.postMessage({ type: MSG, settings }, '*');
  } catch (err) {
    console.warn(`${LOG} 无法向主世界发送配置：${err && err.message}`);
  }
}

async function refresh() {
  push(await loadSettings());
}

async function main() {
  if (typeof chrome === 'undefined' || !chrome.storage) {
    console.error(`${LOG} chrome.storage 不可用，扩展上下文可能已失效`);
    return;
  }

  // 主世界脚本就绪后会喊一声，这时把当前配置送过去
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.type !== READY) return;
    push(lastSettings);
  });

  await refresh();

  // 配置变化实时生效（popup 里改一下就能看到）
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      refresh();
    });
  } catch (err) {
    console.warn(`${LOG} 无法监听配置变化：${err && err.message}`);
  }
}

main();
