/**
 * 通用动效冒烟测试桩。
 * 用法: node smoke-all.mjs [effectKey ...]
 * 不传参数则测试 src/effects 下所有已注册的动效模块。
 *
 * 它做的事：
 *   1. 用假 DOM 加载指定动效模块（真实 import，会执行自定义元素注册）
 *   2. 实例化并挂载，驱动基类真实 rAF 循环
 *   3. 按 inputFamily 派发正确事件族（mouse* 或 pointer*）
 *   4. 统计状态变化、NaN 扫描、卸载后监听器是否归零
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 以脚本自身位置为基准定位项目，避免硬编码绝对路径
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EFFECTS_DIR = path.join(ROOT, 'src/effects');

// ---------- 假 DOM ----------
function makeEnv() {
  const listeners = new Map();   // window 监听器
  const docListeners = new Map(); // document 监听器
  const raf = { cb: null };
  const grad = { addColorStop() {} };

  const ctxCalls = new Set();
  const counters = { ops: 0 };
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'createRadialGradient' || k === 'createLinearGradient') {
        return () => { ctxCalls.add(String(k)); counters.ops++; return grad; };
      }
      if (k === 'createPattern') return () => ({});
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
      if (k === 'measureText') return () => ({ width: 10 });
      return (...a) => { ctxCalls.add(String(k)); counters.ops++; };
    },
    set(t, k, v) { t[k] = v; counters.ops++; return true; }
  });

  const canvas = {
    width: 0, height: 0, style: {}, parentNode: null,
    setAttribute() {}, getContext: () => ctx, remove() {}
  };
  // 真实 canvas 一定带 ownerDocument；动效可能用它创建离屏画布
  canvas.ownerDocument = {
    createElement: () => {
      const c = {
        width: 0, height: 0, style: {}, parentNode: null,
        setAttribute() {}, getContext: () => ctx, remove() {}
      };
      c.ownerDocument = canvas.ownerDocument;
      return c;
    }
  };

  const win = {
    devicePixelRatio: 2, innerWidth: 1280, innerHeight: 720,
    addEventListener(t, fn) { listeners.set(t, fn); },
    removeEventListener(t) { listeners.delete(t); }
  };
  const doc = {
    hidden: false,
    createElement: () => canvas,
    getElementById: () => canvas,
    querySelector: () => canvas,
    addEventListener(t, fn) { docListeners.set(t, fn); },
    removeEventListener(t) { docListeners.delete(t); }
  };
  return { listeners, docListeners, raf, ctx, canvas, win, doc, ctxCalls, grad, get ops() { return counters.ops; } };
}

function installGlobals(env) {
  globalThis.HTMLElement = FakeHTMLElement;
  globalThis.customElements = {
    _m: new Map(),
    get(n) { return this._m.get(n); },
    define(n, c) { this._m.set(n, c); }
  };
  globalThis.document = env.doc;
  globalThis.window = env.win;
  globalThis.requestAnimationFrame = (cb) => { env.raf.cb = cb; return 1; };
  globalThis.cancelAnimationFrame = () => {};
}

class FakeHTMLElement {
  constructor() { this.shadowRoot = null; this.clientWidth = 1280; this.clientHeight = 720; }
  attachShadow() {
    this.shadowRoot = { appendChild() {}, querySelector() { return null; }, children: [] };
    return this.shadowRoot;
  }
}

// Path2D 是浏览器标准 API，动效可能用它构造路径；桩必须提供
class FakePath2D {
  addPath() {}
  moveTo() {}
  lineTo() {}
  bezierCurveTo() {}
  quadraticCurveTo() {}
  arc() {}
  arcTo() {}
  ellipse() {}
  rect() {}
  roundRect() {}
  closePath() {}
}
globalThis.Path2D = FakePath2D;

// ---------- 单模块测试 ----------
async function testEffect(file) {
  const key = path.basename(file, '.js');
  const env = makeEnv();
  installGlobals(env);

  const mod = await import('file:///' + file.replace(/\\/g, '/') + '?t=' + Date.now());
  const Ctor = mod.default || Object.values(mod).find(v => typeof v === 'function' && v.prototype);
  if (!Ctor) throw new Error('模块未导出类');

  const el = new Ctor();
  el.connectedCallback();

  const fam = el.inputFamily === 'mouse' ? 'mouse' : 'pointer';
  const s = el.state;

  // 按事件族派发
  const fire = (type, ev) => {
    const h = env.listeners.get(type);
    if (h) h(ev);
  };

  let now = 0;
  const frame = (ms = 16.7) => { now += ms; if (env.raf.cb) env.raf.cb(now); };

  // 1) 移动 60 帧，制造拖尾
  const ops0 = env.ops;
  const snap0 = stateFingerprint(s);
  for (let i = 0; i < 60; i++) {
    fire(fam + 'move', { clientX: 300 + i * 12, clientY: 300 + Math.sin(i / 3) * 80 });
    frame();
  }
  const opsMove = env.ops - ops0;
  // 关键断言：移动阶段 state 必须发生变化。
  // 不依赖任何字段名（各动效池对象的存活标记叫 alive 或 active，池数组长度也各异），
  // 只看「状态指纹是否变化」——拖尾失效时 state 会保持不动。
  const partsAfterMove = stateFingerprint(s) !== snap0 ? 1 : 0;

  // 2) 左键长按 60 帧后释放（应触发某种爆发）
  const ops1 = env.ops;
  fire(fam + 'down', { button: 0, clientX: 600, clientY: 400 });
  for (let i = 0; i < 60; i++) frame();
  fire(fam + 'up', { button: 0, clientX: 600, clientY: 400 });
  frame();
  const opsLeft = env.ops - ops1;

  // 3) 右键长按 40 帧后释放
  const ops2 = env.ops;
  fire(fam + 'down', { button: 2, clientX: 700, clientY: 350 });
  for (let i = 0; i < 40; i++) frame();
  fire(fam + 'up', { button: 2, clientX: 700, clientY: 350 });
  frame();
  const opsRight = env.ops - ops2;

  const afterMove = opsMove;
  const afterLeft = opsLeft;
  const afterRight = opsRight;

  // 4) blur 收尾
  fire('blur', {});
  frame();

  // 5) NaN / Infinity 扫描
  const bad = scanNaN(s);

  // 6) 卸载，检查监听器归零
  el.disconnectedCallback();
  const winLeft = env.listeners.size;
  const docLeft = env.docListeners.size;

  return {
    key,
    fam,
    afterMove,
    afterLeft,
    afterRight,
    partsAfterMove,
    bad: bad.length,
    badSample: bad.slice(0, 3),
    winLeft,
    docLeft,
    ctxCalls: [...env.ctxCalls].sort().join(',')
  };
}

/**
 * 状态指纹：把 state 里所有数值字段拼成一个字符串，用于判断「状态是否发生变化」。
 * 不依赖字段命名，也不依赖池数组的长度或存活标记叫什么。
 */
function stateFingerprint(s) {
  if (!s) return '';
  const parts = [];
  const seen = new Set();
  const walk = (o, d) => {
    if (!o || d > 3 || seen.has(o) || typeof o !== 'object') return;
    seen.add(o);
    if (Array.isArray(o)) {
      // 只取前若干元素的数值字段，足够判断"是否变了"
      for (let i = 0; i < Math.min(o.length, 60); i++) {
        const v = o[i];
        if (typeof v === 'number') parts.push(v);
        else if (v && typeof v === 'object') {
          for (const k of Object.keys(v)) {
            if (typeof v[k] === 'number') parts.push(v[k]);
          }
        }
      }
      return;
    }
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === 'number' || typeof v === 'boolean') parts.push(v);
      else if (v && typeof v === 'object') walk(v, d + 1);
    }
  };
  walk(s, 0);
  return parts.join(',');
}

/**
 * 统计活跃粒子数。不同动效用的字段名不同（alive / active），
 * 必须同时认，否则会误报"没有粒子"。仅用于报告，不作为通过条件。
 */
function countParticles(s) {
  if (!s) return 0;
  let n = 0;
  const seen = new Set();
  const scan = (o, d) => {
    if (!o || d > 3 || seen.has(o) || typeof o !== 'object') return;
    seen.add(o);
    if (Array.isArray(o)) {
      if (o.length > 20 && o[0] && typeof o[0] === 'object') {
        n += o.filter(p => p && (p.alive === true || p.active === true)).length;
      }
      return;
    }
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (v && typeof v === 'object') scan(v, d + 1);
    }
  };
  scan(s, 0);
  return n;
}

function countAlive(s) {
  if (!s) return 0;
  // 池对象可能用 alive 或 active 标记存活；也可能嵌在子对象里（如 s.forge.active）
  let total = 0;
  const seen = new Set();
  const scan = (o, d) => {
    if (!o || d > 3 || seen.has(o)) return;
    if (typeof o !== 'object') return;
    seen.add(o);
    if (Array.isArray(o)) {
      if (o.length > 20 && o[0] && typeof o[0] === 'object') {
        total += o.filter(p => p && (p.alive === true || p.active === true)).length;
      }
      return;
    }
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (Array.isArray(v) || (v && typeof v === 'object')) scan(v, d + 1);
    }
  };
  scan(s, 0);
  return total;
}

function scanNaN(s) {
  const bad = [];
  if (!s) return bad;
  const seen = new Set();
  const walk = (o, p, d) => {
    if (d > 3 || o == null) return;
    if (typeof o === 'number') {
      if (!Number.isFinite(o)) bad.push(p + '=' + o);
      return;
    }
    if (typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === 'number' && !Number.isFinite(v)) bad.push(p + '.' + k + '=' + v);
    }
  };
  for (const k of Object.keys(s)) {
    const v = s[k];
    if (typeof v === 'number' && !Number.isFinite(v)) bad.push(k + '=' + v);
    else if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) walk(v[i], k + '[' + i + ']', 1);
    } else if (v && typeof v === 'object') walk(v, k, 1);
  }
  return bad;
}

// ---------- 主流程 ----------
const args = process.argv.slice(2);
let files;
if (args.length) {
  files = args.map(a => path.join(EFFECTS_DIR, a.endsWith('.js') ? a : a + '.js'));
} else {
  files = fs.readdirSync(EFFECTS_DIR)
    .filter(f => f.endsWith('.js') && f !== 'index.js')
    .map(f => path.join(EFFECTS_DIR, f));
}

console.log('待测模块数:', files.length);
console.log('');

let pass = 0, fail = 0;
const rows = [];

for (const f of files) {
  const key = path.basename(f, '.js');
  try {
    const r = await testEffect(f);
    const ok = r.bad === 0 && r.winLeft === 0 && r.docLeft === 0 && r.afterMove > 0 && r.afterLeft > 0 && r.partsAfterMove > 0;
    if (ok) pass++; else fail++;
    rows.push(r);
    console.log(
      (ok ? 'PASS ' : 'FAIL ') + key.padEnd(10) +
      ' 族=' + r.fam.padEnd(7) +
      ' 移动ops=' + String(r.afterMove).padStart(6) + ' 粒子=' + String(r.partsAfterMove).padStart(5) +
      ' 左键ops=' + String(r.afterLeft).padStart(6) +
      ' 右键ops=' + String(r.afterRight).padStart(6) +
      ' NaN=' + r.bad +
      ' 残留监听=' + (r.winLeft + r.docLeft) +
      (ok ? '' : '  <<< ' + (r.bad ? r.badSample.join(' ') : (r.partsAfterMove === 0 ? '移动阶段无粒子生成(拖尾失效!)' : (r.afterMove === 0 ? '移动阶段无绘制活动' : '监听器未归零'))))
    );
  } catch (e) {
    fail++;
    console.log('ERROR ' + key.padEnd(10) + ' ' + (e && e.message ? e.message : String(e)));
  }
}

console.log('');
console.log('合计: PASS=' + pass + '  FAIL=' + fail);
process.exitCode = fail === 0 ? 0 : 1;
