/**
 * 扩展的运行时协议测试。
 *
 * 端到端验证已经在真实 Edge 里做过（扩展注入页面、动效挂载、拖尾渲染），
 * 这个脚本补的是「配置到挂载」的决策链路：
 *   effects.js 收到配置后，在什么条件下该挂、什么条件下不该挂。
 *
 * 做法：用桩环境加载 effects.js，模拟隔离世界发来的 postMessage，
 * 然后检查挂载结果。
 *
 * 用法：node tools/extension-test.mjs
 */

import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// 本脚本位于 extension/tools/，上一级即扩展目录
const BUNDLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'effects.js');

/* ---------- 桩环境 ---------- */

function makeCtx() {
  return new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'createRadialGradient' || k === 'createLinearGradient') {
        return () => ({ addColorStop() {} });
      }
      if (k === 'createPattern') return () => ({});
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
      if (k === 'measureText') return () => ({ width: 10 });
      return () => {};
    },
    set(t, k, v) { t[k] = v; return true; }
  });
}

/**
 * 桩里必须让 customElements 正常工作 —— 主世界本来就有。
 * 元素由 createElement 造，插入文档时触发 connectedCallback。
 */
function makeEnv({ touch = false, hostname = 'example.com' } = {}) {
  const ctx = makeCtx();
  const appended = [];

  class FakeHTMLElement {
    constructor() {
      this.shadowRoot = null;
      this.clientWidth = 1280;
      this.clientHeight = 720;
      this._attrs = new Set();
      this.parentNode = null;
      this.isConnected = false;
      this.tagName = 'DIV';
    }
    attachShadow() {
      this.shadowRoot = {
        appendChild() {},
        querySelector() { return null; },
        children: []
      };
      return this.shadowRoot;
    }
    setAttribute(n) { this._attrs.add(n); }
    getAttribute(n) { return this._attrs.has(n) ? '' : null; }
    hasAttribute(n) { return this._attrs.has(n); }
    removeAttribute(n) { this._attrs.delete(n); }
    appendChild(c) { c.parentNode = this; c.isConnected = true; return c; }
    remove() {
      this.isConnected = false;
      const i = appended.indexOf(this);
      if (i >= 0) appended.splice(i, 1);
    }
  }

  const registry = new Map();
  const customElements = {
    get: (n) => registry.get(n),
    define: (n, c) => { registry.set(n, c); },
    whenDefined: () => Promise.resolve(),
    upgrade: () => {}
  };

  const body = new FakeHTMLElement();
  body.tagName = 'BODY';

  const makeCanvas = () => {
    const c = {
      width: 0, height: 0, style: {}, parentNode: null,
      setAttribute() {}, getContext: () => ctx, remove() {},
      hasAttribute: () => false, removeAttribute() {}
    };
    c.ownerDocument = { createElement: () => makeCanvas() };
    return c;
  };

  const doc = {
    hidden: false,
    documentElement: body,
    body,
    createElement(tag) {
      const Ctor = registry.get(tag);
      if (Ctor) {
        const el = new Ctor();
        el.tagName = tag.toUpperCase();
        appended.push(el);
        // 主世界里插入文档会触发 connectedCallback
        if (typeof el.connectedCallback === 'function') el.connectedCallback();
        return el;
      }
      return makeCanvas();
    },
    getElementById: () => null,
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {}
  };

  const win = {
    devicePixelRatio: 2,
    innerWidth: 1280,
    innerHeight: 720,
    location: { hostname },
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: touch }),
    postMessage() {}
  };

  return { doc, win, customElements, registry, appended, body };
}

/* ---------- 加载 effects.js 并投递配置 ---------- */

async function run(settings, { touch = false, hostname = 'example.com' } = {}) {
  const env = makeEnv({ touch, hostname });

  globalThis.HTMLElement = Object.getPrototypeOf(env.body).constructor;
  globalThis.customElements = env.customElements;
  globalThis.document = env.doc;
  globalThis.window = env.win;
  globalThis.location = env.win.location;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.Path2D = class {
    addPath() {} moveTo() {} lineTo() {} bezierCurveTo() {} quadraticCurveTo() {}
    arc() {} arcTo() {} ellipse() {} rect() {} roundRect() {} closePath() {}
  };

  // 捕获主世界注册的 message 监听器
  let handler = null;
  env.win.addEventListener = (type, fn) => { if (type === 'message') handler = fn; };

  await import(pathToFileURL(BUNDLE).href + `?t=${Date.now()}${Math.random()}`);
  await new Promise((r) => setTimeout(r, 20));

  // 模拟隔离世界投递配置
  if (handler) handler({ source: env.win, data: { type: 'cursorkit:settings', settings } });

  return env;
}

/* ---------- 断言 ---------- */

let failed = 0;
function check(label, actual, expected) {
  const pass = actual === expected;
  if (!pass) failed++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${pass ? '' : `  期望 ${expected}，实际 ${actual}`}`);
}

function mountedTag(env) {
  const el = env.appended[env.appended.length - 1];
  return el ? el.tagName.toLowerCase() : '(未挂载)';
}

function mountedAttrs(env) {
  const el = env.appended[env.appended.length - 1];
  if (!el) return {};
  return { noCursor: el.hasAttribute('no-cursor'), noWheel: el.hasAttribute('no-wheel') };
}

/* ---------- 用例 ---------- */

async function main() {
  console.log('扩展运行时协议测试\n');

  console.log('1. 默认配置');
  let env = await run({});
  check('挂载 cursor-snow', mountedTag(env), 'cursor-snow');
  check('注册了 25 个元素', env.registry.size, 25);
  check('未加 no-cursor', mountedAttrs(env).noCursor, false);
  check('未加 no-wheel', mountedAttrs(env).noWheel, false);

  console.log('\n2. 指定其它效果');
  env = await run({ effect: 'hole' });
  check('挂载 cursor-hole', mountedTag(env), 'cursor-hole');

  console.log('\n3. 全局关闭');
  env = await run({ enabled: false });
  check('不挂载', mountedTag(env), '(未挂载)');

  console.log('\n4. 站点黑名单命中');
  env = await run({ disabledSites: ['example.com'] });
  check('不挂载', mountedTag(env), '(未挂载)');

  console.log('\n5. 站点黑名单未命中');
  env = await run({ disabledSites: ['other.com'] });
  check('正常挂载', mountedTag(env), 'cursor-snow');

  console.log('\n6. 触摸设备');
  env = await run({}, { touch: true });
  check('不挂载', mountedTag(env), '(未挂载)');

  console.log('\n7. 关闭主题光标与滚轮');
  env = await run({ cursor: false, wheel: false });
  check('挂载了效果', mountedTag(env), 'cursor-snow');
  check('带 no-cursor', mountedAttrs(env).noCursor, true);
  check('带 no-wheel', mountedAttrs(env).noWheel, true);

  console.log('\n8. 未知效果名');
  env = await run({ effect: 'not-a-real-effect' });
  check('回退到 cursor-snow', mountedTag(env), 'cursor-snow');

  console.log(`\n${failed ? `${failed} 项失败` : '全部通过'}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
