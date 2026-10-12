/**
 * 扩展打包脚本。
 *
 * 产出两个内容脚本：
 *   effects.js —— 主世界（world: "MAIN"），内联 core + 25 个动效，负责真正挂载。
 *   content.js —— 隔离世界，只做配置桥，把 chrome.storage 的配置 postMessage 给主世界。
 *
 * 为什么要拆成两个：
 *   Edge 内容脚本的隔离环境里 window.customElements 被置为 null（getter 返回 null，
 *   且不可直接赋值），导致 HTMLElement 子类既不能注册也不能 new —— 动效组件起不来。
 *   主世界里 customElements 完整，但它读不到 chrome.storage。两者各司其职。
 *
 * 另外 MV3 明令禁止加载远程代码（远程代码仅 MV2 支持），
 * 所以动效必须全部内联进扩展包，不能运行时从 CDN 动态 import。
 *
 * 用法：node tools/build-extension.mjs
 */

import { build } from 'esbuild';
import { cp, mkdir, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 本脚本位于 extension/tools/，所以上一级就是扩展目录本身。
// npm 项目、入口、静态文件、构建产物全部落在 extension/ 内，仓库根不参与。
const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(extDir, '..');
const distDir = path.join(extDir, 'dist');

/** 需要复制到 dist 的静态文件（相对 extension/） */
const STATIC = ['manifest.json', 'popup.html', 'popup.css', 'popup.js', 'icons'];

/**
 * 注入到 bundle 最前面的守卫。
 *
 * 各动效模块在顶层就调用 customElements.define()，一旦这个全局不可用，
 * 整个脚本会在加载阶段直接抛错、连配置都读不到。这里先探测并打日志，
 * 再补一个只会记录的空实现 —— 环境正常时完全不改变行为。
 */
const BANNER = `(function () {
  var LOG = '[CursorKit]';
  if (typeof customElements !== 'undefined' && customElements && typeof customElements.get === 'function') return;
  console.error(LOG + ' customElements 不可用：typeof=' + (typeof customElements) + ' value=' + String(customElements));
  var registered = Object.create(null);
  try {
    Object.defineProperty(window, 'customElements', {
      value: {
        get: function (n) { return registered[n]; },
        define: function (n, c) { registered[n] = c; },
        whenDefined: function () { return Promise.resolve(); },
        upgrade: function () {}
      },
      writable: true,
      configurable: true
    });
  } catch (e) {
    console.error(LOG + ' 无法安装兜底实现：' + e.message);
  }
  console.error(LOG + ' 已装空实现，动效将无法挂载；请确认 effects.js 声明了 "world": "MAIN"。');
})();`;

/** 两个入口的构建参数 */
const BUNDLES = [
  {
    entry: 'entries/effects.js',
    out: 'effects.js',
    banner: true,   // 顶层会 define 自定义元素，必须带守卫
    note: '主世界：动效本体'
  },
  {
    entry: 'entries/content.js',
    out: 'content.js',
    banner: false,  // 只做 postMessage 桥，不碰 customElements
    note: '隔离世界：配置桥'
  }
];

async function main() {
  if (!existsSync(extDir)) {
    throw new Error(`找不到扩展目录：${extDir}`);
  }

  // 清空旧的 dist，避免上一版的残留文件被打进扩展
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  const sizes = [];

  for (const bundle of BUNDLES) {
    const outfile = path.join(distDir, bundle.out);
    await build({
      entryPoints: [path.join(extDir, bundle.entry)],
      bundle: true,
      format: 'iife',
      target: ['chrome111'],
      outfile,
      legalComments: 'none',
      minify: false,          // 保留可读性，便于商店审核与自查
      sourcemap: false,
      ...(bundle.banner ? { banner: { js: BANNER } } : {}),
      logLevel: 'warning'
    });

    const bytes = (await readFile(outfile)).length;
    sizes.push({ out: bundle.out, kb: bytes / 1024, note: bundle.note });
  }

  // 静态文件
  for (const item of STATIC) {
    const from = path.join(extDir, item);
    if (!existsSync(from)) {
      console.warn(`  跳过（不存在）：${item}`);
      continue;
    }
    await cp(from, path.join(distDir, item), { recursive: true });
  }

  console.log('');
  for (const s of sizes) {
    console.log(`  dist/${s.out.padEnd(12)} ${s.kb.toFixed(1).padStart(8)} KB   ${s.note}`);
  }

  const manifest = JSON.parse(await readFile(path.join(distDir, 'manifest.json'), 'utf8'));
  console.log(`\n  manifest: ${manifest.name} v${manifest.version} (MV${manifest.manifest_version})`);
  console.log(`  输出目录: ${distDir}`);
  console.log('\n  在 Edge 里加载：edge://extensions → 开发人员模式 → 加载解压缩的扩展 → 选 dist 目录\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
