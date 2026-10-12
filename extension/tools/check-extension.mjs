/**
 * 构建产物的自检脚本。
 *
 * 校验扩展 dist 是否完整可用：
 *   - 文件齐全、manifest 合法、权限最小化
 *   - effects.js（主世界）是合法 IIFE，25 个动效全内联，带 customElements 守卫
 *   - content.js（隔离世界）只是配置桥，不含动效、不碰 customElements
 *   - manifest 里两个内容脚本的 world 配置正确
 *
 * 用法：node tools/check-extension.mjs
 */

import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 本脚本位于 extension/tools/，上一级即扩展目录
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const EXPECTED_TAGS = [
  'cursor-snow', 'cursor-ice', 'cursor-pixel', 'cursor-sun', 'cursor-silk',
  'cursor-refract', 'cursor-orb', 'cursor-geom', 'cursor-ball', 'cursor-planet',
  'cursor-mist', 'cursor-code', 'cursor-rainbow', 'cursor-moon', 'cursor-bubble',
  'cursor-ink', 'cursor-doodle', 'cursor-firefang', 'cursor-hole', 'cursor-lightning',
  'cursor-kaleido', 'cursor-cell', 'cursor-fish', 'cursor-firework', 'cursor-radar'
];

const REQUIRED_FILES = [
  'manifest.json', 'effects.js', 'content.js',
  'popup.html', 'popup.css', 'popup.js',
  'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png'
];

let failed = 0;
const ok = (msg) => console.log(`  OK    ${msg}`);
const bad = (msg) => { failed++; console.log(`  FAIL  ${msg}`); };

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

/** 判断 IIFE 开头 */
function isIife(src) {
  const head = src.trimStart().slice(0, 30);
  return head.startsWith('(function') || head.startsWith('(()=>{') || head.startsWith('(() =>');
}

async function main() {
  if (!(await exists(dist))) {
    console.error(`找不到构建产物：${dist}\n先执行 node tools/build-extension.mjs`);
    process.exit(1);
  }

  console.log('文件完整性');
  for (const f of REQUIRED_FILES) {
    if (await exists(path.join(dist, f))) ok(f);
    else bad(`缺少 ${f}`);
  }

  console.log('\nmanifest');
  const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));
  if (manifest.manifest_version === 3) ok('manifest_version = 3');
  else bad(`manifest_version = ${manifest.manifest_version}，应为 3`);

  const scripts = manifest.content_scripts || [];
  const mainCs = scripts.find((cs) => (cs.js || []).includes('effects.js'));
  const isoCs = scripts.find((cs) => (cs.js || []).includes('content.js'));

  if (mainCs && mainCs.world === 'MAIN') ok('effects.js 声明了 world: "MAIN"（动效必须跑在主世界）');
  else bad('effects.js 缺少 world: "MAIN" —— 隔离环境里 customElements 为 null，动效起不来');

  if (isoCs && isoCs.world !== 'MAIN') ok('content.js 在隔离世界（可访问 chrome.storage）');
  else bad('content.js 不应声明 world: "MAIN"，否则读不到 chrome.storage');

  if (scripts.every((cs) => cs.all_frames === false)) ok('两个脚本均 all_frames = false（只注入顶层框架）');
  else bad('存在未显式设为 false 的 all_frames');

  // MV3 禁止远程代码：内容脚本必须全部来自扩展包本地文件
  const remotePattern = /^\s*(https?:)?\/\//;
  if (scripts.flatMap((cs) => cs.js || []).every((s) => !remotePattern.test(s))) {
    ok('内容脚本全部为本地文件（符合 MV3 禁止远程代码）');
  } else {
    bad('内容脚本引用了远程地址，MV3 不允许');
  }

  if ((manifest.permissions || []).length <= 2) ok(`权限最小化：${manifest.permissions.join(', ')}`);
  else bad(`权限偏多：${manifest.permissions.join(', ')}`);

  const missingIcons = [];
  for (const p of Object.values(manifest.icons || {})) {
    if (!(await exists(path.join(dist, p)))) missingIcons.push(p);
  }
  if (!missingIcons.length) ok(`图标齐全（${Object.keys(manifest.icons || {}).length} 个）`);
  else bad(`图标缺失：${missingIcons.join(', ')}`);

  console.log('\neffects.js（主世界 · 动效本体）');
  const fx = await readFile(path.join(dist, 'effects.js'), 'utf8');
  ok(`体积 ${(Buffer.byteLength(fx) / 1024).toFixed(1)} KB`);

  if (isIife(fx)) ok('是 IIFE');
  else bad('不是 IIFE');

  if (fx.includes('typeof customElements')) ok('含 customElements 环境守卫');
  else bad('缺少 customElements 环境守卫');

  if (!/^\s*import\s/m.test(fx) && !/^\s*export\s/m.test(fx)) ok('无 ESM 语法残留');
  else bad('残留 ESM 语法，内容脚本无法执行');

  const missingTags = EXPECTED_TAGS.filter((t) => !fx.includes(t));
  if (!missingTags.length) ok('25 个动效全部内联');
  else bad(`缺少动效：${missingTags.join(', ')}`);

  for (const [label, needle] of [
    ['CursorEffectElement', 'CursorEffectElement'],
    ['Shadow DOM 挂载', 'attachShadow'],
    ['隐藏原生光标', 'cursor: none'],
    ['滚轮监听', 'wheel'],
    ['配置消息监听', 'cursorkit:settings'],
    ['就绪握手', 'cursorkit:ready']
  ]) {
    if (fx.includes(needle)) ok(`含 ${label}`);
    else bad(`缺少 ${label}`);
  }

  console.log('\ncontent.js（隔离世界 · 配置桥）');
  const bridge = await readFile(path.join(dist, 'content.js'), 'utf8');
  const bridgeKB = Buffer.byteLength(bridge) / 1024;
  ok(`体积 ${bridgeKB.toFixed(1)} KB`);

  if (bridgeKB < 20) ok('足够小，确认未把动效打进桥里');
  else bad(`体积 ${bridgeKB.toFixed(1)} KB 偏大，可能误把动效打进来了`);

  if (!bridge.includes('CursorEffectElement') && !bridge.includes('attachShadow')) {
    ok('不含动效实现（职责单一）');
  } else {
    bad('桥里混入了动效实现');
  }

  if (bridge.includes('chrome.storage')) ok('使用 chrome.storage 读配置');
  else bad('没有读 chrome.storage');

  if (bridge.includes('postMessage') && bridge.includes('cursorkit:settings')) {
    ok('通过 postMessage 向主世界下发配置');
  } else {
    bad('缺少向主世界下发配置的逻辑');
  }

  console.log(`\n${failed ? `${failed} 项未通过` : '全部通过'}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
