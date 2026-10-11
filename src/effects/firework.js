/**
 * cursor-firework —— 鼠标光标烟火动效（左键牡丹爆 / 右键连环垂柳）。
 *
 * 由 html/烟火.html 原型移植：算法流程、数值、视觉表现与原文件一一对应。
 * 作为光标层组件，原型页面自身的行为已剔除：
 *   - 原型画布本来就是透明的（render 里只有 clearRect，暗底由页面 body 的 #07070d 提供），
 *     所以没有需要删除的整屏铺底；粒子、光核、光晕、火线等有明确形状的填充全部保留；
 *   - 不拦截 contextmenu（原型自行屏蔽原生右键菜单），统一交给基类处理；
 *   - 画布创建、DPR 适配、尺寸同步、监听注册、rAF 循环全部由基类负责；
 *   - 鼠标速度：基类的 input.vx / vy 是平滑值且带「>300px 跳变归零 / 6000 封顶」保护，
 *     而原型用的是未平滑的 mouse.vx / mouse.vy（原始逐帧位移 / dt，对跳变不做任何处理）。
 *     为与原型逐帧一致，本动效按原型口径另算一份原始速度存入 state（s.rawVx / s.rawVy）。
 *   - 位移锚点：原型按「上一帧结束位置 → 当前位置」取整帧位移（第 397 行取 mouse.x - mouse.px，
 *     第 1273 行在每帧末尾推进 mouse.px），本动效在 state 上维护一份同口径的帧级锚点
 *     （s.anchorX / s.anchorY），而不是直接用基类的 frameLx/frameLy：
 *     原型还有两处会改写这个锚点，基类锚点不感知 —— mousedown 会把锚点重置到按下位置
 *     （第 366-369 行）、inside 为 false 时的首次移动只做对齐（第 328-331 行）。
 *     逐帧差分验证表明，缺了这两处会在每次按下鼠标的那一帧凭空多出一段拖尾
 *     （详见 emitTrail 上方注释）。
 *
 * 原型监听 mousemove / mousedown / mouseup，因此声明 inputFamily = 'mouse'。
 * 所有运行状态（粒子池、空闲栈、蓄力态、生成累加器、延迟任务、原始速度）都在 setup()
 * 返回的 state 上，多实例互不干扰。
 */

import { CursorEffectElement } from '../core/base.js';
import { TAU, clamp, rand } from '../core/utils.js';

// ==================== 配置（所有可调参数集中在此） ====================
const CONFIG = {
  // 对象池粒子上限（超出后回收剩余寿命最短的粒子）
  maxParticles: 3000,

  // 暖色组（左键）：炽白 / 亮金 / 橙 / 朱红 / 洋红
  warmPalette: [
    [255, 255, 255],
    [255, 210, 74],
    [255, 138, 30],
    [255, 61, 61],
    [255, 46, 158]
  ],

  // 冷色组（右键）：炽白 / 青 / 翠绿 / 电紫 / 品红
  coolPalette: [
    [255, 255, 255],
    [79, 240, 208],
    [61, 255, 122],
    [138, 92, 255],
    [255, 92, 224]
  ],

  // 物理重力 px/s²
  gravity: 320,
  willowGravityMul: 1.4,     // 垂柳重力倍率（比左键高约 40%）

  // 鼠标拖尾参数
  trail: {
    enableSpeed: 40,          // 低于此速度不产生拖尾
    sparkRateK: 0.16,         // 每 px/s 速度对应的火星生成率
    streakRateK: 0.055,       // 每 px/s 速度对应的火花条生成率
    maxSparkRate: 300,
    maxStreakRate: 110,
    inheritMin: 0.4,          // 鼠标速度继承系数下限
    inheritMax: 0.8,          // 鼠标速度继承系数上限
    sparkLifeMin: 0.35,
    sparkLifeMax: 0.80,
    streakLifeMin: 0.18,
    streakLifeMax: 0.45,
    sparkDrag: 3.2,           // 火星空气阻力系数
    streakDrag: 5.0           // 火花条阻力系数
  },

  // 蓄力参数
  charge: {
    fullTime: 2.5,            // 完整蓄力时长
    minTime: 0.12,            // 低于此时长视为普通单击
    powerExp: 1.6,            // 强度曲线指数
    coreRadiusMax: 26,        // 蓄力起始核心半径
    coreRadiusMin: 8,         // 蓄满核心半径
    haloRadiusMin: 40,        // 前兆光晕最小半径
    haloRadiusMax: 160,       // 前兆光晕最大半径
    haloAlphaMin: 0.05,
    haloAlphaMax: 0.30,
    jitterStart: 0.5,         // 开始微震的蓄力进度
    jitterMax: 3              // 最大抖动像素
  },

  // 左键爆发参数
  burst: {
    baseCount: 90,
    countK: 320,
    baseSpeed: 340,
    speedK: 1150,
    shockRadius: 170,
    shockRadiusK: 350,
    shockImpulse: 900,
    shockImpulseK: 900,
    emberRatio: 0.25
  },

  // 右键连环礼花参数
  chain: {
    interval: 0.09,           // 每段爆炸间隔
    baseTimes: 3,
    timesK: 2,
    decay: 0.72,              // 逐次规模衰减
    upAngleMin: 10,           // 垂柳上扬角下限（度）
    upAngleMax: 25,           // 垂柳上扬角上限（度）
    spread: 35                // 每段爆点随机偏移半径
  },

  // 烟团
  smoke: {
    lifeMin: 1.1,
    lifeMax: 1.9,
    alphaMax: 0.07,
    warmColor: [90, 55, 35],  // 暖灰橙
    coolColor: [45, 70, 95]   // 冷青紫
  }
};

// ==================== 粒子池 ====================
// 字段与原型 Particle() 完全一致（含两个原型写入后从未读取的字段，见下方注释）
function makeParticle() {
  return {
    active: false,
    type: 0,        // 0 火星 / 1 火花条 / 2 烟团 / 3 闪点 / 4 光核
    x: 0, y: 0,
    px: 0, py: 0,
    vx: 0, vy: 0,
    life: 0, maxLife: 1,
    size: 1, baseSize: 1,
    pal: 0,         // 0 暖色组 / 1 冷色组
    colorBias: 0,   // 颜色进度偏移
    dragK: 3,
    gravMul: 1,
    ignite: 0,      // 二次点燃强度 0~1
    attract: 0,     // 向心引力强度
    gx: 0, gy: 0,
    col: [255, 255, 255],
    fixedCol: false,
    expand: 0,      // 烟团扩散速度
    rise: 0,        // 烟团上升速度
    rot: 0,         // 原型写入后从未读取（spawnFlash 会取一次随机数）
    flicker: 1      // 原型写入后从未读取
  };
}

function allocParticle(s) {
  const pool = s.pool;
  const freeStack = s.freeStack;
  let p;
  if (freeStack.length > 0) {
    p = pool[freeStack.pop()];
  } else {
    // 池满：回收剩余寿命最短的粒子
    let best = 0, bestLife = Infinity;
    for (let i = 0; i < pool.length; i++) {
      if (pool[i].life < bestLife) { bestLife = pool[i].life; best = i; }
    }
    p = pool[best];
  }
  p.active = true;
  p.ignite = 0;
  p.colorBias = 0;
  p.dragK = 3;
  p.gravMul = 1;
  p.attract = 0;
  p.gx = 0; p.gy = 0;
  p.fixedCol = false;
  p.expand = 0;
  p.rise = 0;
  p.rot = 0;
  p.flicker = 1;
  return p;
}

// ==================== 工具函数 ====================
// 从配色组取样，t 为 0~1 的进度（out 为调用方提供的暂存数组，对应原型的 _colOut）
function getColor(pal, t, out) {
  const arr = pal === 0 ? CONFIG.warmPalette : CONFIG.coolPalette;
  const n = arr.length - 1;
  let f = t * n;
  if (f < 0) f = 0; else if (f > n) f = n;
  let i = Math.floor(f);
  if (i >= n) i = n - 1;
  const k = f - i;
  const a = arr[i], b = arr[i + 1];
  out[0] = a[0] + (b[0] - a[0]) * k;
  out[1] = a[1] + (b[1] - a[1]) * k;
  out[2] = a[2] + (b[2] - a[2]) * k;
  return out;
}

// ---- 定时器（统一管理，避免重复触发）----
// 原型用闭包延迟执行；移植后改为「数据记录 + 触发时按类型分派」，
// 记录里只存参数，不把闭包留在实例上。触发顺序与原型一致：
// 倒序遍历，同一帧内到期的多个任务按插入序的倒序触发。
function after(s, delay, rec) {
  rec.t = delay;
  s.timers.push(rec);
}

function updateTimers(s, dt) {
  const timers = s.timers;
  for (let i = timers.length - 1; i >= 0; i--) {
    const tm = timers[i];
    tm.t -= dt;
    if (tm.t <= 0) {
      timers.splice(i, 1);
      if (tm.kind === 'smoke') {
        // 余烟：抖动在触发时刻才取随机数，与原型闭包内的写法一致
        spawnSmoke(s, tm.x + rand(-tm.j, tm.j), tm.y + rand(-tm.j, tm.j), tm.pal);
      } else if (tm.kind === 'willow') {
        willowBurst(s, tm.x, tm.y, tm.spd, tm.k);
      } else {
        blowTrails(s, tm.x, tm.y, tm.strength, tm.dx, tm.dy);
      }
    }
  }
}

// ---- 生成器 ----
function makeBase(s, type, x, y, vx, vy, life, size, pal, bias, gravMul, dragK) {
  const p = allocParticle(s);
  p.type = type;
  p.x = x; p.y = y; p.px = x; p.py = y;
  p.vx = vx; p.vy = vy;
  p.life = life; p.maxLife = life;
  p.size = size; p.baseSize = size;
  p.pal = pal;
  p.colorBias = bias || 0;
  p.gravMul = gravMul === undefined ? 1 : gravMul;
  p.dragK = dragK === undefined ? 3 : dragK;
  return p;
}

function spawnSpark(s, x, y, vx, vy, life, size, pal, bias, gravMul, dragK) {
  return makeBase(s, 0, x, y, vx, vy, life, size, pal, bias, gravMul, dragK);
}

function spawnStreak(s, x, y, vx, vy, life, size, pal, bias, gravMul, dragK) {
  return makeBase(s, 1, x, y, vx, vy, life, size, pal, bias, gravMul, dragK);
}

function spawnFlash(s, x, y, life, size, pal) {
  const p = makeBase(s, 3, x, y, 0, 0, life, size, pal, 0, 0, 0);
  // 原型在此取一次随机数赋给 p.rot，而 p.rot 后续从未被读取；
  // 保留这一行是为了维持与原型完全相同的随机数消耗顺序。
  p.rot = Math.random() * TAU;
  return p;
}

function spawnCore(s, x, y, life, size, pal) {
  return makeBase(s, 4, x, y, 0, 0, life, size, pal, 0, 0, 0);
}

function spawnSmoke(s, x, y, pal) {
  const p = makeBase(s, 2, x, y, rand(-18, 18), rand(-30, -8),
    rand(CONFIG.smoke.lifeMin, CONFIG.smoke.lifeMax), rand(18, 44), pal, 0, 0, 0.8);
  p.expand = rand(28, 68);
  p.rise = rand(14, 34);
  const c = pal === 0 ? CONFIG.smoke.warmColor : CONFIG.smoke.coolColor;
  p.col[0] = c[0]; p.col[1] = c[1]; p.col[2] = c[2];
  p.fixedCol = true;
  return p;
}

// ==================== 蓄力状态收尾 ====================
function resetChargeAcc(s) {
  s.intakeAcc = 0; s.ventAcc = 0; s.boilAcc = 0; s.starAcc = 0; s.coolAcc = 0;
  s.absorbed = 0;
}

function cancelHold(s) {
  const hold = s.hold;
  if (!hold.active) return;
  hold.active = false;
  hold.btn = -1;
  resetChargeAcc(s);
  // 解除所有粒子的向心引力
  const pool = s.pool;
  for (let i = 0; i < pool.length; i++) {
    if (pool[i].active) pool[i].attract = 0;
  }
}

// ==================== 火星拖尾 ====================
// 锚点用 state 上的帧级锚点 anchorX / anchorY，对应原型的 mouse.px / mouse.py：
// 原型第 397 行取 mdx = mouse.x - mouse.px，mouse.px 只在每帧更新函数内推进
// （第 1273 行 mouse.px = mouse.x），语义是「上一帧结束时的位置」。
// 基类的 frameLx/frameLy 现在是同一口径（上一帧结束位置），但原型还有两处会改写锚点，
// 基类锚点并不感知，缺了它们会在按下鼠标的那一帧凭空多出一段拖尾：
//   1. mousedown 把锚点重置到按下位置（第 366-369 行）；
//   2. inside 为 false 时的首次移动只做对齐、该帧位移为 0（第 328-331 行）。
// 因此这里自行维护一份锚点，既与原型逐帧一致，也不受 core 侧改动影响。
// 一帧内发生多次移动时同样取整帧位移（lx/ly 只是最后一段位移的起点，不适用于本动效）。
function emitTrail(s, dt) {
  const M = s.input;

  // 原型 inside 为 false 时不产生拖尾、速度归零，且随后的第一次移动只把锚点对齐到当前位置
  // （第 328-331 行：`if (!mouse.inside) { mouse.px = e.clientX; ... }`）。
  // 原型初始 inside 即为 false（第 288 行），基类初始为 true，进入页面时还会先触发 mouseenter
  // 把它置 true，因此这里不依赖 inside，而是用「光标位置是否真的变化」判定这次对齐：
  //   - 位置没变 → 与原型一样只归零速度（锚点留待首次移动时对齐）；
  //   - 位置变了且基类标记光标在窗口内 → 视为收到原型那次首次 mousemove，只对齐锚点。
  if (s.outside) {
    if (M.inside && (M.x !== s.outX || M.y !== s.outY)) {
      s.outside = false;
      s.anchorX = M.x; s.anchorY = M.y;   // 等价于原型 mouse.px = mouse.x
    }
    s.rawVx = 0; s.rawVy = 0;
    return;
  }

  const mdx = M.x - s.anchorX;
  const mdy = M.y - s.anchorY;
  const dist = Math.sqrt(mdx * mdx + mdy * mdy);

  if (!M.inside || dist < 0.01) {
    s.rawVx = 0; s.rawVy = 0;
    return;
  }

  const speed = dist / dt;
  s.rawVx = mdx / dt;
  s.rawVy = mdy / dt;

  if (speed < CONFIG.trail.enableSpeed) return;

  const T = CONFIG.trail;
  const sparkRate = Math.min(speed * T.sparkRateK, T.maxSparkRate);
  const streakRate = Math.min(speed * T.streakRateK, T.maxStreakRate);

  s.trailSparkAcc += sparkRate * dt;
  s.trailStreakAcc += streakRate * dt;

  let i, k, bx, by;

  // 火星
  let sparkN = Math.floor(s.trailSparkAcc);
  if (sparkN > 60) sparkN = 60;
  s.trailSparkAcc -= sparkN;
  for (i = 0; i < sparkN; i++) {
    k = Math.random();
    bx = s.anchorX + mdx * k + rand(-3, 3);
    by = s.anchorY + mdy * k + rand(-3, 3);
    const inh = rand(T.inheritMin, T.inheritMax);
    const ang = Math.random() * TAU;
    const sc = rand(35, 165);
    const vx = s.rawVx * inh + Math.cos(ang) * sc;
    const vy = s.rawVy * inh + Math.sin(ang) * sc;
    const life = rand(T.sparkLifeMin, T.sparkLifeMax);
    const size = rand(0.8, 2.2);
    const p = spawnSpark(s, bx, by, vx, vy, life, size, 0, 0, 1, T.sparkDrag);
    // 蓄力中：拖尾被核心牵引
    if (s.hold.active && s.hold.btn === 0 && s.hold.vis > 0.05) {
      p.attract = 260 + 520 * s.hold.vis;
      p.gx = s.hold.cx; p.gy = s.hold.cy;
    }
  }

  // 火花条
  let streakN = Math.floor(s.trailStreakAcc);
  if (streakN > 24) streakN = 24;
  s.trailStreakAcc -= streakN;
  for (i = 0; i < streakN; i++) {
    k = Math.random();
    bx = s.anchorX + mdx * k + rand(-3, 3);
    by = s.anchorY + mdy * k + rand(-3, 3);
    const inh2 = rand(0.5, 0.95);
    const ang2 = Math.random() * TAU;
    const sc2 = rand(30, 140);
    const vx2 = s.rawVx * inh2 + Math.cos(ang2) * sc2;
    const vy2 = s.rawVy * inh2 + Math.sin(ang2) * sc2;
    const life2 = rand(T.streakLifeMin, T.streakLifeMax);
    const size2 = rand(0.9, 2.0);
    const q = spawnStreak(s, bx, by, vx2, vy2, life2, size2, 0, 0, 1, T.streakDrag);
    if (s.hold.active && s.hold.btn === 0 && s.hold.vis > 0.05) {
      q.attract = 260 + 520 * s.hold.vis;
      q.gx = s.hold.cx; q.gy = s.hold.cy;
    }
  }
}

// ==================== 单击爆点（左键） ====================
function clickBurst(s, x, y) {
  const N = 26 + Math.floor(Math.random() * 11); // 26~36
  for (let i = 0; i < N; i++) {
    const a = Math.random() * TAU;
    const spd = rand(260, 620);
    const vx = Math.cos(a) * spd;
    const vy = Math.sin(a) * spd;
    const bias = rand(-0.15, 0.05);
    if (Math.random() < 0.6) {
      spawnSpark(s, x, y, vx, vy, rand(0.35, 0.8), rand(0.9, 2.2), 0, bias, 1, 2.2);
    } else {
      spawnStreak(s, x, y, vx, vy, rand(0.22, 0.5), rand(1.2, 2.6), 0, bias, 1, 2.0);
    }
  }

  // 实心光核
  spawnCore(s, x, y, 0.12, 14, 0);

  // 十字闪点
  spawnFlash(s, x, y, 0.1, 15, 0);

  // 极淡烟团
  for (let i = 0; i < 4; i++) {
    after(s, i * 0.05, { kind: 'smoke', x: x, y: y, j: 24, pal: 0 });
  }

  // 对拖尾的复燃冲击
  shockTrails(s, x, y, CONFIG.burst.shockRadius, 700);
  shockTrailsStreaks(s, x, y);
}

function shockTrails(s, x, y, radius, impulse) {
  const r2 = radius * radius;
  const pool = s.pool;
  for (let i = 0; i < pool.length; i++) {
    const p = pool[i];
    if (!p.active) continue;
    if (p.type > 1) continue;
    if (p.attract > 0) continue;
    const dx = p.x - x, dy = p.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) continue;
    const d = Math.sqrt(d2) || 0.001;
    const falloff = 1 - d / radius;
    const imp = impulse * falloff;
    p.vx += (dx / d) * imp;
    p.vy += (dy / d) * imp;
    // 二次点燃
    p.ignite = 1;
    p.life = Math.max(p.life, Math.min(p.maxLife, 0.4));
  }
}

function shockTrailsStreaks(s, x, y) {
  const n = 6 + Math.floor(Math.random() * 5);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU;
    const spd = rand(280, 700);
    spawnStreak(s, x, y, Math.cos(a) * spd, Math.sin(a) * spd,
      rand(0.25, 0.5), rand(1.4, 2.6), 0, -0.25, 1, 1.8);
  }
}

// ==================== 普通右键点击 ====================
function rightClickBurst(s, x, y) {
  const N = 20 + Math.floor(Math.random() * 10);
  for (let i = 0; i < N; i++) {
    const a = Math.random() * TAU;
    const spd = rand(180, 480);
    spawnSpark(s, x, y, Math.cos(a) * spd, Math.sin(a) * spd,
      rand(0.35, 0.8), rand(0.9, 2.0), 1, rand(-0.2, 0.05), 1.3, 2.4);
  }

  // 一圈破碎弧
  const segs = 5 + Math.floor(Math.random() * 3);
  for (let si = 0; si < segs; si++) {
    const a0 = (si / segs) * TAU + Math.random() * 0.15;
    const span = (TAU / segs) * 0.5;
    for (let k = 0; k < 8; k++) {
      const ang = a0 + (k / 8) * span;
      const spd2 = rand(220, 400);
      spawnSpark(s, x, y, Math.cos(ang) * spd2, Math.sin(ang) * spd2,
        rand(0.4, 0.9), rand(0.9, 1.8), 1, -0.2, 1.3, 2.0);
    }
  }

  spawnCore(s, x, y, 0.1, 10, 1);
  spawnFlash(s, x, y, 0.1, 12, 1);

  for (let i = 0; i < 3; i++) {
    after(s, i * 0.05, { kind: 'smoke', x: x, y: y, j: 20, pal: 1 });
  }
}

// ==================== 左键蓄力 ====================
function updateWarmCharge(s, dt) {
  const hold = s.hold;
  const vis = hold.vis;
  const p = Math.min(vis, 1);
  const cx = hold.cx, cy = hold.cy;

  // 1. 引信倒喷：从外向内吸入火星
  s.intakeAcc += (50 + 230 * p) * dt;
  let n1 = Math.floor(s.intakeAcc);
  if (n1 > 30) n1 = 30;
  s.intakeAcc -= n1;
  for (let i = 0; i < n1; i++) {
    const a = Math.random() * TAU;
    const R = rand(90, 220);
    const sx = cx + Math.cos(a) * R;
    const sy = cy + Math.sin(a) * R;
    const dx = cx - sx, dy = cy - sy;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const travel = rand(0.28, 0.62);
    const spd = d / travel;
    const tang = rand(-0.45, 0.45);
    const ux = dx / d, uy = dy / d;
    const vx = ux * spd - uy * spd * tang;
    const vy = uy * spd + ux * spd * tang;
    const q = spawnSpark(s, sx, sy, vx, vy, travel, rand(0.6, 1.6), 0,
      rand(-0.15, 0.05), 0, 0.15);
    q.attract = 220;
    q.gx = cx; q.gy = cy;
  }

  // 2. 核心反向喷溅
  s.ventAcc += (28 + 150 * p) * dt;
  let n2 = Math.floor(s.ventAcc);
  if (n2 > 24) n2 = 24;
  s.ventAcc -= n2;
  for (let j = 0; j < n2; j++) {
    const a2 = Math.random() * TAU;
    const spd2 = rand(50, 190) * (0.5 + p);
    spawnSpark(s, cx, cy, Math.cos(a2) * spd2, Math.sin(a2) * spd2 - rand(20, 90),
      rand(0.14, 0.32), rand(0.6, 1.4), 0, 0.05, 1, 4);
  }

  // 3. 表面沸腾：短弧弹跳
  s.boilAcc += (36 + 250 * p) * dt;
  let n3 = Math.floor(s.boilAcc);
  if (n3 > 30) n3 = 30;
  s.boilAcc -= n3;
  const coreR = CONFIG.charge.coreRadiusMax -
    (CONFIG.charge.coreRadiusMax - CONFIG.charge.coreRadiusMin) * p;
  for (let k = 0; k < n3; k++) {
    const a3 = Math.random() * TAU;
    const spd3 = rand(70, 220) * (0.4 + p);
    spawnSpark(
      s,
      cx + Math.cos(a3) * coreR,
      cy + Math.sin(a3) * coreR,
      Math.cos(a3) * spd3,
      Math.sin(a3) * spd3 - rand(70, 160),
      rand(0.16, 0.36), rand(0.6, 1.4), 0, 0, 1, 2.6
    );
  }

  // 4. 蓄满：零星四芒星闪点
  if (vis >= 0.99) {
    s.starAcc += rand(8, 12) * dt;
    let n4 = Math.floor(s.starAcc);
    if (n4 > 4) n4 = 4;
    s.starAcc -= n4;
    for (let m = 0; m < n4; m++) {
      const a4 = Math.random() * TAU;
      const R4 = rand(18, 85);
      spawnFlash(s, cx + Math.cos(a4) * R4, cy + Math.sin(a4) * R4,
        rand(0.08, 0.2), rand(7, 16), 0);
    }
  }
}

// ==================== 右键蓄力 ====================
function updateCoolCharge(s, dt) {
  const hold = s.hold;
  const vis = hold.vis;
  const p = Math.min(vis, 1);
  const cx = hold.cx, cy = hold.cy;
  const ringCount = 1 + Math.floor(p * 2.99);

  // 火线旋转
  for (let i = 0; i < 3; i++) {
    const dir = (i % 2 === 0) ? 1 : -1;
    hold.ringAngle[i] += dir * (2.0 + 6.0 * p) * dt * (1 + i * 0.18);
  }

  // 火线甩尾：沿切向剥落火星
  s.coolAcc += (45 + 170 * p) * dt;
  let n = Math.floor(s.coolAcc);
  if (n > 24) n = 24;
  s.coolAcc -= n;
  const baseR = 30 + 100 * p;
  for (let k = 0; k < n; k++) {
    let ri = Math.floor(Math.random() * ringCount);
    if (ri > 2) ri = 2;
    const radius = baseR * (1 - ri * 0.28);
    const a = Math.random() * TAU;
    const sx = cx + Math.cos(a) * radius;
    const sy = cy + Math.sin(a) * radius;
    const dir2 = (ri % 2 === 0) ? 1 : -1;
    const tangSpeed = radius * (2.0 + 6.0 * p) * dir2;
    const vx = -Math.sin(a) * tangSpeed * 0.55;
    const vy = Math.cos(a) * tangSpeed * 0.55;
    spawnSpark(s, sx, sy, vx, vy, rand(0.12, 0.3), rand(0.6, 1.5), 1,
      rand(-0.1, 0.15), 0, 4);
  }

  // 蓄满：环绕四芒星闪光
  if (vis >= 0.99) {
    s.starAcc += rand(6, 10) * dt;
    let n2 = Math.floor(s.starAcc);
    if (n2 > 4) n2 = 4;
    s.starAcc -= n2;
    for (let m = 0; m < n2; m++) {
      const a2 = Math.random() * TAU;
      const R2 = baseR * (1 - Math.floor(Math.random() * ringCount) * 0.28);
      spawnFlash(s, cx + Math.cos(a2) * R2, cy + Math.sin(a2) * R2,
        rand(0.08, 0.18), rand(6, 14), 1);
    }
  }
}

// ==================== 蓄力可视化绘制 ====================
function drawWarmHalo(ctx, s) {
  const hold = s.hold;
  const vis = Math.min(hold.vis, 1);
  const cx = hold.cx, cy = hold.cy;
  const haloR = CONFIG.charge.haloRadiusMin +
    (CONFIG.charge.haloRadiusMax - CONFIG.charge.haloRadiusMin) * vis;
  const pulse = 0.5 + 0.5 * Math.sin(s.time * 3.2);
  const baseA = CONFIG.charge.haloAlphaMin +
    (CONFIG.charge.haloAlphaMax - CONFIG.charge.haloAlphaMin) * vis;
  const a = baseA * (0.72 + 0.28 * pulse);

  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, haloR);
  g.addColorStop(0, 'rgba(255,185,90,' + a + ')');
  g.addColorStop(0.4, 'rgba(255,120,40,' + (a * 0.45) + ')');
  g.addColorStop(1, 'rgba(255,60,20,0)');
  ctx.globalAlpha = 1;
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, haloR, 0, TAU);
  ctx.fill();
}

function drawWarmCore(ctx, s) {
  const hold = s.hold;
  const vis = Math.min(hold.vis, 1.15);
  const v1 = Math.min(vis, 1);
  const cx = hold.cx, cy = hold.cy;
  const coreR = CONFIG.charge.coreRadiusMax -
    (CONFIG.charge.coreRadiusMax - CONFIG.charge.coreRadiusMin) * v1;

  // 颜色：橙 → 亮金 → 炽白
  let r, g, b;
  if (v1 < 0.5) {
    const k1 = v1 / 0.5;
    r = 255;
    g = 138 + (210 - 138) * k1;
    b = 30 + (74 - 30) * k1;
  } else {
    const k2 = (v1 - 0.5) / 0.5;
    r = 255;
    g = 210 + (255 - 210) * k2;
    b = 74 + (255 - 74) * k2;
  }

  // 锯齿状核心（逐帧随机顶点偏移）
  const segs = 22;
  const jagAmp = 0.08 + 0.22 * v1;
  ctx.beginPath();
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * TAU;
    const jag = 1 + (Math.random() - 0.5) * jagAmp * 2;
    const rr = coreR * jag;
    const px = cx + Math.cos(a) * rr;
    const py = cy + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
  ctx.fill();

  // 内层炽白
  ctx.globalAlpha = 0.55 + 0.45 * v1;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx, cy, coreR * 0.55, 0, TAU);
  ctx.fill();

  // 蓄满时的高频白闪（原型用 performance.now() 作为时间基准，这里保持一致）
  if (hold.vis >= 0.99) {
    const fl = 0.5 + 0.5 * Math.sin(performance.now() * 0.05);
    ctx.globalAlpha = 0.45 * fl;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(cx, cy, coreR * 1.7, 0, TAU);
    ctx.fill();
  }
}

function drawCoolRings(ctx, s) {
  const hold = s.hold;
  const vis = Math.min(hold.vis, 1);
  const cx = hold.cx, cy = hold.cy;
  const ringCount = 1 + Math.floor(vis * 2.99);
  const baseR = 30 + 100 * vis;
  const isFull = hold.vis >= 0.99;

  getColor(1, 0.22 + 0.55 * vis, s.colOut);
  let r = s.colOut[0], g = s.colOut[1], b = s.colOut[2];
  if (isFull) { r = 255; g = 255; b = 255; }

  const colStr = 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
  const segs = 40;
  const lineW = 1.4 + 1.6 * vis;
  const arcStep = TAU / segs;

  for (let ri = 0; ri < ringCount; ri++) {
    const radius = baseR * (1 - ri * 0.28);
    const angle = hold.ringAngle[ri];
    const ja = 1 + (Math.random() - 0.5) * 0.03 * vis;

    for (let si = 0; si < segs; si++) {
      const f0 = si / segs;
      const a0 = angle + f0 * TAU;
      const a1 = a0 + arcStep * 1.25;
      const al = Math.pow(1 - f0, 1.8) * (0.32 + 0.62 * vis);
      if (al < 0.02) continue;
      ctx.globalAlpha = al;
      ctx.strokeStyle = colStr;
      ctx.lineWidth = lineW;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * ja, a0, a1);
      ctx.stroke();
    }
  }

  // 中心微核
  ctx.globalAlpha = 0.5 + 0.4 * vis;
  ctx.fillStyle = 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
  ctx.beginPath();
  ctx.arc(cx, cy, 2 + 4 * vis, 0, TAU);
  ctx.fill();
}

// ==================== 左键爆发 ====================
function leftBurst(s, x, y, power) {
  const B = CONFIG.burst;
  const baseSpeed = B.baseSpeed + B.speedK * power;
  const N = Math.round(B.baseCount + B.countK * power);

  // 1. 牡丹型球形爆裂
  for (let i = 0; i < N; i++) {
    const a = Math.random() * TAU;
    const u = Math.sqrt(Math.random());
    const spd = baseSpeed * (0.25 + 0.75 * u);
    const sr = spd / baseSpeed;
    const bias = -0.15 + 0.35 * (1 - sr);
    const vx = Math.cos(a) * spd;
    const vy = Math.sin(a) * spd;
    const life = rand(0.5, 1.5);
    if (Math.random() < 0.62) {
      spawnSpark(s, x, y, vx, vy, life, rand(1.0, 2.8), 0, bias, 1, 1.6);
    } else {
      spawnStreak(s, x, y, vx, vy, rand(0.28, 0.75), rand(1.2, 3.0), 0, bias, 1, 1.4);
    }
  }

  // 2. 余烬火雨（低速、长寿命，形成下垂弧线）
  const emberN = Math.round(N * B.emberRatio);
  for (let e = 0; e < emberN; e++) {
    const ea = Math.random() * TAU;
    const espd = baseSpeed * rand(0.08, 0.28);
    spawnSpark(s, x, y, Math.cos(ea) * espd, Math.sin(ea) * espd,
      rand(1.1, 2.2), rand(0.9, 2.0), 0, 0.25, 1.2, 1.1);
  }

  // 3. 多层同心爆环（最白最亮）
  const ringCount = 2 + (power > 0.5 ? 1 : 0);
  for (let ri = 0; ri < ringCount; ri++) {
    const cnt = Math.round(26 + 34 * power);
    const rSpeed = baseSpeed * (1.0 - ri * 0.16);
    const r0 = 6 + ri * 8;
    for (let k = 0; k < cnt; k++) {
      const ra = (k / cnt) * TAU + rand(-0.03, 0.03);
      const rspd = rSpeed * rand(0.94, 1.06);
      spawnSpark(
        s,
        x + Math.cos(ra) * r0, y + Math.sin(ra) * r0,
        Math.cos(ra) * rspd, Math.sin(ra) * rspd,
        rand(0.8, 1.5), rand(1.2, 2.2),
        0, -0.5, 1, 1.0
      );
    }
  }

  // 4. 核心喷射（蓄力期间吸入的火星反向喷出）
  const n0 = Math.min(s.absorbed, 220);
  s.absorbed = 0;
  for (let c = 0; c < n0; c++) {
    const ca = Math.random() * TAU;
    const cspd = baseSpeed * rand(1.1, 1.6);
    spawnSpark(s, x, y, Math.cos(ca) * cspd, Math.sin(ca) * cspd,
      rand(0.4, 0.9), rand(1.0, 2.4), 0, -0.55, 1, 0.7);
  }

  // 5. 光核与纯白闪光
  spawnCore(s, x, y, 0.1, 26 + 30 * power, 0);
  spawnFlash(s, x, y, 0.12, 22 + 20 * power, 0);

  // 6. 复燃冲击波
  shockTrails(s, x, y, B.shockRadius + B.shockRadiusK * power,
    B.shockImpulse + B.shockImpulseK * power);
  shockTrailsStreaks(s, x, y);

  // 7. 余烟（1.2s 内持续生成）
  for (let i = 0; i < 12; i++) {
    after(s, i * 0.09, { kind: 'smoke', x: x, y: y, j: 60, pal: 0 });
  }
}

// ==================== 右键爆发（连环垂柳） ====================
function rightBurst(s, x, y, power) {
  const C = CONFIG.chain;
  const times = C.baseTimes + Math.round(C.timesK * power);
  const baseSpeed = 300 + 900 * power;

  // 光标最后移动方向（鼠标静止时取旋转切向）
  let dirX = s.rawVx, dirY = s.rawVy;
  const dl = Math.sqrt(dirX * dirX + dirY * dirY);
  if (dl < 40) {
    const ra = s.hold.ringAngle[0];
    dirX = -Math.sin(ra);
    dirY = Math.cos(ra);
  } else {
    dirX /= dl; dirY /= dl;
  }

  // 连环多段爆
  for (let k = 0; k < times; k++) {
    const scale = Math.pow(C.decay, k);
    const bx = x + rand(-C.spread, C.spread);
    const by = y + rand(-C.spread, C.spread);
    const spd = baseSpeed * scale;
    after(s, k * C.interval, { kind: 'willow', x: bx, y: by, spd: spd, k: k });
  }

  // 定向风感：拖尾粒子沿光标最后移动方向被吹走
  after(s, 0.02, { kind: 'blow', x: x, y: y, strength: 260 + 420 * power, dx: dirX, dy: dirY });

  // 余烟（青紫色调）
  for (let i = 0; i < 10; i++) {
    after(s, i * 0.1, { kind: 'smoke', x: x, y: y, j: 80, pal: 1 });
  }
}

function willowBurst(s, x, y, baseSpeed, k) {
  const C = CONFIG.chain;
  const upDeg = rand(C.upAngleMin, C.upAngleMax);
  const upBias = upDeg * Math.PI / 180;
  const N = Math.round(70 + Math.random() * 90);
  const colorT = (k % 4) / 4;
  const biasBase = colorT * 0.45 - 0.08;

  // 垂柳型火星（上扬 + 强重力 + 高火花条比例）
  for (let i = 0; i < N; i++) {
    const a = Math.random() * TAU - upBias;
    const spd = baseSpeed * (0.3 + 0.7 * Math.sqrt(Math.random()));
    const vx = Math.cos(a) * spd;
    const vy = Math.sin(a) * spd;
    const life = rand(0.8, 2.0);
    const bias = biasBase + rand(-0.05, 0.05);
    if (Math.random() < 0.45) {
      spawnSpark(s, x, y, vx, vy, life, rand(1.0, 2.5), 1, bias, CONFIG.willowGravityMul, 1.4);
    } else {
      spawnStreak(s, x, y, vx, vy, rand(0.4, 1.0), rand(1.4, 3.4), 1, bias,
        CONFIG.willowGravityMul, 1.2);
    }
  }

  // 撕裂环：向外扩散的破碎弧段
  const arcs = 5 + Math.floor(Math.random() * 4);
  for (let si = 0; si < arcs; si++) {
    const a0 = (si / arcs) * TAU + Math.random() * 0.2;
    const span = (TAU / arcs) * rand(0.42, 0.68);
    const cnt = Math.round(10 + Math.random() * 12);
    for (let j = 0; j < cnt; j++) {
      const ang = a0 + (j / cnt) * span;
      const aspd = baseSpeed * rand(0.85, 1.2);
      spawnSpark(s, x, y, Math.cos(ang) * aspd, Math.sin(ang) * aspd,
        rand(0.8, 1.7), rand(1.1, 2.1), 1, -0.3, CONFIG.willowGravityMul, 1.1);
    }
  }

  spawnCore(s, x, y, 0.1, 16, 1);
  spawnFlash(s, x, y, 0.1, 16, 1);
}

function blowTrails(s, x, y, strength, dx, dy) {
  const R = 400;
  const r2 = R * R;
  const pool = s.pool;
  for (let i = 0; i < pool.length; i++) {
    const p = pool[i];
    if (!p.active || p.type > 1 || p.attract > 0) continue;
    const ddx = p.x - x, ddy = p.y - y;
    const d2 = ddx * ddx + ddy * ddy;
    if (d2 > r2) continue;
    const d = Math.sqrt(d2) || 1;
    const falloff = 1 - d / R;
    p.vx += dx * strength * falloff;
    p.vy += dy * strength * falloff;
    p.ignite = Math.max(p.ignite, 0.55);
  }
}

// ==================== 物理更新 ====================
function updatePhysics(s, dt) {
  const pool = s.pool;
  const freeStack = s.freeStack;
  const hold = s.hold;

  for (let i = 0; i < pool.length; i++) {
    const p = pool[i];
    if (!p.active) continue;

    p.px = p.x;
    p.py = p.y;

    // 向心引力（蓄力吸附 / 拖尾引力扭曲）
    if (p.attract > 0) {
      if (!hold.active) {
        p.attract = 0;
      } else {
        p.gx = hold.cx;
        p.gy = hold.cy;
        const adx = p.gx - p.x;
        const ady = p.gy - p.y;
        const ad2 = adx * adx + ady * ady;
        const ad = Math.sqrt(ad2) || 1;
        p.vx += (adx / ad) * p.attract * dt;
        p.vy += (ady / ad) * p.attract * dt;
        if (ad2 < 120) {
          // 被核心吸收（原型此处 continue，跳过帧末的回收判定，
          // 该粒子会保持 active 且 life = 0 直到蓄力结束；行为原样保留）
          p.life = 0;
          if (s.absorbed < 400) s.absorbed++;
          continue;
        }
      }
    }

    // 蓄力期间拖尾被核心强行拉扯
    if (hold.active && hold.btn === 0 && p.attract === 0 && (p.type === 0 || p.type === 1)) {
      const cdx = hold.cx - p.x;
      const cdy = hold.cy - p.y;
      const cd2 = cdx * cdx + cdy * cdy;
      if (cd2 < 40000) {
        const cd = Math.sqrt(cd2) || 1;
        const pull = 620 * (1 - cd / 200) * hold.vis;
        p.vx += (cdx / cd) * pull * dt;
        p.vy += (cdy / cd) * pull * dt;
      }
    }

    // 重力
    if (p.type !== 2 && p.type !== 3 && p.type !== 4) {
      p.vy += CONFIG.gravity * p.gravMul * dt;
    }

    // 阻力
    if (p.dragK > 0) {
      const damp = Math.exp(-p.dragK * dt);
      p.vx *= damp;
      p.vy *= damp;
    }

    p.x += p.vx * dt;
    p.y += p.vy * dt;

    // 烟团特有：扩散 + 上升
    if (p.type === 2) {
      p.size += p.expand * dt;
      p.y -= p.rise * dt;
    }

    p.life -= dt;

    // 二次点燃衰减（0.25s 内回落）
    if (p.ignite > 0) {
      p.ignite -= dt / 0.25;
      if (p.ignite < 0) p.ignite = 0;
    }

    if (p.life <= 0) {
      p.active = false;
      freeStack.push(i);
    }
  }
}

// ==================== 粒子绘制 ====================
function drawParticle(ctx, s, p) {
  let lr = p.life / p.maxLife;
  if (lr < 0) lr = 0;

  let r, g, b;

  if (p.fixedCol) {
    r = p.col[0]; g = p.col[1]; b = p.col[2];
  } else {
    let t = 1 - lr + p.colorBias;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    getColor(p.pal, t, s.colOut);
    r = s.colOut[0]; g = s.colOut[1]; b = s.colOut[2];
  }

  let alpha = lr;
  let size = p.baseSize;

  // 二次点燃：亮度提升至炽白、颜色切换为高亮金红、尺寸放大 1.4 倍
  if (p.ignite > 0) {
    const ig = p.ignite;
    r = r + (255 - r) * ig * 0.92;
    g = g + (225 - g) * ig * 0.85;
    b = b + (140 - b) * ig * 0.55;
    alpha = alpha + (1 - alpha) * ig * 0.9;
    size = size * (1 + 0.4 * ig);
  }

  if (alpha <= 0.005) return;
  if (alpha > 1) alpha = 1;

  const ri = r | 0, gi = g | 0, bi = b | 0;
  let colStr;

  switch (p.type) {
    case 0: { // 火星
      // 高频闪烁
      const fl = 0.75 + Math.random() * 0.5;
      let a1 = alpha * fl;
      if (a1 > 1) a1 = 1;
      colStr = 'rgb(' + ri + ',' + gi + ',' + bi + ')';

      // 短拖影（上一帧位置连线，1~3px）
      const dxm = p.x - p.px, dym = p.y - p.py;
      if (dxm * dxm + dym * dym > 1.2) {
        ctx.globalAlpha = a1 * 0.45;
        ctx.strokeStyle = colStr;
        ctx.lineWidth = size * 0.85;
        ctx.beginPath();
        ctx.moveTo(p.px, p.py);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
      }

      // 外圈辉光
      ctx.globalAlpha = a1 * 0.5;
      ctx.fillStyle = colStr;
      ctx.beginPath();
      ctx.arc(p.x, p.y, size * 1.8, 0, TAU);
      ctx.fill();

      // 炽白内核
      ctx.globalAlpha = a1;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, size * 0.72, 0, TAU);
      ctx.fill();
      break;
    }

    case 1: { // 火花条
      colStr = 'rgb(' + ri + ',' + gi + ',' + bi + ')';
      const dxs = p.x - p.px, dys = p.y - p.py;
      const len = Math.sqrt(dxs * dxs + dys * dys);
      ctx.lineWidth = size;
      ctx.lineCap = 'round';

      if (len > 8) {
        // 头部亮、尾部透明
        const grd = ctx.createLinearGradient(p.px, p.py, p.x, p.y);
        grd.addColorStop(0, 'rgba(' + ri + ',' + gi + ',' + bi + ',0)');
        grd.addColorStop(0.55, 'rgba(' + ri + ',' + gi + ',' + bi + ',' + (alpha * 0.35) + ')');
        grd.addColorStop(1, 'rgba(' + ri + ',' + gi + ',' + bi + ',' + alpha + ')');
        ctx.globalAlpha = 1;
        ctx.strokeStyle = grd;
      } else {
        ctx.globalAlpha = alpha * 0.8;
        ctx.strokeStyle = colStr;
      }
      ctx.beginPath();
      ctx.moveTo(p.px, p.py);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();

      // 头部亮点
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, size * 0.55, 0, TAU);
      ctx.fill();
      break;
    }

    case 2: { // 烟团
      const sa = CONFIG.smoke.alphaMax * lr;
      if (sa <= 0.002) return;
      const gs = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size);
      gs.addColorStop(0, 'rgba(' + ri + ',' + gi + ',' + bi + ',' + sa + ')');
      gs.addColorStop(0.55, 'rgba(' + ri + ',' + gi + ',' + bi + ',' + (sa * 0.45) + ')');
      gs.addColorStop(1, 'rgba(' + ri + ',' + gi + ',' + bi + ',0)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = gs;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, TAU);
      ctx.fill();
      break;
    }

    case 3: { // 闪点（四芒星）
      const fa = Math.sqrt(lr);
      const lenF = p.size * (0.45 + 0.55 * lr);
      ctx.globalAlpha = fa;
      ctx.strokeStyle = p.pal === 1 ? 'rgb(180,250,255)' : 'rgb(255,242,205)';
      ctx.lineWidth = Math.max(0.8, p.size * 0.16);
      ctx.beginPath();
      ctx.moveTo(p.x - lenF, p.y);
      ctx.lineTo(p.x + lenF, p.y);
      ctx.moveTo(p.x, p.y - lenF);
      ctx.lineTo(p.x, p.y + lenF);
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.8, p.size * 0.2 * lr), 0, TAU);
      ctx.fill();
      break;
    }

    case 4: { // 光核（实心，快速收缩）
      const kk = lr;
      const rr = p.size * kk + 1.5;
      const ka = Math.pow(kk, 0.6);
      let gr;
      if (p.pal === 1) {
        gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rr);
        gr.addColorStop(0, 'rgba(255,255,255,' + ka + ')');
        gr.addColorStop(0.35, 'rgba(170,250,255,' + (ka * 0.6) + ')');
        gr.addColorStop(1, 'rgba(80,180,255,0)');
      } else {
        gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rr);
        gr.addColorStop(0, 'rgba(255,255,255,' + ka + ')');
        gr.addColorStop(0.35, 'rgba(255,220,140,' + (ka * 0.65) + ')');
        gr.addColorStop(1, 'rgba(255,120,30,0)');
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = gr;
      ctx.beginPath();
      ctx.arc(p.x, p.y, rr, 0, TAU);
      ctx.fill();
      break;
    }
  }
}

export class CursorFirework extends CursorEffectElement {
  /**
   * 滚轮动效：烟花式火星四射，初速大、散得开、快速熄灭。
   */
  wheelTheme() {
    return {
      style: 'spray',
      color:  [255, 176, 102],
      color2: [255, 240, 180],
      sizeMin: 1.4, sizeMax: 4,
      lifeMin: 0.3, lifeMax: 0.75,
      upSpeed: 460,
      downSpeed: 380,
      spread: 260,           // 放射状
      gravity: 300,
      drag: 1.1,
      turbulence: 22,
      jitter: 8
    };
  }

  /** 主题光标：暖橙描边 + 火星装饰 */
  cursorTheme() {
    return {
      edge: '#ffb066',
      fill: 'rgba(38, 20, 6, .88)',
      glow: '#ff8a3d',
      deco: { color: [255, 176, 102], style: 'spark', rate: 17, speedGain: 0.28 }
    };
  }

  // 原型用的是 mousemove / mousedown / mouseup（不是 pointer 事件族），
  // 不声明这一行，基类会去监听 pointermove，动效将完全收不到鼠标输入。
  inputFamily = 'mouse';

  // ==== 初始化 ====
  // 只建池与状态，不注册任何监听（监听、DPR 缩放、rAF 全归基类）
  setup({ ctx, width, height, input }) {
    // 与原型一致：初始光标位置取视口中心（原型第 1304-1307 行）。
    // 基类的 input 从 (0, 0) 起算，若不在这里对齐，首帧位移会按「从左上角跳过来」计算。
    input.x = input.lx = width * 0.5;
    input.y = input.ly = height * 0.5;

    // 粒子池：预分配 CONFIG.maxParticles 个，freeStack 记录空闲槽下标
    // （原型的初始化顺序是倒序入栈，故首个被分配的槽位是 0）
    const pool = new Array(CONFIG.maxParticles);
    for (let i = 0; i < CONFIG.maxParticles; i++) pool[i] = makeParticle();
    const freeStack = [];
    for (let j = CONFIG.maxParticles - 1; j >= 0; j--) freeStack.push(j);

    return {
      // 本实例的画布上下文（已按 DPR 缩放过，统一使用 CSS 像素坐标）
      ctx,

      // 画布尺寸（CSS 像素），由基类 onResize 同步
      W: width,
      H: height,

      input,

      // 粒子池与空闲栈
      pool,
      freeStack,

      // 原型口径的鼠标速度：原始逐帧位移 / dt，未平滑、无钳制、无上限。
      // 基类的 input.vx / vy 是平滑值（且带 >300px 归零、6000 封顶），
      // 与原型 mouse.vx / mouse.vy 语义不同，故另存一份。
      rawVx: 0,
      rawVy: 0,

      // 帧级锚点（原型 mouse.px / mouse.py）：上一帧结束时的光标位置。
      // 初值与原型一致取视口中心，每帧更新末尾推进（见 update）。
      anchorX: width * 0.5,
      anchorY: height * 0.5,

      // 光标在窗口外的标记，对应原型的 mouse.inside === false：
      // 初值 true（原型第 288 行 inside 即为 false），失焦与移出窗口时置位。
      // outX / outY 记录置位那一刻的位置，用于识别「回来后的第一次移动」。
      outside: true,
      outX: width * 0.5,
      outY: height * 0.5,

      // 按住 / 蓄力状态（原型 hold）
      hold: {
        active: false,
        btn: -1,
        t: 0,
        power: 0,
        vis: 0,
        cx: 0, cy: 0,
        ringAngle: [0, 0, 0]
      },

      // 生成累积器（原型同名模块级变量）
      trailSparkAcc: 0,
      trailStreakAcc: 0,
      intakeAcc: 0,
      ventAcc: 0,
      boilAcc: 0,
      starAcc: 0,
      coolAcc: 0,
      absorbed: 0,

      // 延迟任务队列（原型 timers）
      timers: [],

      // 颜色取样暂存（原型模块级 _colOut）
      colOut: [0, 0, 0],

      // 时间累计（原型 time，供蓄力光晕脉动）
      time: 0
    };
  }

  // ==== 输入（按键）====
  // 鼠标位移与原始速度由基类与 emitTrail 处理，这里只处理左右键交互
  onPointerDown(e) {
    const s = this.state;
    if (!s) return;

    if (e.button !== 0 && e.button !== 2) return;
    const hold = s.hold;
    if (hold.active) return;
    hold.active = true;
    hold.btn = e.button;
    hold.t = 0;
    hold.power = 0;
    hold.vis = 0;
    hold.cx = e.clientX;
    hold.cy = e.clientY;
    hold.ringAngle[0] = 0;
    hold.ringAngle[1] = 0;
    hold.ringAngle[2] = 0;

    // 原型在 mousedown 里把鼠标坐标连同锚点一起对齐到事件位置（第 366-369 行）
    s.input.x = e.clientX;
    s.input.y = e.clientY;
    s.anchorX = e.clientX;
    s.anchorY = e.clientY;

    resetChargeAcc(s);
  }

  onPointerUp(e) {
    const s = this.state;
    if (!s) return;

    const hold = s.hold;
    if (!hold.active || e.button !== hold.btn) return;

    const t = hold.t;
    const x = hold.cx, y = hold.cy;
    const btn = hold.btn;

    if (t < CONFIG.charge.minTime) {
      // 蓄力不足 → 普通单击
      if (btn === 0) clickBurst(s, x, y);
      else rightClickBurst(s, x, y);
    } else {
      const p = Math.pow(clamp(t / CONFIG.charge.fullTime, 0, 1), CONFIG.charge.powerExp);
      if (btn === 0) leftBurst(s, x, y, p);
      else rightBurst(s, x, y, p);
    }

    hold.active = false;
    hold.btn = -1;
    resetChargeAcc(s);
  }

  // 失焦时按键状态已丢失：原型 window blur 里同时把 inside 置 false 并取消蓄力
  onBlur() {
    const s = this.state;
    if (!s) return;
    s.input.inside = false;
    s.outside = true;
    s.outX = s.input.x;
    s.outY = s.input.y;
    cancelHold(s);
  }

  // 光标移出窗口：原型 document mouseout（relatedTarget 为空）的行为，
  // inside 已由基类置为 false，这里做同样的收尾
  onPointerLeave() {
    const s = this.state;
    if (!s) return;
    s.outside = true;
    s.outX = s.input.x;
    s.outY = s.input.y;
    cancelHold(s);
  }

  // ==== 尺寸 ====
  // 只同步动效自己的 W / H，画布尺寸与 DPR 由基类维护
  onResize(width, height) {
    const s = this.state;
    if (!s) return;
    s.W = width;
    s.H = height;
  }

  // ==== 更新 ====
  update(dt, s) {
    if (!s) return;

    // 原型的帧内钳制（第 1266-1267 行）：上限 0.05s 由基类保证，
    // 下限 0.0005s 在这里补齐，保证拖尾速度口径一致。
    if (dt < 0.0005) dt = 0.0005;

    s.time += dt;

    // 鼠标速度与拖尾（原型 emitTrail），随后第 1273 行把帧级锚点推进到当前位置
    emitTrail(s, dt);
    s.anchorX = s.input.x;
    s.anchorY = s.input.y;

    // 蓄力更新
    const hold = s.hold;
    if (hold.active) {
      hold.t += dt;
      const cn = clamp(hold.t / CONFIG.charge.fullTime, 0, 1);
      hold.power = Math.pow(cn, CONFIG.charge.powerExp);
      const over = Math.min(Math.max(hold.t - CONFIG.charge.fullTime, 0) * 0.02, 0.08);
      hold.vis = hold.power + over;

      // 微震
      let jAmp = Math.max(0, hold.vis - CONFIG.charge.jitterStart) /
        (1 - CONFIG.charge.jitterStart) * CONFIG.charge.jitterMax;
      if (jAmp < 0) jAmp = 0;
      const M = s.input;
      hold.cx = M.x + (Math.random() - 0.5) * jAmp * 2;
      hold.cy = M.y + (Math.random() - 0.5) * jAmp * 2;

      if (hold.btn === 0) updateWarmCharge(s, dt);
      else updateCoolCharge(s, dt);
    }

    updateTimers(s, dt);
    updatePhysics(s, dt);
  }

  // ==== 渲染 ====
  render(s) {
    if (!s) return;
    const ctx = s.ctx;

    // 清屏：原型本身就是透明画布（render 里只有 clearRect，暗底来自页面 body），
    // 因此没有需要删除的整屏铺底；缓冲尺寸与 DPR 缩放由基类维护。
    ctx.clearRect(0, 0, s.W, s.H);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const hold = s.hold;

    // 蓄力底层光晕（左键）
    if (hold.active && hold.btn === 0) drawWarmHalo(ctx, s);

    // 粒子
    const pool = s.pool;
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i];
      if (p.active) drawParticle(ctx, s, p);
    }

    // 蓄力核心（左键）
    if (hold.active && hold.btn === 0) drawWarmCore(ctx, s);

    // 蓄力火线（右键）
    if (hold.active && hold.btn === 2) drawCoolRings(ctx, s);

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}

if (!customElements.get('cursor-firework')) {
  customElements.define('cursor-firework', CursorFirework);
}

export default CursorFirework;
