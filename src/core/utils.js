/**
 * 通用数学与颜色工具。
 * 逻辑与 html/ 下各动效原型中的「工具函数」段保持一致，避免移植后效果漂移。
 */

export const TAU = Math.PI * 2;

/** 把 v 夹在 [a, b] 区间内 */
export const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));

/** 线性插值 */
export const lerp = (a, b, t) => a + (b - a) * t;

/** [a, b) 区间随机浮点数 */
export const rand = (a, b) => a + Math.random() * (b - a);

/** [a, b] 区间随机整数 */
export const randInt = (a, b) => a + ((Math.random() * (b - a + 1)) | 0);

/**
 * 两个 RGB 颜色按 t 混合。
 * @param {number[]} c1 形如 [r, g, b]
 * @param {number[]} c2 形如 [r, g, b]
 * @param {number} t 0 取 c1，1 取 c2
 * @returns {number[]} 混合后的 [r, g, b]
 */
export const mixColor = (c1, c2, t) => [
  c1[0] + (c2[0] - c1[0]) * t,
  c1[1] + (c2[1] - c1[1]) * t,
  c1[2] + (c2[2] - c1[2]) * t
];
