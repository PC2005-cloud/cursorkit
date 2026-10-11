/**
 * cursor-planet —— 鼠标光标星球动效（左键吸积坍缩 / 右键行星解体）。
 *
 * 由 html/星球.html 原型移植：算法流程、数值、视觉表现与原文件一一对应。
 * 作为光标层组件，原型页面自身的行为已剔除：
 *   - 不携带深色页面底色。原型那层 #04030a 来自 body 的 CSS，绘制代码里
 *     本来就没有整屏铺底，render() 用的就是 clearRect，因此无需删改；
 *   - 不拦截 contextmenu，宿主页面的右键菜单不受影响；
 *   - 画布创建、DPR 适配、尺寸同步、监听注册、rAF 循环全部由基类负责；
 *     基类同时维护 input（含平滑速度与「>300px 跳变归零 / 6000 封顶」），
 *     但本动效的拖尾初速与原文件一致，取的是瞬时帧位移 / dt。
 *
 * 原型监听 mousemove / mousedown / mouseup，因此声明 inputFamily = 'mouse'。
 * 所有运行状态都放在 setup() 返回的 state 上，多实例互不干扰。
 */

import { CursorEffectElement } from '../core/base.js';
import { TAU, clamp, rand, mixColor } from '../core/utils.js';

/* ============================================================================
   CONFIG —— 集中所有可调参数
   ============================================================================ */
const CONFIG = {
  MAX_PARTICLES: 2800,
  DPR_MAX: 2,
  CHARGE_TIME: 2.5,
  ORBIT_FLAT: 0.40,
  KEPLER_K: 900,
  GRAVITY_DROP_BASE: 46,
  GRAVITY_DROP_GAIN: 70,

  TRAIL: {
    DIST_STEP: 9,
    MAX_PER_FRAME: 6,
    SPEED_SCALE: 0.30,
    RAND_SPEED: 70,
    LIFE_MIN: 1.2,
    LIFE_MAX: 2.5,
    DRAG: 0.10,
    COHESION: 520,
    COH_RADIUS: 30,
    MAX_ACC: 520
  },

  CLICK: {
    DUST_MIN: 18,
    DUST_MAX: 26,
    DUST_SPEED: 300,
    RING_R0: 8,
    RING_R1: 80,
    MINI_MIN: 3,
    MINI_MAX: 5
  },

  SLING: {
    RADIUS: 200,
    DURATION: 0.24,
    BOOST: 1.8,
    FLASH: 0.25
  },

  ACCRETION: {
    R0: 60,
    R1: 260,
    DOPSPLIT: 0.6
  },

  PLANET: {
    RING_RADII: [34, 58, 86, 118, 152],
    MAX_R: 22
  },

  SUPERNOVA: {
    BASE_DUST: 120,
    GAIN_DUST: 380,
    BASE_SPEED: 400,
    GAIN_SPEED: 1400,
    SHELL_BASE: 120,
    SHELL_GAIN: 500,
    JET_LEN_BASE: 200,
    JET_LEN_GAIN: 600,
    JET_SPD_BASE: 800,
    JET_SPD_GAIN: 1600
  },

  RINGBURST: {
    BASE_FRAG: 40,
    GAIN_FRAG: 120,
    SHELL_BASE: 150,
    SHELL_GAIN: 450
  }
};

/* ============================================================================
   颜色与色带
   ============================================================================ */
const C = {
  purple:   [42, 27, 78],
  blue:     [74, 107, 255],
  cyanW:    [168, 232, 255],
  white:    [255, 255, 255],
  orange:   [255, 179, 71],
  red:      [255, 61, 61],
  violet:   [120, 70, 200],
  sandy:    [232, 200, 122],
  ochre:    [200, 138, 74],
  brown:    [107, 74, 42],
  darkRed:  [138, 58, 42],
  iceWhite: [232, 244, 255],
  paleGold: [255, 232, 176],
  paleCyan: [176, 224, 255],
  atmos:    [107, 232, 255]
};

const ACC_STOPS = [
  [0.00, C.white],
  [0.12, [255, 240, 220]],
  [0.30, C.orange],
  [0.58, C.blue],
  [1.00, C.purple]
];
const SN_STOPS = [
  [0.00, C.white],
  [0.22, C.orange],
  [0.52, C.red],
  [1.00, C.violet]
];

// 沿多段色带取色（原型 gradCol）
function gradCol(stops, t) {
  t = clamp(t, 0, 1);
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    if (t <= b[0]) {
      const k = (t - a[0]) / ((b[0] - a[0]) || 1);
      return mixColor(a[1], b[1], k);
    }
  }
  return stops[stops.length - 1][1];
}

/* ============================================================================
   粒子池
   ============================================================================ */
const MAXP = CONFIG.MAX_PARTICLES;
const T_DUST = 0;
const T_ORBIT = 1;
const T_JET = 2;
const T_NEBULA = 3;
const T_FRAG = 4;
const T_SHELL = 5;
const T_ARC = 6;
const T_RINGWAVE = 7;

function newParticle() {
  return {
    active: false, type: 0, mode: 0,
    x: 0, y: 0, vx: 0, vy: 0,
    cx: 0, cy: 0,
    a: 0, theta: 0, omega: 0, decay: 0, flat: CONFIG.ORBIT_FLAT, dir: 1,
    life: 0, maxLife: 1, size: 1, alpha: 1, drag: 0,
    col: [255, 255, 255],
    depth: 0, flash: 0, extra: 0, rot: 0, rotV: 0,
    pts: new Float32Array(16),
    ang0: 0, ang1: 0,
    sling: null, cohesive: 0
  };
}

function resetParticle(p) {
  p.type = 0; p.mode = 0;
  p.vx = 0; p.vy = 0;
  p.cx = 0; p.cy = 0;
  p.a = 0; p.theta = 0; p.omega = 0; p.decay = 0;
  p.flat = CONFIG.ORBIT_FLAT; p.dir = 1;
  p.life = 1; p.maxLife = 1; p.size = 1; p.alpha = 1; p.drag = 0;
  p.depth = 0; p.flash = 0; p.extra = 0; p.rot = 0; p.rotV = 0;
  p.ang0 = 0; p.ang1 = 0;
  p.sling = null; p.cohesive = 0;
  p.col = C.white;
}

/* ============================================================================
   椭圆轨道数学
   ============================================================================ */
function orbitOmega(a, dir) {
  const r = Math.max(a, 6);
  return dir * CONFIG.KEPLER_K / (r * Math.sqrt(r));
}
function orbitPlace(p) {
  const ca = Math.cos(p.theta), sa = Math.sin(p.theta);
  p.x = p.cx + p.a * ca;
  p.y = p.cy + p.a * sa * p.flat;
  p.depth = sa;
}

/* ============================================================================
   渲染（只读 state，不修改）
   ============================================================================ */
function drawDust(ctx, p, lifeR) {
  let a = p.alpha * lifeR;
  let col = p.col;
  if (p.flash > 0) {
    a = Math.min(1, a * 1.9);
    col = C.cyanW;
  }
  ctx.globalAlpha = a;
  ctx.fillStyle = `rgb(${col[0] | 0},${col[1] | 0},${col[2] | 0})`;
  const s = p.size;
  if (s <= 1.7) {
    ctx.fillRect(p.x - s, p.y - s, s * 2, s * 2);
  } else {
    ctx.beginPath();
    ctx.arc(p.x, p.y, s, 0, TAU);
    ctx.fill();
  }
}

function drawOrbitParticle(ctx, p, lifeR, accNorm) {
  const sr = p.depth;
  const depthScale = 1 + 0.22 * sr;
  const depthBright = 1 + 0.18 * sr;

  let col, alpha;

  if (p.mode === 0) {
    const rt = clamp(p.a / accNorm, 0, 1);
    col = gradCol(ACC_STOPS, rt);
    const vxm = -sr * (p.omega >= 0 ? 1 : -1);
    let dop;
    if (vxm < 0) dop = 1 + CONFIG.ACCRETION.DOPSPLIT * (-vxm);
    else dop = 1 - 0.4 * vxm;
    if (dop > 1) col = mixColor(col, C.white, (dop - 1) * 0.9);
    else col = mixColor(col, C.red, (1 - dop) * 0.7);
    alpha = p.alpha * dop * depthBright;
  } else if (p.mode === 1) {
    col = p.col;
    alpha = p.alpha * depthBright;
  } else {
    col = p.col;
    alpha = p.alpha;
  }

  alpha *= lifeR;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = `rgb(${col[0] | 0},${col[1] | 0},${col[2] | 0})`;

  const s = p.size * depthScale;
  if (s <= 1.7) {
    ctx.fillRect(p.x - s, p.y - s, s * 2, s * 2);
  } else {
    ctx.beginPath();
    ctx.arc(p.x, p.y, s, 0, TAU);
    ctx.fill();
  }
}

function drawJet(ctx, p, lifeR) {
  const a = p.alpha * lifeR;
  if (a <= 0.02) return;
  ctx.globalAlpha = a;
  ctx.strokeStyle = `rgb(${p.col[0] | 0},${p.col[1] | 0},${p.col[2] | 0})`;
  ctx.lineWidth = Math.max(0.8, p.size * 0.22);
  const tl = p.size;
  const vl = Math.hypot(p.vx, p.vy) || 1;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(p.x - p.vx / vl * tl, p.y - p.vy / vl * tl);
  ctx.stroke();
}

function drawNebula(ctx, p, lifeR) {
  const a = p.alpha * lifeR;
  if (a <= 0.005) return;
  const R = p.size;
  const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, R);
  const c = p.col;
  g.addColorStop(0, `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`);
  g.addColorStop(0.5, `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a * 0.45})`);
  g.addColorStop(1, `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},0)`);
  ctx.globalAlpha = 1;
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(p.x, p.y, R, 0, TAU);
  ctx.fill();
}

function drawFrag(ctx, p, lifeR) {
  const a = lifeR;
  ctx.globalAlpha = a;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.rot);
  ctx.beginPath();
  ctx.moveTo(p.pts[0], p.pts[1]);
  for (let i = 2; i < 12; i += 2) ctx.lineTo(p.pts[i], p.pts[i + 1]);
  ctx.closePath();
  const c = p.col;
  ctx.fillStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
  ctx.fill();
  ctx.globalAlpha = a * 0.55;
  ctx.fillStyle = `rgb(${(c[0] * 0.6) | 0},${(c[1] * 0.5) | 0},${(c[2] * 0.4) | 0})`;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(p.pts[0] * 0.5, p.pts[1] * 0.5);
  ctx.lineTo(p.pts[2] * 0.5, p.pts[3] * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawShell(ctx, p, lifeR) {
  const a0 = p.alpha * lifeR;
  if (a0 <= 0.01) return;
  const LAYERS = 8;
  for (let i = 0; i < LAYERS; i++) {
    const t = i / (LAYERS - 1);
    const r = p.a * (1 - t * 0.42);
    if (r <= 0.5) continue;
    const al = a0 * (1 - t) * 0.20;
    const col = mixColor(C.white, p.col, t);
    ctx.globalAlpha = al;
    ctx.strokeStyle = `rgb(${col[0] | 0},${col[1] | 0},${col[2] | 0})`;
    ctx.lineWidth = 2 + 7 * (1 - t);
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, r, r * p.flat, 0, 0, TAU);
    ctx.stroke();
  }
}

function drawArc(ctx, p, lifeR) {
  const a = p.alpha * lifeR;
  if (a <= 0.01) return;
  const r = p.decay > 0 ? p.a + (1 - lifeR) * p.decay * 1.2 : p.a;
  ctx.globalAlpha = a;
  ctx.strokeStyle = `rgb(${p.col[0] | 0},${p.col[1] | 0},${p.col[2] | 0})`;
  ctx.lineWidth = p.size;
  ctx.beginPath();
  ctx.ellipse(p.cx, p.cy, r, r * p.flat, 0, p.ang0, p.ang1);
  ctx.stroke();
}

function drawRingWave(ctx, p, lifeR) {
  const a = p.alpha * lifeR;
  if (a <= 0.01) return;
  const r = p.a;
  const g = ctx.createRadialGradient(p.x, p.y, r * 0.55, p.x, p.y, r * 1.12);
  const c = p.col;
  g.addColorStop(0.0, `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},0)`);
  g.addColorStop(0.62, `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},0)`);
  g.addColorStop(0.88, `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a * 0.9})`);
  g.addColorStop(1.0, `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},0)`);
  ctx.globalAlpha = 1;
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r * 1.12, 0, TAU);
  ctx.fill();
}

// 原星：蓄力中的光核；collapse 非 0 时收缩为内爆前一瞬
function drawProtoStar(ctx, s, cx, cy, ct, collapse) {
  const p01 = Math.min(ct / CONFIG.CHARGE_TIME, 1);
  let R = 4 + 10 * p01;

  if (collapse > 0) R *= 0.3;

  const flick = 0.82 + 0.18 * Math.sin(s.elapsed * 41) * Math.sin(s.elapsed * 17);
  const glowR = R * (5 + 6 * p01);

  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
  g.addColorStop(0, `rgba(255,255,255,${0.95 * flick})`);
  g.addColorStop(0.10, `rgba(255,240,220,${0.7 * flick})`);
  g.addColorStop(0.28, `rgba(168,232,255,${0.35 * p01 + 0.12})`);
  g.addColorStop(0.6, `rgba(74,107,255,${0.12})`);
  g.addColorStop(1, `rgba(42,27,78,0)`);
  ctx.globalAlpha = 1;
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, glowR, 0, TAU);
  ctx.fill();

  ctx.globalAlpha = flick;
  ctx.fillStyle = p01 > 0.85 ? '#FFFFFF' : `rgb(255,${(230 + 25 * p01) | 0},${(200 + 55 * p01) | 0})`;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, TAU);
  ctx.fill();
}

function drawPlanetBody(ctx, s, cx, cy, p01) {
  const R = 6 + (CONFIG.PLANET.MAX_R - 6) * p01;
  if (R <= 0.5) return;

  const glowR = R * (1.7 + 0.9 * p01);
  const g0 = ctx.createRadialGradient(cx, cy, R * 0.82, cx, cy, glowR);
  const ga = 0.22 + 0.42 * p01;
  g0.addColorStop(0, `rgba(107,232,255,${ga})`);
  g0.addColorStop(0.5, `rgba(107,232,255,${ga * 0.35})`);
  g0.addColorStop(1, 'rgba(107,232,255,0)');
  ctx.globalAlpha = 1;
  ctx.fillStyle = g0;
  ctx.beginPath();
  ctx.arc(cx, cy, glowR, 0, TAU);
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, TAU);
  ctx.clip();

  const g1 = ctx.createRadialGradient(
    cx - R * 0.38, cy - R * 0.42, R * 0.08,
    cx, cy, R * 1.12
  );
  g1.addColorStop(0.00, '#F7E9BC');
  g1.addColorStop(0.32, '#E8C87A');
  g1.addColorStop(0.62, '#C88A4A');
  g1.addColorStop(0.85, '#6B4A2A');
  g1.addColorStop(1.00, '#3A2416');
  ctx.fillStyle = g1;
  // 星球本体贴图：被 clip 裁在球体圆内，不是整屏铺底
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

  const bands = 8;
  const flow = s.elapsed * (0.12 + 0.5 * p01);
  for (let i = 0; i < bands; i++) {
    const base = (i + 0.5) / bands;
    let by = ((base + flow * 0.05) % 1);
    const yy = cy - R + by * R * 2;
    const h = R * (0.09 + 0.08 * ((i % 3) / 2));
    const w = Math.sqrt(Math.max(0, 1 - Math.pow((yy - cy) / R, 2))) * R * 1.15 + 2;
    ctx.globalAlpha = 0.30;
    const c = i % 3 === 0 ? C.sandy : (i % 3 === 1 ? C.ochre : C.darkRed);
    ctx.fillStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
    ctx.beginPath();
    ctx.ellipse(cx, yy, w, h, 0, 0, TAU);
    ctx.fill();
  }

  const g2 = ctx.createRadialGradient(
    cx + R * 0.55, cy + R * 0.55, R * 0.1,
    cx + R * 0.25, cy + R * 0.25, R * 1.35
  );
  g2.addColorStop(0, 'rgba(0,0,0,0)');
  g2.addColorStop(0.62, 'rgba(0,0,0,0)');
  g2.addColorStop(1, 'rgba(4,3,10,0.72)');
  ctx.globalAlpha = 1;
  ctx.fillStyle = g2;
  // 晨昏线阴影：同样被 clip 裁在球体圆内
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

  ctx.restore();

  ctx.globalAlpha = 0.35 + 0.45 * p01;
  ctx.strokeStyle = 'rgba(107,232,255,0.85)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.98, 0, TAU);
  ctx.stroke();
}

function drawPulsar(ctx, s) {
  const pulsar = s.pulsar;
  const t = pulsar.t / pulsar.life;
  const phase = (s.elapsed % 0.08) / 0.08;
  const flick = phase < 0.5 ? 1 : 0.25;
  const a = t * flick;
  const R = 3 + 5 * t;
  const g = ctx.createRadialGradient(pulsar.x, pulsar.y, 0, pulsar.x, pulsar.y, R * 7);
  g.addColorStop(0, `rgba(255,255,255,${a})`);
  g.addColorStop(0.18, `rgba(168,232,255,${a * 0.7})`);
  g.addColorStop(0.5, `rgba(74,107,255,${a * 0.25})`);
  g.addColorStop(1, 'rgba(42,27,78,0)');
  ctx.globalAlpha = 1;
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(pulsar.x, pulsar.y, R * 7, 0, TAU);
  ctx.fill();

  ctx.globalAlpha = a;
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.arc(pulsar.x, pulsar.y, R, 0, TAU);
  ctx.fill();
}

export class CursorPlanet extends CursorEffectElement {
  /**
   * 滚轮动效：星尘被抛出后受重力拉回，像被星球引力牵引。
   */
  wheelTheme() {
    return {
      style: 'spray',
      color:  [168, 200, 255],
      color2: [255, 255, 255],
      sizeMin: 1.6, sizeMax: 4,
      lifeMin: 0.6, lifeMax: 1.3,
      upSpeed: 300,
      downSpeed: 260,
      spread: 140,
      gravity: 560,          // 引力拉回
      drag: 0.5,
      turbulence: 20,
      jitter: 14
    };
  }

  /** 主题光标：星蓝描边 + 寒气装饰 */
  cursorTheme() {
    return {
      edge: '#a8c8ff',
      fill: 'rgba(14, 20, 40, .88)',
      glow: '#8fa8ff',
      deco: { color: [168, 200, 255], style: 'cold', rate: 13, speedGain: 0.2 }
    };
  }

  // 原型用的是 mousemove / mousedown / mouseup（不是 pointer 事件族），
  // 不声明这一行，基类会去监听 pointermove，动效将完全收不到鼠标输入。
  inputFamily = 'mouse';

  /* ==========================================================================
     初始化
     ========================================================================== */
  // 只建池与状态，不注册任何监听（监听、DPR 缩放、rAF 全归基类）
  setup({ ctx, width, height, input }) {
    // 与原型一致：初始光标位置取视口中心。
    // 基类的 input 从 (0, 0) 起算，若不在这里对齐，首帧的位移会按「从左上角跳过来」计算，
    // 速度与拖尾生成量会和原型不同。
    input.x = input.lx = width * 0.5;
    input.y = input.ly = height * 0.5;

    // 粒子池：预分配 MAXP 个，环形游标复用
    const pool = new Array(MAXP);
    for (let i = 0; i < MAXP; i++) pool[i] = newParticle();

    return {
      // 本实例的画布上下文（已按 DPR 缩放过，统一使用 CSS 像素坐标）
      ctx,

      // 画布尺寸（CSS 像素），由基类 onResize 同步
      W: width,
      H: height,

      input,

      pool,
      poolHead: 0,

      // 凝聚力的空间哈希网格（原型的 gridMap）
      grid: new Map(),

      // 蓄力状态
      charge: { active: false, button: 0, t: 0, x: 0, y: 0 },
      // 待释放事件（原型的 pendingRelease）
      pendingRelease: null,

      // 按键去重：原型用 mouse.down / mouse.button 判定
      down: false,
      button: -1,

      // 超新星脉冲星余辉（原型的 pulsar）
      pulsar: null,

      // 吸积盘取色的归一化半径上限（原型的 accNorm）
      accNorm: 120,

      // 全局时间（原型的 elapsed）
      elapsed: 0
    };
  }

  /* ==========================================================================
     粒子池操作
     ========================================================================== */
  // 取一个粒子：池满时环形覆盖最老的一个（与原型一致）
  _spawnP(s) {
    const p = s.pool[s.poolHead];
    s.poolHead = (s.poolHead + 1) % MAXP;
    p.active = true;
    resetParticle(p);
    return p;
  }

  /* ==========================================================================
     拖尾
     ========================================================================== */
  _spawnTrailParticle(s, x, y, vx, vy) {
    const p = this._spawnP(s);
    p.type = T_DUST;
    p.x = x; p.y = y;
    p.vx = vx * CONFIG.TRAIL.SPEED_SCALE + rand(-CONFIG.TRAIL.RAND_SPEED, CONFIG.TRAIL.RAND_SPEED);
    p.vy = vy * CONFIG.TRAIL.SPEED_SCALE + rand(-CONFIG.TRAIL.RAND_SPEED, CONFIG.TRAIL.RAND_SPEED);
    p.life = p.maxLife = rand(CONFIG.TRAIL.LIFE_MIN, CONFIG.TRAIL.LIFE_MAX);
    p.size = rand(0.8, 2.0);
    p.drag = CONFIG.TRAIL.DRAG;
    p.cohesive = 1;
    const r = Math.random();
    p.col = r < 0.45 ? C.cyanW : (r < 0.78 ? C.blue : C.white);
    p.alpha = rand(0.5, 0.95);
  }

  _buildGrid(s) {
    const grid = s.grid;
    grid.clear();
    const cs = CONFIG.TRAIL.COH_RADIUS;
    for (let i = 0; i < MAXP; i++) {
      const p = s.pool[i];
      if (!p.active || !p.cohesive) continue;
      const k = (((p.x / cs) | 0) + 2048) * 4096 + (((p.y / cs) | 0) + 2048);
      let arr = grid.get(k);
      if (arr === undefined) { arr = []; grid.set(k, arr); }
      arr.push(p);
    }
  }

  _applyCohesion(s, dt) {
    const grid = s.grid;
    const cs = CONFIG.TRAIL.COH_RADIUS;
    const cs2 = cs * cs;
    const K = CONFIG.TRAIL.COHESION;
    const MAXA = CONFIG.TRAIL.MAX_ACC;
    for (let i = 0; i < MAXP; i++) {
      const p = s.pool[i];
      if (!p.active || !p.cohesive || p.sling) continue;
      const gx = (p.x / cs) | 0, gy = (p.y / cs) | 0;
      let ax = 0, ay = 0, cnt = 0;
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const k = ((gx + ox + 2048) * 4096) + (gy + oy + 2048);
          const arr = grid.get(k);
          if (arr === undefined) continue;
          for (let j = 0; j < arr.length; j++) {
            const q = arr[j];
            if (q === p) continue;
            if (++cnt > 42) break;
            const dx = q.x - p.x, dy = q.y - p.y;
            const d2 = dx * dx + dy * dy;
            if (d2 > cs2 || d2 < 1e-4) continue;
            const d = Math.sqrt(d2);
            const f = (1 - d / cs) * K / d;
            ax += dx * f; ay += dy * f;
          }
        }
      }
      let al = Math.hypot(ax, ay);
      if (al > MAXA) { ax = ax / al * MAXA; ay = ay / al * MAXA; }
      p.vx += ax * dt;
      p.vy += ay * dt;
    }
  }

  _updateTrailSpawn(s, dt) {
    const M = s.input;
    const dx = M.x - M.lx;
    const dy = M.y - M.ly;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.6 || dt <= 0) return;

    // 速度取原型的瞬时值：帧位移 / dt（上面的守卫已保证 dt > 0）。
    // 不能用基类 input.vx —— 那是 exp(-25·dt) 平滑值，会让拖尾初速逐帧偏离原文件。
    const vx = dx / dt, vy = dy / dt;

    const n = Math.min(
      CONFIG.TRAIL.MAX_PER_FRAME,
      Math.max(1, Math.round(dist / CONFIG.TRAIL.DIST_STEP))
    );

    for (let i = 0; i < n; i++) {
      const t = (i + 1) / (n + 1);
      const sx = M.x - dx * (1 - t);
      const sy = M.y - dy * (1 - t);

      if (s.charge.active && Math.random() < 0.55) {
        if (s.charge.button === 0) {
          const p01 = Math.min(s.charge.t / CONFIG.CHARGE_TIME, 1);
          this._spawnAccretion(s, s.charge.x, s.charge.y, p01, 1, 40, 60 + 200 * p01);
        } else {
          this._spawnRing(s, s.charge.x, s.charge.y, 0, 1);
        }
      } else {
        this._spawnTrailParticle(s, sx, sy, vx, vy);
      }
    }
  }

  /* ==========================================================================
     蓄力状态
     ========================================================================== */
  _startCharge(s, button) {
    const ch = s.charge;
    ch.active = true;
    ch.button = button;
    ch.t = 0;
    ch.x = s.input.x;
    ch.y = s.input.y;
    s.accNorm = 120;
  }

  _endCharge(s, button, x, y) {
    const ch = s.charge;
    if (!ch.active) return;
    const ct = ch.t;
    ch.active = false;

    /* 关键修复：快速点击与蓄力释放统一走 RAF 路径，
       避免在 mouseup 事件处理器中同步执行粒子生成 / 池扫描导致事件阻塞卡顿 */
    const quick = ct < 0.12;
    s.pendingRelease = {
      t: quick ? 0 : 0.045,
      btn: button,
      x: x,
      y: y,
      ct: ct,
      quick: quick
    };
  }

  _updateCharge(s, dt) {
    const ch = s.charge;
    if (!ch.active) return;
    ch.t += dt;
    ch.x = s.input.x;
    ch.y = s.input.y;
    const p01 = Math.min(ch.t / CONFIG.CHARGE_TIME, 1);

    if (ch.button === 0) {
      const Rout = CONFIG.ACCRETION.R0 + (CONFIG.ACCRETION.R1 - CONFIG.ACCRETION.R0) * p01;
      const n = Math.round(2 + 7 * p01);
      this._spawnAccretion(s, ch.x, ch.y, p01, n, Rout * 0.68, Rout);
      if (Math.random() < 0.55) this._spawnAccretion(s, ch.x, ch.y, p01, 1, 30, 72);

      if (ch.t > 1.2) {
        const jf = (ch.t - 1.2) / (CONFIG.CHARGE_TIME - 1.2);
        this._spawnJets(s, ch.x, ch.y, jf);
      }
    } else {
      this._spawnRing(s, ch.x, ch.y, p01, Math.round(1 + 5 * p01));
    }
  }

  _spawnAccretion(s, cx, cy, p01, n, rmin, rmax) {
    s.accNorm = Math.max(s.accNorm, rmax);
    for (let i = 0; i < n; i++) {
      const p = this._spawnP(s);
      p.type = T_ORBIT;
      p.mode = 0;
      p.cx = cx; p.cy = cy;
      p.a = rand(rmin, rmax);
      p.flat = CONFIG.ORBIT_FLAT;
      p.theta = rand(0, TAU);
      p.dir = 1;
      p.decay = CONFIG.GRAVITY_DROP_BASE + CONFIG.GRAVITY_DROP_GAIN * p01;
      p.life = p.maxLife = 6;
      p.size = rand(0.8, 2.0);
      p.alpha = rand(0.55, 1);
    }
  }

  _spawnRing(s, cx, cy, p01, n) {
    const maxRing = Math.min(CONFIG.PLANET.RING_RADII.length - 1, Math.floor(p01 * 5.6));
    for (let i = 0; i < n; i++) {
      const ri = (Math.random() * (maxRing + 1)) | 0;
      const R = CONFIG.PLANET.RING_RADII[ri];
      const p = this._spawnP(s);
      p.type = T_ORBIT;
      p.mode = 1;
      p.cx = cx; p.cy = cy;
      p.a = R + rand(-5, 5);
      p.flat = CONFIG.ORBIT_FLAT;
      p.theta = rand(0, TAU);
      p.dir = 1;
      p.decay = 0;
      p.life = p.maxLife = 8;
      p.size = rand(0.8, 2.0);
      p.alpha = rand(0.5, 0.95);
      p.col = ri === 0 ? C.paleCyan : (ri === 1 || ri === 2 ? C.paleGold : C.iceWhite);
    }
  }

  _spawnJets(s, cx, cy, jf) {
    const len = 40 + 80 * jf;
    const spd = 220 + 420 * jf;
    const cnt = Math.round(1 + 3 * jf);
    for (let sgn = -1; sgn <= 1; sgn += 2) {
      for (let i = 0; i < cnt; i++) {
        const p = this._spawnP(s);
        p.type = T_JET;
        p.cx = cx; p.cy = cy;
        p.x = cx + rand(-4, 4);
        p.y = cy + rand(-4, 4);
        p.vx = rand(-30, 30);
        p.vy = sgn * spd * rand(0.75, 1.25);
        p.life = p.maxLife = (len / spd) * rand(0.8, 1.3);
        p.size = rand(6, 18);
        p.extra = rand(0, TAU);
        p.col = Math.random() < 0.4 ? C.cyanW : (Math.random() < 0.5 ? C.white : C.blue);
        p.alpha = rand(0.5, 0.95);
      }
    }
  }

  /* ==========================================================================
     单击：微引力脉冲
     ========================================================================== */
  _doClickPulse(s, cx, cy, button) {
    const n = (CONFIG.CLICK.DUST_MIN + Math.random() * (CONFIG.CLICK.DUST_MAX - CONFIG.CLICK.DUST_MIN)) | 0;
    const isLeft = button === 0;
    for (let i = 0; i < n; i++) {
      const p = this._spawnP(s);
      const ang = Math.random() * TAU;
      const spd = rand(120, CONFIG.CLICK.DUST_SPEED);
      p.type = T_DUST;
      p.x = cx; p.y = cy;
      p.vx = Math.cos(ang) * spd;
      p.vy = Math.sin(ang) * spd;
      p.life = p.maxLife = rand(0.8, 1.6);
      p.size = rand(0.9, 2.0);
      p.drag = 0.12;
      p.col = isLeft ? (Math.random() < 0.5 ? C.cyanW : C.white)
                     : (Math.random() < 0.5 ? C.iceWhite : C.paleGold);
      p.alpha = 0.9;
    }

    const rw = this._spawnP(s);
    rw.type = T_RINGWAVE;
    rw.x = cx; rw.y = cy;
    rw.a = CONFIG.CLICK.RING_R0;
    rw.size = CONFIG.CLICK.RING_R1;
    rw.life = rw.maxLife = 0.55;
    rw.col = isLeft ? C.cyanW : C.paleCyan;
    rw.flat = 1;

    const mn = (CONFIG.CLICK.MINI_MIN + Math.random() * (CONFIG.CLICK.MINI_MAX - CONFIG.CLICK.MINI_MIN)) | 0;
    for (let i = 0; i < mn; i++) {
      const p = this._spawnP(s);
      p.type = T_ORBIT;
      p.mode = 2;
      p.cx = cx; p.cy = cy;
      p.a = rand(15, 30);
      p.flat = rand(0.6, 1.0);
      p.theta = Math.random() * TAU;
      p.dir = Math.random() < 0.5 ? 1 : -1;
      p.life = p.maxLife = 0.4;
      p.size = rand(1.0, 2.0);
      p.alpha = 1;
      p.col = isLeft ? C.cyanW : C.paleGold;
    }

    this._applySlingshot(s, cx, cy, 1.0);
    this._spawnSlingshotArcs(s, cx, cy, 1.0);
  }

  /* ==========================================================================
     引力弹弓 + 轨道注入
     ========================================================================== */
  _applySlingshot(s, cx, cy, strength) {
    const R = CONFIG.SLING.RADIUS * strength;
    const R2 = R * R;
    for (let i = 0; i < MAXP; i++) {
      const p = s.pool[i];
      if (!p.active || p.type !== T_DUST || p.sling) continue;
      const dx = p.x - cx, dy = p.y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > R2 || d2 < 1) continue;
      const d = Math.sqrt(d2);
      p.sling = {
        cx: cx, cy: cy,
        r0: d,
        a0: Math.atan2(dy, dx),
        t: 0,
        dur: CONFIG.SLING.DURATION,
        sgn: (dx * p.vy - dy * p.vx) > 0 ? 1 : -1
      };
    }
  }

  _spawnSlingshotArcs(s, cx, cy, strength) {
    const n = 4 + ((Math.random() * 3) | 0);
    for (let i = 0; i < n; i++) {
      const p = this._spawnP(s);
      p.type = T_ARC;
      p.cx = cx; p.cy = cy;
      p.a = rand(30, 120) * strength;
      p.ang0 = Math.random() * TAU;
      p.ang1 = p.ang0 + rand(1.0, 2.4);
      p.flat = rand(0.4, 1.0);
      p.life = p.maxLife = 0.3;
      p.size = rand(1, 2.2);
      p.col = C.cyanW;
      p.alpha = 0.55;
    }
  }

  /* 关键修复：使用平滑缓动，避免第一帧位置瞬移造成的视觉卡顿。
     曲线：半径 r0 → 0.3·r0 → r0；角度 a0 → a0 + π·sgn（绕行半圈） */
  _updateSling(p, dt) {
    const sl = p.sling;
    sl.t += dt;
    let u = sl.t / sl.dur;
    if (u > 1) u = 1;
    // smoothstep 缓入缓出
    const eu = u * u * (3 - 2 * u);

    const r = sl.r0 * (1 - 0.7 * Math.sin(Math.PI * eu));
    const ang = sl.a0 + Math.PI * eu * sl.sgn;

    p.x = sl.cx + Math.cos(ang) * r;
    p.y = sl.cy + Math.sin(ang) * r;

    if (sl.t >= sl.dur) {
      const tx = -Math.sin(ang) * sl.sgn;
      const ty = Math.cos(ang) * sl.sgn;
      const spd = Math.hypot(p.vx, p.vy) * CONFIG.SLING.BOOST + 160;
      p.vx = tx * spd;
      p.vy = ty * spd;
      p.sling = null;
      p.flash = CONFIG.SLING.FLASH;
      p.col = C.cyanW;
    }
  }

  /* ==========================================================================
     粒子更新
     ========================================================================== */
  _updateParticle(s, p, dt) {
    p.life -= dt;
    if (p.life <= 0) { p.active = false; return; }

    if (p.flash > 0) p.flash -= dt;

    switch (p.type) {
      case T_DUST: {
        if (p.sling) { this._updateSling(p, dt); break; }
        const d = Math.exp(-p.drag * dt);
        p.vx *= d; p.vy *= d;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        break;
      }
      case T_ORBIT: {
        if (p.mode === 2) {
          p.theta += p.dir * 16 * dt;
          orbitPlace(p);
          break;
        }
        const a = Math.max(p.a, 6);
        p.omega = orbitOmega(a, p.dir);
        if (p.omega > 14) p.omega = 14;
        if (p.omega < -14) p.omega = -14;
        p.theta += p.omega * dt;

        if (p.mode === 0) {
          const drop = p.decay * dt * (1 + 90 / (p.a + 30));
          p.a -= drop;
          if (p.a < 5) { p.active = false; return; }
        } else if (p.mode === 1) {
          if (s.charge.active && s.charge.button === 2 && s.charge.t > 1.8) {
            const idx = CONFIG.PLANET.RING_RADII.length - 1;
            if (p.a > CONFIG.PLANET.RING_RADII[idx] - 10) {
              p.a += Math.sin(p.life * 9 + p.theta * 3) * 22 * dt;
            }
          }
        }
        orbitPlace(p);
        break;
      }
      case T_JET: {
        p.extra += dt * 11;
        p.x += p.vx * dt + Math.sin(p.extra) * 46 * dt;
        p.y += p.vy * dt;
        break;
      }
      case T_NEBULA: {
        p.a += p.decay * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= Math.exp(-0.55 * dt);
        p.vy *= Math.exp(-0.55 * dt);
        break;
      }
      case T_FRAG: {
        if (p.mode === 1) {
          p.theta += p.omega * dt;
          orbitPlace(p);
        } else {
          p.vx *= Math.exp(-0.10 * dt);
          p.vy *= Math.exp(-0.10 * dt);
          p.x += p.vx * dt;
          p.y += p.vy * dt;
        }
        p.rot += p.rotV * dt;
        break;
      }
      case T_SHELL: {
        p.a += p.decay * dt;
        break;
      }
      case T_ARC: {
        break;
      }
      case T_RINGWAVE: {
        p.a = p.a + (p.size - p.a) * (1 - Math.exp(-8 * dt));
        break;
      }
    }
  }

  /* ==========================================================================
     左键爆发：超新星
     ========================================================================== */
  _explodeSupernova(s, cx, cy, ct) {
    const p01 = Math.min(ct / CONFIG.CHARGE_TIME, 1);
    const power = Math.pow(p01, 1.6);

    const baseSpd = CONFIG.SUPERNOVA.BASE_SPEED + CONFIG.SUPERNOVA.GAIN_SPEED * power;

    for (let i = 0; i < MAXP; i++) {
      const p = s.pool[i];
      if (!p.active || p.type !== T_ORBIT) continue;
      if (p.mode === 2) continue;
      const dx = p.x - cx, dy = p.y - cy;
      let d = Math.hypot(dx, dy);
      if (d < 1) { d = 1; }
      const nx = dx / d, ny = dy / d;
      const spd = baseSpd * rand(0.45, 1.15);
      const rt = clamp(d / 240, 0, 1);
      p.type = T_DUST;
      p.cohesive = 0;
      p.vx = nx * spd + rand(-40, 40);
      p.vy = ny * spd + rand(-40, 40);
      p.life = p.maxLife = rand(1.1, 2.3);
      p.drag = 0.14;
      p.size = rand(1.0, 2.4);
      p.col = gradCol(SN_STOPS, rt);
      p.alpha = 1;
      p.sling = null;
    }

    const total = Math.round(CONFIG.SUPERNOVA.BASE_DUST + CONFIG.SUPERNOVA.GAIN_DUST * power);
    for (let i = 0; i < total; i++) {
      const p = this._spawnP(s);
      const ang = Math.random() * TAU;
      const el = Math.acos(rand(-1, 1)) - Math.PI / 2;
      const spd = baseSpd * rand(0.35, 1.25);
      p.type = T_DUST;
      p.x = cx; p.y = cy;
      p.vx = Math.cos(ang) * Math.cos(el) * spd;
      p.vy = Math.sin(ang) * Math.cos(el) * spd * 0.85 + Math.sin(el) * spd * 0.4;
      p.life = p.maxLife = rand(1.0, 2.4);
      p.size = rand(0.8, 2.2);
      p.drag = 0.16;
      p.col = gradCol(SN_STOPS, Math.random());
      p.alpha = rand(0.6, 1);
    }

    const shellMax = CONFIG.SUPERNOVA.SHELL_BASE + CONFIG.SUPERNOVA.SHELL_GAIN * power;
    const shell = this._spawnP(s);
    shell.type = T_SHELL;
    shell.x = cx; shell.y = cy;
    shell.cx = cx; shell.cy = cy;
    shell.a = 12;
    shell.decay = (shellMax - 12) / 0.95;
    shell.life = shell.maxLife = 1.0;
    shell.flat = 1;
    shell.col = C.white;
    shell.alpha = 1;
    shell.size = shellMax;

    const jlen = CONFIG.SUPERNOVA.JET_LEN_BASE + CONFIG.SUPERNOVA.JET_LEN_GAIN * power;
    const jspd = CONFIG.SUPERNOVA.JET_SPD_BASE + CONFIG.SUPERNOVA.JET_SPD_GAIN * power;
    const jn = Math.round(28 + 42 * power);
    for (let sgn = -1; sgn <= 1; sgn += 2) {
      for (let i = 0; i < jn; i++) {
        const p = this._spawnP(s);
        p.type = T_JET;
        p.cx = cx; p.cy = cy;
        p.x = cx + rand(-4, 4);
        p.y = cy + rand(-4, 4);
        p.vx = rand(-90, 90);
        p.vy = sgn * jspd * rand(0.75, 1.2);
        p.life = p.maxLife = (jlen / jspd) * rand(0.85, 1.2);
        p.size = rand(10, 26);
        p.extra = rand(0, TAU);
        const r = Math.random();
        p.col = r < 0.35 ? C.white : (r < 0.7 ? C.cyanW : C.blue);
        p.alpha = rand(0.6, 1);
      }
    }

    const nb = Math.round(8 + 8 * power);
    for (let i = 0; i < nb; i++) {
      const p = this._spawnP(s);
      const ang = Math.random() * TAU;
      p.type = T_NEBULA;
      p.x = cx + Math.cos(ang) * rand(0, 40);
      p.y = cy + Math.sin(ang) * rand(0, 40);
      p.vx = Math.cos(ang) * rand(15, 70);
      p.vy = Math.sin(ang) * rand(15, 70);
      p.a = rand(60, 110);
      p.decay = rand(35, 80);
      p.life = p.maxLife = rand(1.6, 2.4);
      p.size = rand(60, 160);
      p.alpha = rand(0.03, 0.06);
      p.col = Math.random() < 0.5 ? C.violet : C.orange;
    }

    for (let i = 0; i < MAXP; i++) {
      const p = s.pool[i];
      if (!p.active || p.type !== T_DUST || p.sling) continue;
      const dx = p.x - cx, dy = p.y - cy;
      let d = Math.hypot(dx, dy);
      if (d < 1) d = 1;
      p.vx = p.vx * 1.55 + (dx / d) * 180;
      p.vy = p.vy * 1.55 + (dy / d) * 180;
      p.flash = 0.25;
    }

    s.pulsar = { x: cx, y: cy, t: 1.5, life: 1.5 };

    for (let i = 0; i < 3; i++) {
      const p = this._spawnP(s);
      p.type = T_ARC;
      p.cx = cx; p.cy = cy;
      p.a = rand(40, 90);
      p.ang0 = -Math.PI * 0.5;
      p.ang1 = Math.PI * 0.5;
      p.flat = rand(2.0, 3.2);
      p.life = p.maxLife = 0.35;
      p.size = rand(1.2, 2.4);
      p.col = C.cyanW;
      p.alpha = 0.4;
    }
  }

  /* ==========================================================================
     右键爆发：盘状离心释放
     ========================================================================== */
  _explodePlanet(s, cx, cy, ct) {
    const p01 = Math.min(ct / CONFIG.CHARGE_TIME, 1);
    const power = Math.pow(p01, 1.6);

    for (let i = 0; i < MAXP; i++) {
      const p = s.pool[i];
      if (!p.active || p.type !== T_ORBIT) continue;
      if (p.mode === 2) continue;

      const st = Math.sin(p.theta);
      const ctv = Math.cos(p.theta);
      let tx = -st;
      let ty = ctv * p.flat;
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl; ty /= tl;

      const spd = p.a * Math.abs(p.omega) * (2.0 + 2.0 * power);
      p.type = T_DUST;
      p.cohesive = 0;
      p.vx = tx * spd + rand(-25, 25);
      p.vy = ty * spd + rand(-25, 25);

      const sw = rand(0.08, 0.26);
      const nx2 = p.vx - p.vy * sw;
      const ny2 = p.vy + p.vx * sw;
      p.vx = nx2; p.vy = ny2;

      if (Math.random() < 0.10) {
        p.vx += rand(-110, 110);
        p.vy += rand(-110, 110);
      }
      p.life = p.maxLife = rand(1.5, 2.6);
      p.drag = 0.12;
      p.size = rand(0.9, 2.0);
      p.alpha = rand(0.6, 1);
    }

    const fragN = Math.round(CONFIG.RINGBURST.BASE_FRAG + CONFIG.RINGBURST.GAIN_FRAG * power);
    for (let i = 0; i < fragN; i++) {
      const p = this._spawnP(s);
      const ang = Math.random() * TAU;
      const spd = rand(90, 300) * (0.6 + power);
      p.type = T_FRAG;
      p.x = cx + Math.cos(ang) * rand(0, 10);
      p.y = cy + Math.sin(ang) * rand(0, 10);

      if (Math.random() < 0.20) {
        p.mode = 1;
        p.cx = cx; p.cy = cy;
        p.a = rand(40, 150);
        p.flat = CONFIG.ORBIT_FLAT;
        p.theta = Math.atan2(p.y - cy, (p.x - cx) / p.flat);
        p.dir = Math.random() < 0.5 ? 1 : -1;
        p.omega = orbitOmega(p.a, p.dir) * 1.2;
        p.extra = rand(0.6, 1.2);
        p.life = p.maxLife = 3.2;
        orbitPlace(p);
        p.vx = Math.cos(ang) * 120;
        p.vy = Math.sin(ang) * 120;
      } else {
        p.mode = 0;
        p.vx = Math.cos(ang) * spd;
        p.vy = Math.sin(ang) * spd * 0.55;
        p.life = p.maxLife = rand(1.2, 2.2);
      }
      p.size = rand(2.5, 8);
      p.rot = Math.random() * TAU;
      p.rotV = rand(-9, 9);
      p.alpha = 1;
      p.drag = 0.13;
      const n = 6;
      for (let k = 0; k < n; k++) {
        const aa = (k / n) * TAU + rand(-0.25, 0.25);
        const rr = p.size * rand(0.6, 1.1);
        p.pts[k * 2] = Math.cos(aa) * rr;
        p.pts[k * 2 + 1] = Math.sin(aa) * rr;
      }
      const r = Math.random();
      p.col = r < 0.35 ? C.sandy : (r < 0.65 ? C.ochre : (r < 0.85 ? C.brown : C.darkRed));
    }

    const shellMax = CONFIG.RINGBURST.SHELL_BASE + CONFIG.RINGBURST.SHELL_GAIN * power;
    const shell = this._spawnP(s);
    shell.type = T_SHELL;
    shell.x = cx; shell.y = cy;
    shell.cx = cx; shell.cy = cy;
    shell.a = 14;
    shell.decay = (shellMax - 14) / 1.05;
    shell.life = shell.maxLife = 1.1;
    shell.flat = 0.42;
    shell.col = C.paleCyan;
    shell.alpha = 0.95;
    shell.size = shellMax;

    for (let i = 0; i < 3; i++) {
      const p = this._spawnP(s);
      p.type = T_ARC;
      p.cx = cx; p.cy = cy;
      p.a = 20 + i * 12;
      p.ang0 = 0;
      p.ang1 = TAU;
      p.flat = 0.42;
      p.life = p.maxLife = 0.9 + i * 0.15;
      p.size = 1.4;
      p.col = C.paleCyan;
      p.alpha = 0.22 - i * 0.05;
      p.decay = 180 + i * 40;
    }

    for (let i = 0; i < 9; i++) {
      const p = this._spawnP(s);
      const ang = Math.random() * TAU;
      p.type = T_NEBULA;
      p.x = cx + Math.cos(ang) * rand(0, 60);
      p.y = cy + Math.sin(ang) * rand(0, 60) * 0.42;
      p.vx = Math.cos(ang) * rand(20, 80);
      p.vy = Math.sin(ang) * rand(10, 40);
      p.a = rand(60, 120);
      p.decay = rand(30, 70);
      p.life = p.maxLife = rand(1.8, 2.4);
      p.size = rand(60, 150);
      p.alpha = rand(0.02, 0.05);
      p.col = Math.random() < 0.5 ? C.paleCyan : C.paleGold;
    }
  }

  /* ==========================================================================
     输入（按键）—— 鼠标速度由基类算好，这里只处理左右键的蓄力
     ========================================================================== */
  onPointerDown(e) {
    const s = this.state;
    if (!s) return;
    if (e.button !== 0 && e.button !== 2) return;

    // 原型在 mousedown 里先把光标位置对齐到事件坐标，再开始蓄力
    const M = s.input;
    M.x = e.clientX;
    M.y = e.clientY;
    M.lx = M.x;
    M.ly = M.y;

    if (s.down) return;
    s.down = true;
    s.button = e.button;
    this._startCharge(s, e.button);
  }

  onPointerUp(e) {
    const s = this.state;
    if (!s) return;
    if (!s.down || e.button !== s.button) return;

    const wasButton = s.button;
    s.down = false;
    s.button = -1;
    this._endCharge(s, wasButton, e.clientX, e.clientY);
  }

  // 失焦时按键状态已丢失：原型在 blur 里取消蓄力、清空按键并丢弃待释放事件
  onBlur() {
    const s = this.state;
    if (!s) return;
    s.charge.active = false;
    s.down = false;
    s.button = -1;
    s.pendingRelease = null;
  }

  /* ==========================================================================
     尺寸 —— 只同步动效自己的 W / H，画布尺寸与 DPR 由基类维护
     ========================================================================== */
  onResize(width, height) {
    const s = this.state;
    if (!s) return;
    s.W = width;
    s.H = height;
  }

  /* ==========================================================================
     每帧更新
     ========================================================================== */
  update(dt, s) {
    if (!s) return;

    s.elapsed += dt;

    this._updateTrailSpawn(s, dt);
    this._updateCharge(s, dt);

    /* 统一处理释放：快速点击立即触发脉冲，蓄力释放先内爆再爆发 */
    const pr = s.pendingRelease;
    if (pr) {
      pr.t -= dt;
      if (pr.t <= 0) {
        s.pendingRelease = null;
        if (pr.quick) {
          this._doClickPulse(s, pr.x, pr.y, pr.btn);
        } else if (pr.btn === 0) {
          this._explodeSupernova(s, pr.x, pr.y, pr.ct);
        } else {
          this._explodePlanet(s, pr.x, pr.y, pr.ct);
        }
      }
    }

    this._buildGrid(s);

    for (let i = 0; i < MAXP; i++) {
      const p = s.pool[i];
      if (!p.active) continue;
      this._updateParticle(s, p, dt);
    }

    this._applyCohesion(s, dt);

    if (s.pulsar) {
      s.pulsar.t -= dt;
      if (s.pulsar.t <= 0) s.pulsar = null;
    }
  }

  /* ==========================================================================
     渲染
     ========================================================================== */
  render(s) {
    if (!s) return;
    const ctx = s.ctx;

    // 画布缓冲与 DPR 缩放由基类维护，这里统一使用 CSS 像素坐标。
    // 只清屏不铺底：本组件是光标层，绝不覆盖宿主页面。
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, s.W, s.H);
    ctx.globalCompositeOperation = 'lighter';

    for (let i = 0; i < MAXP; i++) {
      const p = s.pool[i];
      if (!p.active) continue;
      const lifeR = p.life < 0.5 ? p.life / 0.5 : 1;

      if (p.type === T_ORBIT) {
        if (p.depth > 0) continue;
        drawOrbitParticle(ctx, p, lifeR, s.accNorm);
        continue;
      }
      switch (p.type) {
        case T_DUST:     drawDust(ctx, p, lifeR); break;
        case T_JET:      drawJet(ctx, p, lifeR); break;
        case T_NEBULA:   drawNebula(ctx, p, lifeR); break;
        case T_FRAG:     drawFrag(ctx, p, lifeR); break;
        case T_SHELL:    drawShell(ctx, p, lifeR); break;
        case T_ARC:      drawArc(ctx, p, lifeR); break;
        case T_RINGWAVE: drawRingWave(ctx, p, lifeR); break;
      }
    }

    ctx.globalAlpha = 1;
    /* 内爆视觉效果只用于蓄力释放（quick=false） */
    const pr = s.pendingRelease;
    const ch = s.charge;
    if (pr && !pr.quick) {
      if (pr.btn === 0) {
        // 内爆一瞬：collapse 参数对应原型的 collapseBoost 标志
        drawProtoStar(ctx, s, pr.x, pr.y, pr.ct, 1);
      } else {
        const p01 = Math.min(pr.ct / CONFIG.CHARGE_TIME, 1);
        const R = 6 + (CONFIG.PLANET.MAX_R - 6) * p01;
        const g = ctx.createRadialGradient(pr.x, pr.y, 0, pr.x, pr.y, R * 3.2);
        g.addColorStop(0, 'rgba(255,255,255,0.95)');
        g.addColorStop(0.35, 'rgba(107,232,255,0.7)');
        g.addColorStop(1, 'rgba(107,232,255,0)');
        ctx.globalAlpha = 1;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(pr.x, pr.y, R * 3.2, 0, TAU);
        ctx.fill();
      }
    } else if (ch.active) {
      if (ch.button === 0) {
        let sx = 0, sy = 0;
        const p01 = Math.min(ch.t / CONFIG.CHARGE_TIME, 1);
        if (p01 > 0.55) {
          const amp = (p01 - 0.55) / 0.45 * 3;
          sx = Math.sin(s.elapsed * 91) * amp;
          sy = Math.cos(s.elapsed * 77) * amp;
        }
        drawProtoStar(ctx, s, ch.x + sx, ch.y + sy, ch.t, 0);
      } else {
        const p01 = Math.min(ch.t / CONFIG.CHARGE_TIME, 1);
        let sx = 0, sy = 0;
        if (p01 > 0.55) {
          const amp = (p01 - 0.55) / 0.45 * 3;
          sx = Math.sin(s.elapsed * 83) * amp;
          sy = Math.cos(s.elapsed * 71) * amp * 0.6;
        }
        drawPlanetBody(ctx, s, ch.x + sx, ch.y + sy, p01);
      }
    }

    if (s.pulsar) drawPulsar(ctx, s);

    for (let i = 0; i < MAXP; i++) {
      const p = s.pool[i];
      if (!p.active || p.type !== T_ORBIT) continue;
      if (p.depth <= 0) continue;
      const lifeR = p.life < 0.5 ? p.life / 0.5 : 1;
      drawOrbitParticle(ctx, p, lifeR, s.accNorm);
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}

if (!customElements.get('cursor-planet')) {
  customElements.define('cursor-planet', CursorPlanet);
}

export default CursorPlanet;
