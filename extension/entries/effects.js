/**
 * 主世界脚本：真正挂载光标动效。
 *
 * 为什么必须注入主世界（manifest 的 world: "MAIN"）：
 *   Edge 内容脚本的隔离环境里 window.customElements 被置为 null
 *   （getter 返回 null，且不可赋值，只能 defineProperty 覆盖）。
 *   实测后果是 HTMLElement 子类既不能注册、也不能 new，
 *   连 Object.create + .call() 都过不了 DOM 的 brand check。
 *   只有主世界里 customElements 才是完整的。
 *
 * 主世界读不到 chrome.storage，所以配置由隔离世界的 bridge.js
 * 通过 window.postMessage 送进来。
 */

import { EFFECTS } from '../../src/effects/index.js';

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

/** 当前挂载的元素，null 表示未挂载 */
let mounted = null;

/* ---------- 环境自检 ---------- */

function checkEnvironment() {
  const missing = [];
  if (typeof customElements === 'undefined' || customElements === null) missing.push('customElements');
  else if (typeof customElements.get !== 'function') missing.push('customElements.get');
  if (typeof HTMLElement === 'undefined' || HTMLElement === null) missing.push('HTMLElement');
  if (!document.body) missing.push('document.body');
  return missing;
}

/* ---------- 挂载 ---------- */

function unmount() {
  if (mounted) {
    mounted.remove();
    mounted = null;
  }
}

/** 属性与配置同步：no-cursor / no-wheel 都是实时生效的 */
function syncAttributes(el, settings) {
  if (settings.cursor) el.removeAttribute('no-cursor');
  else el.setAttribute('no-cursor', '');

  if (settings.wheel) el.removeAttribute('no-wheel');
  else el.setAttribute('no-wheel', '');
}

function shouldMount(settings) {
  if (!settings.enabled) return false;
  const list = settings.disabledSites;
  if (Array.isArray(list) && list.includes(location.hostname)) return false;
  try {
    if (window.matchMedia('(hover: none)').matches) return false;
  } catch {
    // matchMedia 不可用时按「有鼠标」处理
  }
  return true;
}

/**
 * 按配置挂载动效。
 * 切换效果必须移除旧元素再建新的 —— 元素名即效果名，换效果等于换标签。
 */
function mount(settings) {
  let key = settings.effect;
  let tag = `cursor-${key}`;

  if (!EFFECTS[tag]) {
    console.warn(`${LOG} 未知效果：${key}，回退到 snow`);
    key = 'snow';
    tag = 'cursor-snow';
  }

  // 同一效果只同步属性，不重建（重建会丢掉粒子状态）
  if (mounted && mounted.tagName.toLowerCase() === tag) {
    syncAttributes(mounted, settings);
    return;
  }

  unmount();

  let el;
  try {
    el = document.createElement(tag);
  } catch (err) {
    console.error(`${LOG} 创建 <${tag}> 失败：${err && err.message}`);
    return;
  }

  syncAttributes(el, settings);

  const host = document.body || document.documentElement;
  if (!host) {
    console.warn(`${LOG} 页面还没有挂载点，跳过`);
    return;
  }
  host.appendChild(el);
  mounted = el;
}

function apply(raw) {
  const settings = { ...DEFAULTS, ...(raw || {}) };
  if (shouldMount(settings)) mount(settings);
  else unmount();
}

/* ---------- 与隔离世界的通信 ---------- */

function onMessage(e) {
  // 只接受本窗口、本扩展发来的消息
  if (e.source !== window) return;
  const data = e.data;
  if (!data || data.type !== MSG) return;
  apply(data.settings);
}

function main() {
  const missing = checkEnvironment();
  if (missing.length) {
    console.error(
      `${LOG} 主世界缺少必要能力，已停止运行：${missing.join(', ')}。` +
      `请确认 manifest 里该脚本声明了 "world": "MAIN"。`
    );
    return;
  }

  console.info(`${LOG} 主世界就绪，等待配置`);

  window.addEventListener('message', onMessage);

  // 告诉隔离世界「我准备好了」，由它回送当前配置
  window.postMessage({ type: READY }, '*');

  // 单页应用会整段替换 body，挂载点需要补回
  try {
    const observer = new MutationObserver(() => {
      if (mounted && !mounted.isConnected) {
        (document.body || document.documentElement).appendChild(mounted);
      }
    });
    if (document.documentElement) {
      observer.observe(document.documentElement, { childList: true });
    }
    window.addEventListener('pagehide', () => {
      observer.disconnect();
      unmount();
    });
  } catch (err) {
    console.warn(`${LOG} 无法监听 DOM 变化：${err && err.message}`);
  }
}

main();
