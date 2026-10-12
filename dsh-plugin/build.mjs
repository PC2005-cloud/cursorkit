// @ts-check
/**
 * 双产物构建。
 *
 * Host 半 → `lib/index.js`，Node 侧 ESM，依赖全部外置。
 * Client 半 → `lib/client.js`，浏览器侧的经典脚本。
 *
 * 客户端产物必须与 DSH 官方的客户端产物同构：
 *
 *   window.__ModuleLoader__.load({
 *     id: "<包名>",
 *     factory: (require) => { <CJS 主体> },
 *   })
 *
 * 做法是让 esbuild 输出 CJS，再用 banner / footer 把它套进上面这层外壳。
 * factory 的 `require` 参数会遮蔽外层的同名标识符，因此 CJS 主体里
 * 所有 `require(...)` 调用都会落到浏览器模块表上。
 */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(root, 'lib');

/** @type {{ name: string }} */
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));

/**
 * 浏览器模块表的内容是固定的（见 dsh-web-frontend 的运行时装配），
 * 只包含 react 家族、cordis 与少数几个 DSH 客户端包。
 * 这些必须留在产物外层，由模块表提供的 require 解析；
 * 其余依赖（含 cursorkit-effects）在构建期打进产物。
 */
const CLIENT_EXTERNAL = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
];

const clientBanner = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`;

const clientFooter = `
    return module.exports;
  },
});
`;

await mkdir(outdir, { recursive: true });

/** Host 半。 */
await build({
  entryPoints: [resolve(root, 'src/index.ts')],
  outfile: resolve(outdir, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  packages: 'external',
  logLevel: 'info',
});

/** Client 半。 */
await build({
  entryPoints: [resolve(root, 'src/client/index.ts')],
  outfile: resolve(outdir, 'client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  external: CLIENT_EXTERNAL,
  banner: { js: clientBanner },
  footer: { js: clientFooter },
  legalComments: 'none',
  logLevel: 'info',
});
