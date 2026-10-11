/**
 * 动效注册入口。
 *
 * 用法（按需引入，带 tree-shaking，不会打包用不到的动效）：
 *
 *   import 'cursorkit/src/effects/snow.js';          // 只引入雪花
 *   import { CursorSnow } from '.../snow.js';        // 需要类时
 *
 *   import { registerAll } from 'cursorkit/src/effects/index.js';
 *   registerAll();                                    // 一次性注册全部
 *
 * 每新增一个动效，只需在此追加一行 import 与一项清单条目。
 */

import { CursorSnow } from './snow.js';
import { CursorIce } from './ice.js';
import { CursorPixel } from './pixel.js';
import { CursorSun } from './sun.js';
import { CursorSilk } from './silk.js';
import { CursorRefract } from './refract.js';
import { CursorOrb } from './orb.js';
import { CursorGeom } from './geom.js';
import { CursorBall } from './ball.js';
import { CursorPlanet } from './planet.js';
import { CursorMist } from './mist.js';
import { CursorCode } from './code.js';
import { CursorRainbow } from './rainbow.js';
import { CursorMoon } from './moon.js';
import { CursorBubble } from './bubble.js';
import { CursorInk } from './ink.js';
import { CursorDoodle } from './doodle.js';
import { CursorFirefang } from './firefang.js';
import { CursorHole } from './hole.js';
import { CursorLightning } from './lightning.js';
import { CursorKaleido } from './kaleido.js';
import { CursorCell } from './cell.js';
import { CursorFish } from './fish.js';
import { CursorFirework } from './firework.js';
import { CursorRadar } from './radar.js';

/** 已实现的动效清单：自定义元素名 -> 类 */
export const EFFECTS = {
  'cursor-snow': CursorSnow,
  'cursor-ice': CursorIce,
  'cursor-pixel': CursorPixel,
  'cursor-sun': CursorSun,
  'cursor-silk': CursorSilk,
  'cursor-refract': CursorRefract,
  'cursor-orb': CursorOrb,
  'cursor-geom': CursorGeom,
  'cursor-ball': CursorBall,
  'cursor-planet': CursorPlanet,
  'cursor-mist': CursorMist,
  'cursor-code': CursorCode,
  'cursor-rainbow': CursorRainbow,
  'cursor-moon': CursorMoon,
  'cursor-bubble': CursorBubble,
  'cursor-ink': CursorInk,
  'cursor-doodle': CursorDoodle,
  'cursor-firefang': CursorFirefang,
  'cursor-hole': CursorHole,
  'cursor-lightning': CursorLightning,
  'cursor-kaleido': CursorKaleido,
  'cursor-cell': CursorCell,
  'cursor-fish': CursorFish,
  'cursor-firework': CursorFirework,
  'cursor-radar': CursorRadar
};

/**
 * 注册全部动效。
 * 重复调用安全：已注册过的元素名会被跳过。
 * @returns {string[]} 本次实际注册的元素名
 */
export function registerAll() {
  const registered = [];

  for (const [tag, ctor] of Object.entries(EFFECTS)) {
    if (customElements.get(tag)) continue;
    customElements.define(tag, ctor);
    registered.push(tag);
  }

  return registered;
}

export {
  CursorSnow, CursorIce, CursorPixel, CursorSun, CursorSilk,
  CursorRefract, CursorOrb, CursorGeom, CursorBall, CursorPlanet,
  CursorMist, CursorCode, CursorRainbow, CursorMoon, CursorBubble, CursorInk,
  CursorDoodle, CursorFirefang, CursorHole, CursorLightning, CursorKaleido,
  CursorCell, CursorFish, CursorFirework, CursorRadar
};
