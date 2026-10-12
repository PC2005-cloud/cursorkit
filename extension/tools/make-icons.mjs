/**
 * 由 logo.svg 生成扩展所需的方形 PNG 图标。
 *
 * logo.svg 的 viewBox 是 256x280（非正方形），直接缩放会被拉变形，
 * 所以统一按 contain 方式放进正方形画布，并补一层深色底 ——
 * 扩展图标在浏览器工具栏和商店列表里都是小尺寸，透明底会糊成一片。
 *
 * sharp 是可选依赖，脚本会依次尝试几个位置；都找不到就给出提示。
 *
 * 用法：node tools/make-icons.mjs
 */

import { readFile, mkdir, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 本脚本位于 extension/tools/：extDir 是扩展目录，repoRoot 是仓库根
const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(extDir, '..');
const svgPath = path.join(repoRoot, 'logo.svg');
const outDir = path.join(extDir, 'icons');

/** 与站点深色主题一致的底色 */
const BG = { r: 11, g: 13, b: 18, alpha: 1 };

const SIZES = [16, 32, 48, 128];

/** 图形占画布的比例，留一点边距让小图标不顶边 */
const INSET = 0.86;

/** sharp 的候选位置：本扩展依赖优先，其次是本机已装的副本 */
const SHARP_CANDIDATES = [
  path.join(extDir, 'node_modules', 'sharp', 'dist', 'index.mjs'),
  path.join(extDir, 'node_modules', 'sharp', 'lib', 'index.js'),
  'D:/Software/env/nvm/v24.19.0/node_modules/@deepseek-ai/dsh/node_modules/sharp/dist/index.mjs',
  'D:/Software/env/nvm/v24.19.0/node_modules/@deepseek-ai/dsh/node_modules/sharp/lib/index.js'
];

async function loadSharp() {
  for (const candidate of SHARP_CANDIDATES) {
    try {
      await access(candidate);
    } catch {
      continue;
    }
    try {
      const mod = await import(pathToFileURL(candidate).href);
      const sharp = mod.default ?? mod;
      if (typeof sharp === 'function') return sharp;
    } catch {
      // 该位置存在但加载失败（例如原生二进制不匹配），试下一个
    }
  }
  throw new Error(
    '找不到可用的 sharp。请在本项目执行 npm i -D sharp，或手动准备 16/32/48/128 的 PNG 图标。'
  );
}

async function main() {
  if (!existsSync(svgPath)) throw new Error(`找不到 ${svgPath}`);

  const sharp = await loadSharp();
  await mkdir(outDir, { recursive: true });

  const svg = await readFile(svgPath);

  for (const size of SIZES) {
    const inner = Math.round(size * INSET);

    // 先把 SVG 等比缩到 inner 见方（透明底），再合成到深色方画布上
    const glyph = await sharp(svg, { density: 384 })
      .resize(inner, inner, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .png()
      .toBuffer();

    await sharp({
      create: { width: size, height: size, channels: 4, background: BG }
    })
      .composite([{ input: glyph, gravity: 'center' }])
      .png({ compressionLevel: 9 })
      .toFile(path.join(outDir, `icon${size}.png`));

    console.log(`  icon${size}.png`);
  }

  console.log(`\n  输出目录: ${outDir}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
