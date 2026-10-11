/**
 * cursor-bubble —— 鼠标光标气泡动效（左键吹大撑破 / 右键泡沫簇）。
 *
 * 由 html/气泡.html 原型移植：算法流程、数值、视觉表现与原文件一一对应。
 * 作为光标层组件，原型页面自身的行为已剔除：
 *   - 原型 render() 本身就是 clearRect 起手、画布全程透明，没有任何整屏铺底，移植后照旧；
 *   - 不拦截 contextmenu，宿主页面的右键菜单不受影响；
 *   - 画布创建、DPR 适配、尺寸同步、监听注册、rAF 循环、鼠标速度平滑
 *     以及「>300px 跳变归零 / 6000 封顶」全部由基类负责。
 *
 * 原型监听 mousemove / mousedown / mouseup，因此声明 inputFamily = 'mouse'。
 * 原型里的 var 全局（气泡池、特效池、融合网格、蓄力状态、余韵）全部改为 state 字段，
 * 多实例互不干扰。
 */

import { CursorEffectElement } from '../core/base.js';
import { TAU, rand } from '../core/utils.js';

/* ============================================================
 * 顶部 CONFIG —— 所有可调参数集中于此（中文注释）
 * ============================================================ */
const CONFIG = {
  // ---- 池 / 性能 ----
  MAX_BUBBLES: 1800,          // 气泡对象池上限
  MAX_FX: 400,                // 特效对象池上限（环 / 星闪 / 膜片 / 水花）
  GRID_CELL: 52,              // 融合检测空间网格边长

  // ---- 半径弹簧（形变） ----
  SPRING_K: 150,              // 弹簧刚度
  SPRING_D: 14,               // 弹簧阻尼（欠阻尼 → 生成时过冲）
  R_FUSE_MAX: 60,             // 超过该半径不再主动融合，只被动吸收

  // ---- 运动 ----
  BUOY_MIN: 42,               // 基础浮力加速度下限 px/s²
  BUOY_MAX: 100,              // 基础浮力加速度上限 px/s²
  BUOY_R_GAIN: 0.016,         // 半径对浮力的增益（越大浮力越强）
  DRAG_Y: 0.85,               // 垂直阻尼（几乎无阻力）
  DRAG_DRIFT: 1.5,            // 水平漂移速度衰减
  WOBBLE_MIN: 2.0,            // 水平摆动频率下限 rad/s
  WOBBLE_MAX: 5.0,            // 水平摆动频率上限 rad/s

  // ---- 外观 ----
  MEMB_W_MIN: 0.9,            // 膜描边最细
  MEMB_W_MAX: 4.5,            // 膜描边最粗
  INNER_A_MIN: 0.02,          // 内部最低透明度
  INNER_A_MAX: 0.10,          // 内部最高透明度
  HUE_SPREAD_MIN: 40,         // 圆周色相扫描最小角度
  HUE_SPREAD_MAX: 90,         // 圆周色相扫描最大角度
  GLOW: 0.30,                 // 外辉光强度
  HI_MAIN: 0.82,              // 主高光亮度
  HI_SUB: 0.42,               // 副高光亮度

  // ---- 拖尾 ----
  TRAIL_RATE: 0.055,          // 生成速率（个 / 像素位移）
  TRAIL_R_MIN: 3,             // 拖尾气泡最小半径
  TRAIL_R_MAX: 9,             // 拖尾气泡最大半径
  IDLE_RATE: 0.35,            // 静止时每秒生成概率（极低）

  // ---- 融合 ----
  FUSE_RATIO: 0.85,           // 距离阈值 = (r1 + r2) * ratio
  FUSE_CD: 0.15,              // 融合冷却（秒）
  FUSE_CHAIN_T: 0.3,          // 爆发后连锁放宽持续时间
  FUSE_CHAIN_K: 1.5,          // 连锁放宽倍数

  // ---- 通用 ----
  FLASH_DECAY: 3.2,           // 亮度提升回落速度

  // ---- 蓄力 ----
  CHARGE_MAX: 2.5,            // 蓄力满值（秒）
  CHARGE_CLICK: 0.12,         // 左键低于该时长视为普通单击
  CHARGE_CLICK_R: 0.15,       // 右键低于该时长视为普通点击

  // ---- 左键主泡 ----
  MAIN_R0: 12,                // 主泡起始半径
  MAIN_R1: 90,                // 主泡蓄满半径
  MAIN_POW: 0.65,             // 半径增长曲线指数（前快后慢）
  SATELLITE_RATE: 15,         // 每秒生成卫星泡数量
  MAIN_SHAKE: 3,              // 蓄满时光标最大抖动 px

  // ---- 右键泡沫簇 ----
  CLUSTER_HUE_MIN: 160,       // 冷色相下限
  CLUSTER_HUE_MAX: 280,       // 冷色相上限
  CLUSTER_SIZE0: 25,          // 泡沫簇初始半径
  CLUSTER_SIZE1: 80           // 泡沫簇蓄满半径
};

/* ============================================================
 * 工具函数
 * ============================================================ */
// TAU / rand 直接取自 core/utils.js（与原型第 18 / 114 行逐字一致）。
// 原型第 115 行的 clamp 全文件从未被调用，属于未使用的辅助函数，故不再引入。

/* ============================================================
 * 粒子池 —— 气泡
 * ============================================================ */
function createBubbleObj() {
  return {
    alive: false, id: 0,
    x: 0, y: 0, vx: 0, vy: 0, driftVx: 0,
    r: 0, rTarget: 0, vr: 0,
    hue: 0, huePhase: 0, hueSpread: 60, hueSpeed: 1, membLit: 0,
    thick: 1, membW: 2, innerA: 0.05,
    wobPhase: 0, wobFreq: 3, wobAmp: 12,
    life: 0, maxLife: 10,
    buoy: 60,
    flash: 0, fuseCD: 0, ripples: 0,
    kind: 0,            // 0 普通 / 1 拖尾 / 2 主泡 / 3 泡沫簇成员
    homing: null, cluster: null,
    orbR: 0, orbA: 0, orbW: 0,
    stretch: 0, surf: 0, pulse: 1,
    overExpand: false, overTimer: 0
  };
}

function resetBubble(p) {
  p.x = p.y = p.vx = p.vy = p.driftVx = 0;
  p.r = 0; p.rTarget = 1; p.vr = 0;
  p.hue = 0; p.huePhase = 0; p.hueSpread = 60; p.hueSpeed = 1; p.membLit = 0;
  p.thick = 1; p.membW = 2; p.innerA = 0.05;
  p.wobPhase = Math.random() * TAU; p.wobFreq = 3; p.wobAmp = 12;
  p.life = 0; p.maxLife = 10;
  p.buoy = 60;
  p.flash = 0; p.fuseCD = 0; p.ripples = 0;
  p.kind = 0; p.homing = null; p.cluster = null;
  p.orbR = 0; p.orbA = 0; p.orbW = 0;
  p.stretch = 0; p.surf = 0; p.pulse = 1;
  p.overExpand = false; p.overTimer = 0;
}

function allocBubble(s) {
  let p;
  if (s.freeBubbles.length > 0) {
    p = s.freeBubbles.pop();
  } else {
    if (s.bubbles.length === 0) return null;
    p = s.bubbles.shift();          // 池满：回收最老
    if (p.cluster && p.cluster.members) {
      const mi = p.cluster.members.indexOf(p);
      if (mi >= 0) p.cluster.members.splice(mi, 1);
    }
  }
  resetBubble(p);
  p.alive = true;
  p.id = ++s.idCounter;
  s.bubbles.push(p);
  return p;
}

function killBubble(p) {
  if (!p.alive) return;
  p.alive = false;
  if (p.cluster && p.cluster.members) {
    const i = p.cluster.members.indexOf(p);
    if (i >= 0) p.cluster.members.splice(i, 1);
  }
  p.cluster = null;
  p.homing = null;
}

/* ---- 生成一个气泡 ---- */
function spawnBubble(s, x, y, r, opt) {
  opt = opt || {};
  const p = allocBubble(s);
  if (!p) return null;
  p.x = x; p.y = y;
  p.rTarget = r;
  p.r = opt.startR !== undefined ? opt.startR : r * 0.08;
  p.vr = 0;

  p.hue = opt.hue !== undefined ? ((opt.hue % 360) + 360) % 360 : Math.random() * 360;
  p.hueSpread = opt.spread !== undefined ? opt.spread : rand(CONFIG.HUE_SPREAD_MIN, CONFIG.HUE_SPREAD_MAX);
  p.huePhase = Math.random() * 360;
  p.hueSpeed = opt.hueSpeed !== undefined ? opt.hueSpeed : rand(0.4, 1.6);

  p.thick = opt.thick !== undefined ? opt.thick : Math.random();
  p.membW = CONFIG.MEMB_W_MIN + (CONFIG.MEMB_W_MAX - CONFIG.MEMB_W_MIN) * p.thick;
  p.innerA = rand(CONFIG.INNER_A_MIN, CONFIG.INNER_A_MAX);

  p.wobFreq = opt.wobFreq !== undefined ? opt.wobFreq : rand(CONFIG.WOBBLE_MIN, CONFIG.WOBBLE_MAX);
  p.wobAmp = opt.wobAmp !== undefined ? opt.wobAmp : rand(8, 26);
  p.buoy = opt.buoy !== undefined ? opt.buoy : rand(CONFIG.BUOY_MIN, CONFIG.BUOY_MAX);
  p.maxLife = opt.life !== undefined ? opt.life : rand(8, 18);

  p.kind = opt.kind || 0;
  p.vx = opt.vx || 0;
  p.vy = opt.vy || 0;
  p.driftVx = opt.vx || 0;
  p.homing = opt.homing || null;
  p.flash = opt.flash || 0;
  return p;
}

/* ============================================================
 * 粒子池 —— 特效（环 / 星闪 / 膜片 / 水花）
 * ============================================================ */
function createFxObj() {
  return {
    alive: false, type: 0,
    x: 0, y: 0, vx: 0, vy: 0,
    r: 0, r0: 0, r1: 0,
    life: 0, maxLife: 1,
    hue: 0, alpha: 1, w: 1,
    rot: 0, rotV: 0, len: 1.5,
    gravity: 0
  };
}

function allocFx(s) {
  let f;
  if (s.freeFx.length > 0) f = s.freeFx.pop();
  else if (s.fxList.length > 0) f = s.fxList.shift();
  else return null;
  f.alive = true;
  f.vx = 0; f.vy = 0; f.gravity = 0;
  f.rot = 0; f.rotV = 0; f.len = 1.5;
  f.alpha = 1; f.w = 1;
  f.life = 0; f.maxLife = 1;
  s.fxList.push(f);
  return f;
}

function spawnRing(s, x, y, r0, r1, life, hue, w) {
  const f = allocFx(s);
  if (!f) return;
  f.type = 0;
  f.x = x; f.y = y;
  f.r0 = r0; f.r1 = r1; f.r = r0;
  f.life = 0; f.maxLife = life;
  f.hue = hue;
  f.w = w || 1.5;
  f.alpha = 0.75;
}

function spawnStar(s, x, y, size) {
  const f = allocFx(s);
  if (!f) return;
  f.type = 1;
  f.x = x; f.y = y;
  f.r = size;
  f.life = 0; f.maxLife = 0.12;
  f.alpha = 1;
  f.w = 1.6;
  f.rot = Math.random() * 0.6;
}

function spawnDroplets(s, x, y, n, hue, speed, life) {
  for (let i = 0; i < n; i++) {
    const f = allocFx(s);
    if (!f) break;
    const a = Math.random() * TAU;
    const sp = speed * rand(0.35, 1.15);
    f.type = 3;
    f.x = x; f.y = y;
    f.vx = Math.cos(a) * sp;
    f.vy = Math.sin(a) * sp;
    f.life = 0;
    f.maxLife = life * rand(0.7, 1.35);
    f.alpha = 1;
    f.w = rand(1, 2.2);
    f.hue = hue + (Math.random() - 0.5) * 40;
    f.gravity = 400;
  }
}

function spawnShard(s, x, y, angle, speed, len, hue) {
  const f = allocFx(s);
  if (!f) return;
  f.type = 2;
  f.x = x; f.y = y;
  f.vx = Math.cos(angle) * speed;
  f.vy = Math.sin(angle) * speed - 50;
  f.r = rand(10, 20);
  f.len = len / f.r;
  f.life = 0;
  f.maxLife = rand(0.55, 1.1);
  f.alpha = 0.85;
  f.w = rand(1.2, 2.4);
  f.hue = hue;
  f.rot = angle;
  f.rotV = (Math.random() - 0.5) * 7;
  f.gravity = 0;
}

/* ============================================================
 * 气泡绘制（环形渐变 + 高光 + 薄膜干涉色）
 * ============================================================ */
function bubblePath(ctx, radius, surf, segs, t) {
  ctx.beginPath();
  if (surf > 0.002) {
    for (let i = 0; i <= segs; i++) {
      const a = (i / segs) * TAU;
      const n = Math.sin(a * 3 + t * 4) * 0.5 +
              Math.sin(a * 5 - t * 6.5) * 0.35 +
              Math.sin(a * 7 + t * 9.3) * 0.2;
      const rr = radius * (1 + n * surf);
      const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();
  } else {
    ctx.arc(0, 0, radius, 0, TAU);
  }
}

function drawBubble(ctx, p) {
  const r = p.r;
  if (r < 0.45) return;

  const boost = 1 + p.flash * 1.2;

  ctx.save();
  ctx.translate(p.x, p.y);

  // ---- 沿运动方向拉长（squash / stretch）----
  if (p.stretch > 0.003) {
    const spd = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    if (spd > 4) {
      const ang = Math.atan2(p.vy, p.vx);
      ctx.rotate(ang);
      ctx.scale(1 + p.stretch, 1 - p.stretch * 0.72);
      ctx.rotate(-ang);
    }
  }

  const surf = p.surf;
  const segs = r > 20 ? 40 : (r > 8 ? 22 : 12);

  // ---- 1. 内部（近乎透明）+ 边缘环形渐变 ----
  const innerA = p.innerA * boost;
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
  g.addColorStop(0, 'hsla(' + p.hue + ',72%,74%,' + (innerA * 0.75).toFixed(4) + ')');
  g.addColorStop(0.62, 'hsla(' + p.hue + ',66%,66%,' + (innerA * 0.28).toFixed(4) + ')');
  g.addColorStop(0.90, 'hsla(' + p.hue + ',72%,72%,' + (innerA * 1.7).toFixed(4) + ')');
  g.addColorStop(1, 'hsla(' + p.hue + ',72%,72%,0)');
  ctx.fillStyle = g;
  bubblePath(ctx, r, surf, segs, p.life);
  ctx.fill();

  // ---- 2. 薄膜干涉环（沿圆周色相扫描）----
  const segCount = r > 22 ? 7 : (r > 9 ? 5 : 3);
  const lw = Math.max(0.7, p.membW * (0.55 + 0.45 * Math.min(1, r / 12)));
  ctx.lineWidth = lw;
  const sat = 52 + p.thick * 32;
  const lit = 56 + p.thick * 24 + p.membLit;
  const al = Math.min(1, (0.20 + p.thick * 0.48) * boost);
  for (let i = 0; i < segCount; i++) {
    const a0 = (i / segCount) * TAU;
    const a1 = ((i + 1) / segCount) * TAU + 0.07;
    let h = (p.hue + p.huePhase + (i / segCount) * p.hueSpread) % 360;
    if (h < 0) h += 360;
    ctx.strokeStyle = 'hsla(' + h.toFixed(1) + ',' + sat.toFixed(1) + '%,' + lit.toFixed(1) + '%,' + al.toFixed(3) + ')';
    ctx.beginPath();
    ctx.arc(0, 0, r, a0, a1);
    ctx.stroke();
  }

  // ---- 3. 柔和外辉光 ----
  if (r > 3) {
    const g2 = ctx.createRadialGradient(0, 0, r * 0.72, 0, 0, r * 1.45);
    const ga = CONFIG.GLOW * p.thick * boost;
    g2.addColorStop(0, 'hsla(' + p.hue + ',80%,72%,0)');
    g2.addColorStop(0.5, 'hsla(' + p.hue + ',82%,74%,' + (ga * 0.85).toFixed(4) + ')');
    g2.addColorStop(1, 'hsla(' + p.hue + ',82%,74%,0)');
    ctx.fillStyle = g2;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.45, 0, TAU);
    ctx.fill();
  }

  // ---- 4. 固定高光（左上约 35°）----
  const hx = -r * 0.36, hy = -r * 0.42;
  const hRad = r * 0.24 * p.pulse;
  if (hRad > 0.55) {
    const hg = ctx.createRadialGradient(hx, hy, 0, hx, hy, hRad);
    const ha = Math.min(0.92, CONFIG.HI_MAIN * (0.55 + p.thick * 0.5) * boost * p.pulse);
    hg.addColorStop(0, 'rgba(255,255,255,' + ha.toFixed(3) + ')');
    hg.addColorStop(0.45, 'rgba(255,255,255,' + (ha * 0.42).toFixed(3) + ')');
    hg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hg;
    ctx.beginPath();
    ctx.ellipse(hx, hy, hRad * 1.32, hRad * 0.86, -0.62, 0, TAU);
    ctx.fill();
  }

  // 右下小副高光
  const sRad = r * 0.11;
  if (sRad > 0.45) {
    ctx.beginPath();
    ctx.ellipse(r * 0.40, r * 0.46, sRad, sRad * 0.68, 0.7, 0, TAU);
    ctx.fillStyle = 'rgba(255,255,255,' + Math.min(0.6, CONFIG.HI_SUB * boost).toFixed(3) + ')';
    ctx.fill();
  }

  // ---- 5. 融合高亮膜波纹 ----
  if (p.ripples > 0) {
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.07, 0, TAU);
    ctx.strokeStyle = 'rgba(255,255,255,' + (p.ripples * 0.55).toFixed(3) + ')';
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  ctx.restore();
}

/* ============================================================
 * 特效绘制
 * ============================================================ */
function drawFx(ctx, f) {
  const prog = f.life / f.maxLife;
  const a = f.alpha * (1 - prog);
  if (a <= 0.012) return;

  if (f.type === 0) {            // 薄膜圆环
    ctx.beginPath();
    ctx.arc(f.x, f.y, f.r, 0, TAU);
    ctx.lineWidth = f.w * (1 - prog * 0.6);
    ctx.strokeStyle = 'hsla(' + f.hue.toFixed(0) + ',85%,' + (95 - prog * 38).toFixed(0) + '%,' + a.toFixed(3) + ')';
    ctx.stroke();
    // 内侧柔光
    ctx.beginPath();
    ctx.arc(f.x, f.y, f.r * 0.985, 0, TAU);
    ctx.lineWidth = f.w * 3.2;
    ctx.strokeStyle = 'hsla(' + f.hue.toFixed(0) + ',85%,72%,' + (a * 0.16).toFixed(3) + ')';
    ctx.stroke();
  } else if (f.type === 1) {     // 四芒星闪点
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.rotate(f.rot);
    ctx.strokeStyle = 'rgba(255,255,255,' + (a * 0.30).toFixed(3) + ')';
    ctx.lineWidth = f.w * 3.4;
    ctx.beginPath();
    ctx.moveTo(-f.r * 0.72, 0); ctx.lineTo(f.r * 0.72, 0);
    ctx.moveTo(0, -f.r * 0.72); ctx.lineTo(0, f.r * 0.72);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,' + a.toFixed(3) + ')';
    ctx.lineWidth = f.w;
    ctx.beginPath();
    ctx.moveTo(-f.r, 0); ctx.lineTo(f.r, 0);
    ctx.moveTo(0, -f.r); ctx.lineTo(0, f.r);
    ctx.stroke();
    ctx.restore();
  } else if (f.type === 2) {     // 膜残片（弧形描边）
    ctx.save();
    ctx.translate(f.x, f.y);
    ctx.rotate(f.rot);
    ctx.beginPath();
    ctx.arc(0, 0, f.r, -f.len * 0.5, f.len * 0.5);
    ctx.lineWidth = Math.max(0.4, f.w);
    ctx.strokeStyle = 'hsla(' + f.hue.toFixed(0) + ',78%,80%,' + a.toFixed(3) + ')';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, f.r, -f.len * 0.5, f.len * 0.5);
    ctx.lineWidth = Math.max(0.4, f.w) * 3;
    ctx.strokeStyle = 'hsla(' + f.hue.toFixed(0) + ',78%,72%,' + (a * 0.2).toFixed(3) + ')';
    ctx.stroke();
    ctx.restore();
  } else {                      // 水花 / 液滴（短火花条）
    const tl = 0.017;
    ctx.beginPath();
    ctx.moveTo(f.x, f.y);
    ctx.lineTo(f.x - f.vx * tl, f.y - f.vy * tl);
    ctx.lineWidth = f.w;
    ctx.strokeStyle = 'hsla(' + f.hue.toFixed(0) + ',88%,74%,' + a.toFixed(3) + ')';
    ctx.stroke();
  }
}

/* ============================================================
 * 融合
 * ============================================================ */
function doFuse(s, a, b, dx, dy) {
  const nr = Math.sqrt(a.r * a.r + b.r * b.r);   // 体积守恒
  a.rTarget = nr;
  a.vr += 34;
  a.flash = Math.max(a.flash, 0.5);
  a.fuseCD = CONFIG.FUSE_CD;
  a.ripples = 1;

  const denom = a.r + b.r + 0.0001;
  const cx = a.x + dx * (a.r / denom);
  const cy = a.y + dy * (a.r / denom);

  spawnStar(s, cx, cy, 6 + a.r * 0.22);
  if (b.r > 5) spawnDroplets(s, cx, cy, 3, b.hue, 90, 0.25);

  killBubble(b);
}

function fusePass(s) {
  if (s.bubbles.length < 2) return;
  const CELL = CONFIG.GRID_CELL;
  s.gridMap.clear();

  let i, j, p, cx, cy, key, arr;
  for (i = 0; i < s.bubbles.length; i++) {
    p = s.bubbles[i];
    if (!p.alive || p.kind === 2 || p.fuseCD > 0) continue;
    cx = Math.floor(p.x / CELL);
    cy = Math.floor(p.y / CELL);
    key = cx * 100003 + cy;
    arr = s.gridMap.get(key);
    if (!arr) { arr = []; s.gridMap.set(key, arr); }
    arr.push(p);
  }

  const ratio = CONFIG.FUSE_RATIO * (s.fuseChainTimer > 0 ? CONFIG.FUSE_CHAIN_K : 1);

  for (i = 0; i < s.bubbles.length; i++) {
    const a = s.bubbles[i];
    if (!a.alive || a.fuseCD > 0) continue;
    cx = Math.floor(a.x / CELL);
    cy = Math.floor(a.y / CELL);

    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        arr = s.gridMap.get((cx + ox) * 100003 + (cy + oy));
        if (!arr) continue;
        for (j = 0; j < arr.length; j++) {
          const b = arr[j];
          if (b === a || !b.alive || b.fuseCD > 0) continue;
          if (a.kind === 2 && b.kind === 2) continue;
          if (b.r > a.r) continue;                        // 只由较大方处理
          if (b.r === a.r && b.id > a.id) continue;
          if (a.r > CONFIG.R_FUSE_MAX && b.r > CONFIG.R_FUSE_MAX) continue;

          const dx = b.x - a.x, dy = b.y - a.y;
          const th = (a.r + b.r) * ratio;
          if (dx * dx + dy * dy < th * th) {
            doFuse(s, a, b, dx, dy);
          }
        }
      }
    }
  }
}

/* ============================================================
 * 鼠标输入 —— 位置 / 速度由基类维护（this.input）
 * ============================================================ */

/* ============================================================
 * 拖尾
 * ============================================================ */
function spawnTrailOne(s, charging, tiny) {
  const M = s.input;
  const r = tiny ? rand(1.5, 3.5) : rand(CONFIG.TRAIL_R_MIN, CONFIG.TRAIL_R_MAX);
  const a = Math.random() * TAU;
  const off = tiny ? 3 : r * 0.5;
  const x = M.x + Math.cos(a) * off + (Math.random() - 0.5) * 7;
  const y = M.y + Math.sin(a) * off + (Math.random() - 0.5) * 7;

  const p = spawnBubble(s, x, y, r, {
    hue: Math.random() * 360,
    vx: (Math.random() - 0.5) * 46,
    vy: (Math.random() - 0.5) * 24,
    life: rand(6, 16),
    kind: 1
  });
  if (!p) return;

  if (charging) {
    if (s.leftDown && s.mainBubble && s.mainBubble.alive) {
      p.homing = s.mainBubble;              // 被主泡吸附融合
    } else if (s.rightDown && s.cluster && s.cluster.active) {
      attachToCluster(s, p);                // 加入泡沫簇
    }
  }
}

function updateTrail(s, dt) {
  const charging = (s.leftDown && s.mainBubble && s.mainBubble.alive) ||
                   (s.rightDown && s.cluster && s.cluster.active);
  if (s.input.speed > 22) {
    s.trailAcc += s.input.speed * dt * CONFIG.TRAIL_RATE;
    if (s.trailAcc > 10) s.trailAcc = 10;
    let guard = 0;
    while (s.trailAcc >= 1 && guard++ < 12) {
      s.trailAcc -= 1;
      spawnTrailOne(s, charging, false);
    }
  } else {
    if (Math.random() < CONFIG.IDLE_RATE * dt) spawnTrailOne(s, charging, true);
  }
}

/* ============================================================
 * 左键吹大 → 撑破
 * ============================================================ */
function startLeft(s) {
  if (s.leftDown) return;
  s.leftDown = true;
  s.leftT = 0;
  s.satAcc = 0;

  const mx = s.input.x, my = s.input.y;

  // 主泡：从 0 overshoot 弹出
  s.mainBubble = spawnBubble(s, mx, my, CONFIG.MAIN_R0, {
    kind: 2,
    hue: Math.random() * 360,
    thick: 1,
    life: 9999,
    buoy: 0,
    startR: 0
  });
  if (s.mainBubble) {
    s.mainBubble.hueSpread = 72;
    s.mainBubble.surf = 0;
  }

  const mainHue = s.mainBubble ? s.mainBubble.hue : Math.random() * 360;

  // 向外散射小气泡
  const n = 10 + ((Math.random() * 9) | 0);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU;
    const sp = rand(60, 200);
    spawnBubble(s, mx, my, rand(2, 6), {
      hue: mainHue + (Math.random() - 0.5) * 70,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      life: rand(5, 11)
    });
  }

  // 短寿命膜环
  spawnRing(s, mx, my, 8, 60, 0.35, mainHue, 2);

  // 极小水花
  spawnDroplets(s, mx, my, 12, mainHue, 150, 0.3);

  // ---- 点击对拖尾的冲击：浮力脉冲 + 融合诱导 ----
  const R = 180;
  for (let k = 0; k < s.bubbles.length; k++) {
    const b = s.bubbles[k];
    if (b === s.mainBubble || b.kind === 2 || !b.alive) continue;
    const dx = b.x - mx, dy = b.y - my;
    const d2 = dx * dx + dy * dy;
    if (d2 > R * R) continue;
    const d = Math.sqrt(d2) || 0.001;
    const f = 1 - d / R;
    b.vy -= 280 * f;                                   // 机制 A：浮力脉冲
    b.driftVx += (mx - b.x) / d * 300 * f;             // 机制 B：融合诱导
    b.flash = Math.max(b.flash, 0.7 * f);
  }
}

function endLeft(s) {
  if (!s.leftDown) return;
  s.leftDown = false;
  const t = s.leftT;
  if (!s.mainBubble || !s.mainBubble.alive) { s.mainBubble = null; return; }

  if (t < CONFIG.CHARGE_CLICK) {
    // 普通单击：主泡脱离，成为普通上升气泡
    const p = s.mainBubble;
    p.kind = 0;
    p.surf = 0;
    p.homing = null;
    p.buoy = rand(CONFIG.BUOY_MIN, CONFIG.BUOY_MAX);
    p.rTarget = rand(15, 20);
    p.vx = (Math.random() - 0.5) * 90;
    p.driftVx = p.vx;
    p.maxLife = rand(8, 15);
    p.membLit = 0;
    p.pulse = 1;
  } else {
    const power = Math.pow(Math.min(t, CONFIG.CHARGE_MAX) / CONFIG.CHARGE_MAX, 1.6);
    explodeMain(s, power);
  }
  s.mainBubble = null;
}

function explodeMain(s, power) {
  const p = s.mainBubble;
  if (!p || !p.alive) return;
  const mx = p.x, my = p.y;
  const hue = p.hue;
  const R = p.r;

  // 1. 内爆：塌缩裂纹高光
  spawnRing(s, mx, my, R * 0.6, R * 0.62, 0.1, hue, 2.4);
  spawnStar(s, mx, my, R * 0.75);
  spawnDroplets(s, mx, my, 10, hue, 220, 0.16);

  // 2. 泡泡雨
  const count = Math.min(360, Math.floor(80 + 300 * power));
  for (let i = 0; i < count; i++) {
    const a = Math.random() * TAU;
    const sp = (180 + 700 * power) * rand(0.32, 1.0);
    const b = spawnBubble(s, mx, my, rand(3, 12), {
      hue: hue + (Math.random() - 0.5) * 150,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      life: rand(7, 15),
      spread: rand(60, 110)
    });
    if (b) b.flash = 0.65;
  }

  // 3. 水花外圈
  spawnDroplets(s, mx, my, Math.min(70, Math.floor(20 + 50 * power)), hue, 280 + 520 * power, 0.65);

  // 4. 膜残片
  const shards = Math.min(60, Math.floor(10 + 40 * power));
  for (let sh = 0; sh < shards; sh++) {
    const sa = Math.random() * TAU;
    spawnShard(s, mx, my, sa, 120 + 340 * power, rand(10, 30), hue + (Math.random() - 0.5) * 90);
  }

  // 5. 冲击波环
  const rings = 1 + (power > 0.5 ? 1 : 0);
  for (let ri = 0; ri < rings; ri++) {
    spawnRing(s, mx, my, R * 0.35, 80 + 380 * power, 0.5 + ri * 0.18, hue + ri * 30, 1.4);
  }

  // 6. 浮力风暴
  for (let k = 0; k < s.bubbles.length; k++) {
    const bb = s.bubbles[k];
    if (bb === p || bb.kind === 2 || !bb.alive) continue;
    const dx = bb.x - mx, dy = bb.y - my;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 320) {
      const f = 1 - d / 320;
      bb.vy -= (220 + 750 * power) * f;
      bb.flash = Math.max(bb.flash, 0.85 * f);
    }
  }

  // 7. 融合连锁
  s.fuseChainTimer = CONFIG.FUSE_CHAIN_T;

  // 8. 余韵
  s.afterglow = Math.max(s.afterglow, 1.0);
  s.afterglowRate = 26;

  killBubble(p);
}

/* ---- 蓄力更新（左键主泡） ---- */
function updateCharge(s, dt) {
  if (!s.leftDown || !s.mainBubble || !s.mainBubble.alive) return;

  const M = s.input;
  s.leftT += dt;
  const t = Math.min(s.leftT, CONFIG.CHARGE_MAX);
  const tn = t / CONFIG.CHARGE_MAX;
  const p = s.mainBubble;

  // 跟随光标（蓄力超过 55% 后微震）
  let tx = M.x, ty = M.y;
  if (tn > 0.55) {
    const amp = ((tn - 0.55) / 0.45) * CONFIG.MAIN_SHAKE;
    tx += (Math.random() - 0.5) * amp * 2;
    ty += (Math.random() - 0.5) * amp * 2;
  }
  const fk = Math.min(1, dt * 24);
  p.x += (tx - p.x) * fk;
  p.y += (ty - p.y) * fk;

  // 半径：前快后慢 + 弹性抖动
  const grow = Math.pow(tn, CONFIG.MAIN_POW);
  let rt = CONFIG.MAIN_R0 + (CONFIG.MAIN_R1 - CONFIG.MAIN_R0) * grow;
  rt *= 1 + Math.sin(s.leftT * 9.2) * 0.011 * (1 + tn * 2);
  p.rTarget = rt;

  // 膜变薄
  p.thick = Math.max(0.04, 1 - tn * 0.96);
  p.membW = CONFIG.MEMB_W_MIN + (CONFIG.MEMB_W_MAX - CONFIG.MEMB_W_MIN) * p.thick;

  // 虹彩加速
  p.hueSpeed = 2 + tn * 30;
  p.membLit = tn * 24;

  // 表面起伏
  p.surf = tn * 0.17;

  // 内压震荡
  p.pulse = 1 + Math.sin(s.leftT * (3 + tn * 14)) * (0.10 + tn * 0.30);
  p.innerA = 0.035 + tn * 0.05 + Math.sin(s.leftT * (3 + tn * 14)) * 0.018;

  // 卫星吸附
  s.satAcc += dt * (CONFIG.SATELLITE_RATE * (0.35 + tn * 1.6));
  let guard = 0;
  while (s.satAcc >= 1 && guard++ < 6) {
    s.satAcc -= 1;
    const a = Math.random() * TAU;
    const d = p.r * rand(1.5, 2.6) + 20;
    const sx = p.x + Math.cos(a) * d;
    const sy = p.y + Math.sin(a) * d;
    const sb = spawnBubble(s, sx, sy, rand(2.5, 7), {
      hue: p.hue + (Math.random() - 0.5) * 100,
      homing: p,
      life: 4,
      buoy: 6,
      vx: -Math.sin(a) * 110,
      vy: Math.cos(a) * 110
    });
    if (sb) sb.kind = 1;
  }
}

/* ============================================================
 * 右键泡沫簇
 * ============================================================ */
function attachToCluster(s, p) {
  const cluster = s.cluster;
  if (!cluster || !cluster.active) return;
  if (cluster.members.length >= 100) return;
  p.cluster = cluster;
  p.kind = 3;
  p.orbR = Math.sqrt((p.x - cluster.x) * (p.x - cluster.x) + (p.y - cluster.y) * (p.y - cluster.y));
  if (p.orbR < 4) p.orbR = rand(6, cluster.size);
  p.orbA = Math.atan2(p.y - cluster.y, p.x - cluster.x);
  p.orbW = rand(0.6, 2.2) * (Math.random() < 0.5 ? 1 : -1);
  p.maxLife = 9999;
  p.buoy = 0;
  p.hue = rand(CONFIG.CLUSTER_HUE_MIN, CONFIG.CLUSTER_HUE_MAX);
  p.thick = rand(0.5, 1);
  p.membW = CONFIG.MEMB_W_MIN + (CONFIG.MEMB_W_MAX - CONFIG.MEMB_W_MIN) * p.thick;
  cluster.members.push(p);
}

function addClusterMember(s) {
  const cluster = s.cluster;
  if (!cluster || !cluster.active) return;
  if (cluster.members.length >= 100) return;
  const a = Math.random() * TAU;
  const d = rand(cluster.size * 0.15, cluster.size * 0.95);
  const p = spawnBubble(
    s,
    cluster.x + Math.cos(a) * d,
    cluster.y + Math.sin(a) * d,
    rand(3, 9),
    {
      hue: rand(CONFIG.CLUSTER_HUE_MIN, CONFIG.CLUSTER_HUE_MAX),
      kind: 3,
      life: 9999,
      buoy: 0,
      thick: rand(0.5, 1)
    }
  );
  if (!p) return;
  p.cluster = cluster;
  p.orbR = d;
  p.orbA = a;
  p.orbW = rand(0.6, 2.2) * (Math.random() < 0.5 ? 1 : -1);
  cluster.members.push(p);
}

function shedMember(s) {
  const cluster = s.cluster;
  if (!cluster || cluster.members.length < 4) return;
  let idx = -1;
  for (let i = 0; i < cluster.members.length; i++) {
    const m = cluster.members[i];
    if (m.alive && m.orbR > cluster.size * 0.7) { idx = i; break; }
  }
  if (idx < 0) idx = (Math.random() * cluster.members.length) | 0;
  const p = cluster.members[idx];
  if (!p || !p.alive) return;
  p.cluster = null;
  p.kind = 0;
  p.maxLife = p.life + rand(3, 6);
  p.buoy = rand(CONFIG.BUOY_MIN, CONFIG.BUOY_MAX);
  const a = p.orbA + cluster.rot;
  p.driftVx = Math.cos(a) * 55;
  p.vy = -rand(20, 60);
  cluster.members.splice(idx, 1);
}

function splitOneMember(s) {
  const cluster = s.cluster;
  if (!cluster) return;
  const m = cluster.members;
  if (m.length < 3 || m.length >= 96) return;
  let idx = -1, best = 8;
  for (let i = 0; i < m.length; i++) {
    if (m[i].alive && m[i].r > best) { best = m[i].r; idx = i; }
  }
  if (idx < 0) return;
  const p = m[idx];
  const nr = p.r * 0.72;
  p.rTarget = nr;
  p.r = nr;

  const a = Math.random() * TAU;
  const nb = spawnBubble(s, p.x + Math.cos(a) * p.r * 1.3, p.y + Math.sin(a) * p.r * 1.3, nr, {
    hue: rand(CONFIG.CLUSTER_HUE_MIN, CONFIG.CLUSTER_HUE_MAX),
    kind: 3, life: 9999, buoy: 0,
    thick: rand(0.5, 1)
  });
  if (nb) {
    nb.cluster = cluster;
    nb.orbR = Math.sqrt((nb.x - cluster.x) * (nb.x - cluster.x) + (nb.y - cluster.y) * (nb.y - cluster.y));
    nb.orbA = Math.atan2(nb.y - cluster.y, nb.x - cluster.x);
    nb.orbW = p.orbW * 1.15;
    cluster.members.push(nb);
  }
  p.orbR = Math.sqrt((p.x - cluster.x) * (p.x - cluster.x) + (p.y - cluster.y) * (p.y - cluster.y));
  p.orbA = Math.atan2(p.y - cluster.y, p.x - cluster.x);
}

function startRight(s) {
  if (s.rightDown) return;
  s.rightDown = true;
  s.rightT = 0;

  s.cluster = {
    active: true,
    x: s.input.x, y: s.input.y,
    rot: 0, rotSpeed: 0.6,
    size: CONFIG.CLUSTER_SIZE0,
    targetSize: CONFIG.CLUSTER_SIZE0,
    members: [],
    shedAcc: 0
  };

  for (let i = 0; i < 16; i++) addClusterMember(s);
}

function updateCluster(s, dt) {
  const M = s.input;
  const cluster = s.cluster;
  if (!cluster) return;
  if (!cluster.active) { s.cluster = null; return; }

  s.rightT += dt;
  const tn = Math.min(s.rightT, CONFIG.CHARGE_MAX) / CONFIG.CHARGE_MAX;

  // 中心跟随光标
  const fk = Math.min(1, dt * 22);
  cluster.x += (M.x - cluster.x) * fk;
  cluster.y += (M.y - cluster.y) * fk;

  // 尺寸
  cluster.targetSize = CONFIG.CLUSTER_SIZE0 + (CONFIG.CLUSTER_SIZE1 - CONFIG.CLUSTER_SIZE0) * tn;
  cluster.size += (cluster.targetSize - cluster.size) * Math.min(1, dt * 4);

  // 自转
  cluster.rotSpeed = 0.5 + tn * 2.8;
  cluster.rot += cluster.rotSpeed * dt;

  // 呼吸
  const breath = 1 + Math.sin(s.rightT * (3 + tn * 10)) * 0.06 * tn;

  // 补充成员
  const want = Math.floor(18 + tn * 66);
  let guard = 0;
  while (cluster.members.length < want && guard++ < 5) addClusterMember(s);

  // 剥落小气泡
  cluster.shedAcc += dt * (1.4 + tn * 15);
  guard = 0;
  while (cluster.shedAcc >= 1 && guard++ < 6) {
    cluster.shedAcc -= 1;
    shedMember(s);
  }

  // 更新成员
  const lim = cluster.size * breath;
  for (let i = cluster.members.length - 1; i >= 0; i--) {
    const p = cluster.members[i];
    if (!p.alive || p.cluster !== cluster) {
      cluster.members.splice(i, 1);
      continue;
    }
    p.orbA += p.orbW * dt;
    if (p.orbR > lim) p.orbR += (lim - p.orbR) * Math.min(1, dt * 4);
    const a = p.orbA + cluster.rot;
    const tx = cluster.x + Math.cos(a) * p.orbR;
    const ty = cluster.y + Math.sin(a) * p.orbR;
    const mk = Math.min(1, dt * 18);
    p.x += (tx - p.x) * mk;
    p.y += (ty - p.y) * mk;
    p.vx = 0; p.vy = 0;
    p.flash = Math.max(p.flash, tn * 0.35);
    p.thick = Math.max(p.thick, tn * 0.9);
  }

  // 内部分裂
  if (Math.random() < dt * (3 + tn * 16)) splitOneMember(s);
}

function endRight(s) {
  if (!s.rightDown) return;
  s.rightDown = false;
  const t = s.rightT;
  const power = Math.pow(Math.min(t, CONFIG.CHARGE_MAX) / CONFIG.CHARGE_MAX, 1.6);
  if (!s.cluster) return;
  releaseCluster(s, power, t < CONFIG.CHARGE_CLICK_R);
}

function releaseCluster(s, power, weak) {
  const c = s.cluster;
  if (!c) return;
  c.active = false;

  const cx = c.x, cy = c.y;
  const upV = weak ? (140 + 260 * power) : (300 + 1000 * power);

  for (let i = 0; i < c.members.length; i++) {
    const p = c.members[i];
    if (!p.alive) continue;
    p.cluster = null;
    p.kind = 0;
    const a = Math.random() * TAU;
    const sx = Math.cos(a) * (40 + power * 150);
    p.vx = sx;
    p.driftVx = sx;
    p.vy = -upV * rand(0.72, 1.3);
    p.buoy = rand(CONFIG.BUOY_MIN, CONFIG.BUOY_MAX);
    p.maxLife = p.life + rand(6, 14);
    p.flash = 0.95;
    p.stretch = 0.14;
    p.thick = Math.max(0.6, p.thick);
    // 过膨胀破裂
    if (!weak && Math.random() < 0.15) {
      p.overExpand = true;
      p.overTimer = rand(0.22, 0.7);
    }
  }
  c.members.length = 0;

  // 膜残迹标记上升路径
  const shards = Math.floor(8 + power * 20);
  for (let sh = 0; sh < shards; sh++) {
    const sa = Math.random() * TAU;
    spawnShard(
      s,
      cx + Math.cos(sa) * c.size * rand(0.3, 1.1),
      cy + Math.sin(sa) * c.size * rand(0.3, 1.1),
      -Math.PI / 2 + (Math.random() - 0.5) * 1.4,
      40 + 130 * power,
      rand(8, 22),
      rand(CONFIG.CLUSTER_HUE_MIN, CONFIG.CLUSTER_HUE_MAX)
    );
  }

  // 垂直风感：场上拖尾气泡被向上吸入
  for (let k = 0; k < s.bubbles.length; k++) {
    const b = s.bubbles[k];
    if (!b.alive || b.cluster || b.kind === 2) continue;
    const dx = b.x - cx, dy = b.y - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 340) {
      const f = 1 - d / 340;
      b.vy -= (160 + 720 * power) * f;
      b.flash = Math.max(b.flash, 0.55 * f);
    }
  }

  s.fuseChainTimer = Math.max(s.fuseChainTimer, CONFIG.FUSE_CHAIN_T);
  s.afterglow = Math.max(s.afterglow, 0.8);
  s.afterglowRate = 18;
  s.cluster = null;
}

/* ============================================================
 * 余韵 / 自然破裂
 * ============================================================ */
function updateAfterglow(s, dt) {
  const M = s.input;
  if (s.afterglow <= 0) return;
  s.afterglow -= dt;
  const k = s.afterglow > 0.5 ? 1 : Math.max(0, s.afterglow * 2);
  s.glowAcc += dt * s.afterglowRate * k;
  let guard = 0;
  while (s.glowAcc >= 1 && guard++ < 8) {
    s.glowAcc -= 1;
    spawnBubble(
      s,
      M.x + (Math.random() - 0.5) * 46,
      M.y + (Math.random() - 0.5) * 46,
      rand(2, 6),
      {
        hue: Math.random() * 360,
        vy: -rand(20, 90),
        life: rand(4, 9)
      }
    );
  }
  if (s.afterglow < 0) s.afterglow = 0;
}

function burstBubble(s, p) {
  const n = 8 + ((Math.random() * 7) | 0);
  for (let i = 0; i < n; i++) {
    const f = allocFx(s);
    if (!f) break;
    const a = Math.random() * TAU;
    const sp = rand(40, 170);
    f.type = 3;
    f.x = p.x; f.y = p.y;
    f.vx = Math.cos(a) * sp;
    f.vy = Math.sin(a) * sp - 30;
    f.life = 0;
    f.maxLife = rand(0.35, 0.8);
    f.alpha = 0.9;
    f.w = rand(0.9, 1.8);
    f.hue = p.hue;
    f.gravity = 420;
  }
  killBubble(p);
}

/* ============================================================
 * 气泡物理更新
 * ============================================================ */
function updateBubbles(s, dt) {
  for (let i = s.bubbles.length - 1; i >= 0; i--) {
    const p = s.bubbles[i];
    if (!p.alive) {
      const last = s.bubbles.length - 1;
      if (i !== last) s.bubbles[i] = s.bubbles[last];
      s.bubbles.pop();
      s.freeBubbles.push(p);
      continue;
    }

    p.life += dt;
    p.huePhase += p.hueSpeed * 30 * dt;
    if (p.fuseCD > 0) p.fuseCD -= dt;
    if (p.flash > 0) {
      p.flash -= dt * CONFIG.FLASH_DECAY;
      if (p.flash < 0) p.flash = 0;
    }
    if (p.ripples > 0) {
      p.ripples -= dt * 6;
      if (p.ripples < 0) p.ripples = 0;
    }

    // ---- 半径弹簧（形变） ----
    const racc = (p.rTarget - p.r) * CONFIG.SPRING_K - p.vr * CONFIG.SPRING_D;
    p.vr += racc * dt;
    p.r += p.vr * dt;
    if (p.r < 0.05) p.r = 0.05;
    if (p.r > 340) p.r = 340;

    // ---- 过膨胀破裂 ----
    if (p.overExpand) {
      p.overTimer -= dt;
      p.rTarget = p.r * 1.004 + 0.4;
      if (p.overTimer <= 0) {
        spawnDroplets(s, p.x, p.y, 10, p.hue, 200, 0.4);
        burstBubble(s, p);
        continue;
      }
    }

    // ---- 运动 ----
    if (p.kind === 2) {
      // 主泡：位置由蓄力逻辑控制
    } else if (p.cluster) {
      // 泡沫簇成员：位置由簇逻辑控制
    } else {
      // 浮力（向上，半径越大越强）
      const buoyAcc = p.buoy * (1 + p.r * CONFIG.BUOY_R_GAIN);
      p.vy -= buoyAcc * dt;
      p.vy *= (1 - CONFIG.DRAG_Y * dt);

      // 水平正弦摆动 + 漂移
      p.wobPhase += p.wobFreq * dt;
      p.driftVx *= (1 - CONFIG.DRAG_DRIFT * dt);
      p.vx = Math.cos(p.wobPhase) * p.wobAmp + p.driftVx;

      // 吸附（卫星泡 / 被污染拖尾）
      if (p.homing && p.homing.alive) {
        const hdx = p.homing.x - p.x;
        const hdy = p.homing.y - p.y;
        const hd = Math.sqrt(hdx * hdx + hdy * hdy) || 1;
        const tvx = (hdx / hd) * 300;
        const tvy = (hdy / hd) * 300;
        const hk = Math.min(1, dt * 9);
        p.vx += (tvx - p.vx) * hk;
        p.vy += (tvy - p.vy) * hk;
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;

      // 形变：速度越快拉伸越明显
      const spd = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
      const tst = Math.min(0.15, spd * 0.00055);
      p.stretch += (tst - p.stretch) * Math.min(1, dt * 9);
    }

    // ---- 寿命 / 自然破裂 ----
    if (p.kind !== 2 && !p.cluster && !p.overExpand) {
      if (p.life > p.maxLife) {
        if (p.r >= 10) {
          burstBubble(s, p);
          continue;
        } else {
          p.rTarget = 0;
          if (p.r < 0.5) { killBubble(p); continue; }
        }
      }
    }

    // ---- 出界回收 ----
    if (p.kind !== 2) {
      if (p.y < -140 - p.r || p.y > s.H + 420 || p.x < -320 - p.r || p.x > s.W + 320 + p.r) {
        if (p.cluster) p.cluster = null;
        killBubble(p);
      }
    }
  }
}

/* ============================================================
 * 特效更新
 * ============================================================ */
function updateFx(s, dt) {
  for (let i = s.fxList.length - 1; i >= 0; i--) {
    const f = s.fxList[i];
    if (!f.alive) {
      const last = s.fxList.length - 1;
      if (i !== last) s.fxList[i] = s.fxList[last];
      s.fxList.pop();
      s.freeFx.push(f);
      continue;
    }
    f.life += dt;
    if (f.life >= f.maxLife) {
      f.alive = false;
      continue;
    }
    const prog = f.life / f.maxLife;

    if (f.type === 0) {
      f.r = f.r0 + (f.r1 - f.r0) * prog;
    } else if (f.type === 1) {
      f.rot += f.rotV * dt;
    } else if (f.type === 2) {
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.vx *= (1 - 1.1 * dt);
      f.vy *= (1 - 1.1 * dt);
      f.vy += 40 * dt;
      f.rot += f.rotV * dt;
      f.r *= (1 + 1.0 * dt);
      f.w *= (1 - 1.15 * dt);
      f.len *= (1 - 0.7 * dt);
    } else {
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.vy += f.gravity * dt;
      f.vx *= (1 - 1.6 * dt);
      f.vy *= (1 - 0.7 * dt);
    }
  }
}

export class CursorBubble extends CursorEffectElement {
  // 原型用的是 mousemove / mousedown / mouseup（不是 pointer 事件族），
  // 不声明这一行，基类会去监听 pointermove，动效将完全收不到鼠标输入。
  inputFamily = 'mouse';

  /* ==========================================================
     初始化
     ========================================================== */
  // 只建池与状态，不注册任何监听（监听、DPR 缩放、rAF 全归基类）
  setup({ ctx, width, height, input }) {
    // 与原型一致：初始光标位置取视口中心。
    // 基类的 input 从 (0, 0) 起算，若不在这里对齐，首帧的位移会按「从左上角跳过来」计算，
    // 速度与拖尾生成量会和原型不同。
    input.x = input.lx = width * 0.5;
    input.y = input.ly = height * 0.5;

    // ---- 气泡池：预分配全部对象到空闲表，bubbles 从空开始 ----
    const bubbles = [];
    const freeBubbles = [];
    for (let i = 0; i < CONFIG.MAX_BUBBLES; i++) freeBubbles.push(createBubbleObj());

    // ---- 特效池 ----
    const fxList = [];
    const freeFx = [];
    for (let i = 0; i < CONFIG.MAX_FX; i++) freeFx.push(createFxObj());

    return {
      // 本实例的画布上下文（已按 DPR 缩放过，统一使用 CSS 像素坐标）
      ctx,

      // 画布尺寸（CSS 像素），由基类 onResize 同步
      W: width,
      H: height,

      input,

      bubbles,
      freeBubbles,
      idCounter: 0,           // 气泡自增 id（融合时等半径的先后判定）

      fxList,
      freeFx,

      gridMap: new Map(),     // 融合检测空间网格
      fuseChainTimer: 0,

      // ---- 蓄力状态 ----
      leftDown: false, leftT: 0,
      rightDown: false, rightT: 0,
      mainBubble: null,
      cluster: null,
      satAcc: 0,

      // ---- 拖尾 ----
      trailAcc: 0,

      // ---- 余韵 ----
      afterglow: 0, afterglowRate: 0, glowAcc: 0
    };
  }

  /* ==========================================================
     输入（按键）—— 鼠标速度由基类算好，这里只处理左右键交互
     ========================================================== */
  onPointerDown(e) {
    const s = this.state;
    if (!s) return;
    // 原型以 mousedown 时的 mouse.x / mouse.y（即最后一次 mousemove 的位置）为原点，
    // 与基类的 input.x / input.y 语义一致
    if (e.button === 0) startLeft(s);
    else if (e.button === 2) startRight(s);
  }

  onPointerUp(e) {
    const s = this.state;
    if (!s) return;
    if (e.button === 0) endLeft(s);
    else if (e.button === 2) endRight(s);
  }

  // 失焦：清理蓄力状态（原型 window blur 的行为）
  onBlur() {
    const s = this.state;
    if (!s) return;

    if (s.mainBubble && s.mainBubble.alive) {
      const p = s.mainBubble;
      p.kind = 0;
      p.surf = 0;
      p.homing = null;
      p.buoy = rand(CONFIG.BUOY_MIN, CONFIG.BUOY_MAX);
      p.maxLife = p.life + 4;
      p.membLit = 0;
      p.pulse = 1;
      p.thick = 1;
      p.membW = CONFIG.MEMB_W_MAX;
      s.mainBubble = null;
    }
    if (s.cluster) releaseCluster(s, 0, true);
    s.leftDown = false;
    s.rightDown = false;
  }

  /* ==========================================================
     尺寸 —— 只同步动效自己的 W / H，画布尺寸与 DPR 由基类维护
     ========================================================== */
  onResize(width, height) {
    const s = this.state;
    if (!s) return;
    s.W = width;
    s.H = height;
  }

  /* ==========================================================
     每帧更新
     ========================================================== */
  update(dt, s) {
    if (!s) return;

    // —— 鼠标位移 / 速度：由基类每帧写入 this.input，这里不再重复计算 ——

    if (s.fuseChainTimer > 0) s.fuseChainTimer -= dt;

    updateCharge(s, dt);
    updateCluster(s, dt);
    updateTrail(s, dt);
    updateAfterglow(s, dt);
    updateBubbles(s, dt);
    fusePass(s);
    updateFx(s, dt);
  }

  /* ==========================================================
     渲染
     ========================================================== */
  render(s) {
    if (!s) return;
    const ctx = s.ctx;

    // 清屏：原型 render() 本身就是 clearRect 起手、画布全程透明，
    // 没有任何整屏铺底，移植后同样只清除上一帧内容，绝不覆盖宿主页面。
    ctx.clearRect(0, 0, s.W, s.H);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    let i, p;
    for (i = 0; i < s.bubbles.length; i++) {
      p = s.bubbles[i];
      if (p.alive) drawBubble(ctx, p);
    }
    for (i = 0; i < s.fxList.length; i++) {
      if (s.fxList[i].alive) drawFx(ctx, s.fxList[i]);
    }
  }
}

if (!customElements.get('cursor-bubble')) {
  customElements.define('cursor-bubble', CursorBubble);
}

export default CursorBubble;
