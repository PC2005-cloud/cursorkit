// 验证 src/effects/index.js 的注册入口
class FakeHTMLElement {
  constructor() { this.shadowRoot = null; this.clientWidth = 1280; this.clientHeight = 720; }
  attachShadow() {
    this.shadowRoot = { appendChild() {}, querySelector() { return null; }, children: [] };
    return this.shadowRoot;
  }
}
const registered = new Map();
globalThis.HTMLElement = FakeHTMLElement;
globalThis.customElements = {
  get(n) { return registered.get(n); },
  define(n, c) { registered.set(n, c); }
};
globalThis.document = { hidden: false, createElement: () => ({}), addEventListener() {}, removeEventListener() {} };
globalThis.window = { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener() {}, removeEventListener() {} };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

import { pathToFileURL } from 'node:url';
import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const mod = await import(pathToFileURL(path.join(here, '..', 'src', 'effects', 'index.js')).href);

console.log('EFFECTS 清单条目:', Object.keys(mod.EFFECTS).length);
for (const k of Object.keys(mod.EFFECTS)) console.log('  ' + k);

// registerAll 应把未注册的补上（导入各模块时已各自注册过，故此处应返回空数组）
const newly = mod.registerAll();
console.log('registerAll() 新注册:', JSON.stringify(newly));
console.log('已注册元素总数:', registered.size);
console.log('命名导出:', Object.keys(mod).filter(k => k !== 'EFFECTS' && k !== 'registerAll').join(', '));

const expected = Object.keys(mod.EFFECTS).length;
const ok = expected > 0 && registered.size === expected;
console.log('清单条目数 = 已注册元素数 =', expected);
console.log(ok ? 'INDEX TEST PASS' : 'INDEX TEST FAIL');
process.exitCode = ok ? 0 : 1;
