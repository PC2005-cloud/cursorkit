/**
 * cursor-moon —— 鼠标光标月亮动效（左键月相蓄力 / 右键环形山蓄力）。
 *
 * 由 html/月亮.html 原型移植：算法流程、数值、视觉表现与原文件一一对应。
 * 作为光标层组件，原型页面自身的行为已剔除：
 *   - 原型 body 的深色底 #06060c 是页面 CSS 背景，绘制里本来就只有 clearRect，
 *     没有任何整屏铺底，因此 render() 保持 clearRect，绝不覆盖宿主页面；
 *   - 不拦截 contextmenu，宿主页面的右键菜单不受影响（基类统一处理）；
 *   - 画布创建、DPR 适配、尺寸同步、监听注册、rAF 循环、鼠标速度平滑
 *     以及「>300px 跳变归零 / 6000 封顶」全部由基类负责。
 *
 * 原型监听 mousemove / mousedown / mouseup，因此声明 inputFamily = 'mouse'。
 * 所有运行状态都放在 setup() 返回的 state 上，多实例互不干扰。
 */

import { CursorEffectElement } from '../core/base.js';
import { TAU, clamp, rand, randInt } from '../core/utils.js';

/* ==================================================================
   CONFIG —— 全部可调参数集中于此
   ================================================================== */
const CONFIG = {
  /* ---- 左键月相配色（银蓝冷光组）---- */
  phasePalette: {
    lit:        '#E8E8F0',      // 月面亮部（银白）
    dark:       '#2A2A3A',      // 月面暗部（深灰蓝）
    texture:    '#B0B0C0',      // 月面纹理（中灰）
    edge:       '#F0F0FF',      // 月面边缘（亮银边）
    glowRGB:    '240,240,255',  // 反射光晕（银白）
    mare:       '#505060',      // 月海（暗灰蓝）
    rim:        '#707080',      // 环形山轮廓（中灰）
    inner:      '#404050',      // 环形山内部（暗灰）
    shadow:     '26,26,42',     // 阴影核心（极深灰蓝）
    earthshine: '168,184,208'   // 地球反照（淡青）
  },
  /* ---- 右键环形山配色（月尘灰白组）---- */
  craterPalette: {
    lit:        '#D0D0D8',      // 月面亮部（灰白）
    dark:       '#3A3A48',      // 月面暗部（深灰）
    texture:    '#A8A8B4',      // 月面纹理
    edge:       '#F0F0FF',      // 月面边缘
    glowRGB:    '230,232,245',  // 光晕
    mare:       '#4A4A58',      // 月海
    rim:        '#A0A0B0',      // 环形山边缘（浅灰）
    inner:      '#2A2A38',      // 环形山内部（深灰）
    shadow:     '30,30,42',     // 阴影核心
    earthshine: '168,184,208',
    flash:      '#FFFFFF',      // 撞击闪光（炽白）
    ray:        '#F0F0FF',      // 辐射纹（亮银白）
    dust:       '#C0C0C8',      // 月尘（浅灰）
    dustSettle: '#909098',      // 月尘沉降（中灰）
    ejecta:     '#E8E8F0'       // 喷溅碎片（银白）
  },
  /* ---- 月亮几何 ---- */
  moon: {
    phaseR0: 20,        // 左键月亮初始半径
    phaseR1: 150,       // 左键月亮蓄满半径
    craterR: 40,        // 右键月亮固定半径
    pulseHz: 0.5,       // 呼吸脉动频率（Hz）
    pulseAmp: 0.02,     // 呼吸脉动幅度
    mareCount: [3, 8],  // 月海数量范围
    mareDrift: 0.03,    // 月海漂移角速度（rad/s）—— 模拟自转
    mareBaseR: [0.12, 0.32], // 月海半径（相对月亮半径）
    ringLift: 1.45,     // 光晕半径倍率
    ringAlphaMin: 0.05, // 光晕最小透明度
    ringAlphaMax: 0.35, // 光晕最大透明度
    shadowSoft: 0.22,   // 月相阴影柔和过渡宽度（相对半径）
    earthshineA: 0.14   // 地球反照最大透明度
  },
  /* ---- 蓄力 ---- */
  charge: {
    max: 2.5,           // 蓄力时长阈值（秒）
    clickThresh: 0.12,  // 低于此值视为普通单击
    jitterStart: 0.55,  // 微震起始进度
    jitterAmp: 2.2,     // 微震最大幅度（px）
    burstPow: 1.6       // 爆发 power 指数
  },
  /* ---- 拖尾月尘 ---- */
  trail: {
    gravity: 15,        // 微重力（px/s²）
    lifeMin: 1.5, lifeMax: 2.5,
    rMin: 0.5, rMax: 2,
    velScale: 0.3,      // 鼠标速度传递系数
    jitter: 45,         // 随机抖动
    stepPx: 6           // 每多少像素生成一个粒子
  },
  /* ---- 环形山系统 ---- */
  crater: {
    maxPool: 80,        // 环形山对象池上限
    rateStart: 0.30,    // 陨石初始间隔（秒）
    rateEnd: 0.10,      // 陨石蓄满间隔（秒）
    sizeMin: 2, sizeMax: 20, // 环形山半径（px）
    bigThresh: 8,       // 大环形山阈值（px）
    peakChance: 0.75    // 大环形山出现中央峰概率
  },
  /* ---- 陨石 ---- */
  meteor: {
    spawnDist: [150, 300], // 生成距离月亮表面距离
    speed: [400, 800],     // 飞行速度
    size: [2, 4],          // 基础半径
    bigBonus: 11           // 蓄满额外增大
  },
  /* ---- 辐射纹系统 ---- */
  ray: {
    count: [4, 8],         // 每次撞击辐射纹条数
    len: [20, 80],         // 长度范围
    fade: 0.8,             // 淡出时长
    imprintAlpha: 0.05,    // 永久留痕 alpha
    burstCount: 20,        // 爆发基础条数
    burstBonus: 50,        // 爆发附加条数
    burstLen: [100, 300]   // 爆发长度
  },
  /* ---- 月尘系统 ---- */
  dust: {
    hitCount: [20, 40],    // 每次撞击扬起数量
    hitSpeed: [50, 200],   // 撞击月尘速度
    hitGravity: 15,        // 撞击月尘微重力
    puffMax: 120,          // 月尘团对象池上限
    puffLife: [0.8, 1.6]
  },
  /* ---- 粒子池 ---- */
  particleMax: 2000,
  /* ---- 月光照射（点击冲击）---- */
  cast: {
    angle: 60 * Math.PI / 180, // 扇形总角度
    length: 250,               // 扇形长度
    duration: 0.5,             // 被照亮持续
    nearRadius: 60             // 光标近场无条件照亮半径
  }
};

/* ==================================================================
   基础工具
   ================================================================== */
function hexToRgba(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h, 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

/* ==================================================================
   离屏纹理预渲染 —— 粒子精灵，避免逐帧创建渐变
   ================================================================== */
// 原型用全局 document 创建离屏画布（原第 178、201 行）。
// 移植后改用元素自身的 ownerDocument 创建：不触碰任何全局对象，
// 每个实例各自持有一份，且绝不挂进 DOM。
// 这里的 c.width / c.height / getContext 只作用于离屏贴图画布，与主画布无关。
function makeSprite(doc, size, ox, oy) {
  const c = doc.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const cx = size * 0.5, cy = size * 0.5, R = size * 0.5;

  const gr = g.createRadialGradient(cx, cy, 0, cx, cy, R);
  gr.addColorStop(0, 'rgba(235,238,255,0.92)');
  gr.addColorStop(0.35, 'rgba(200,205,230,0.42)');
  gr.addColorStop(1, 'rgba(150,155,185,0)');
  g.fillStyle = gr;
  g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.fill();

  const hx = cx + ox * R, hy = cy + oy * R, hr = R * 0.55;
  const hg = g.createRadialGradient(hx, hy, 0, hx, hy, hr);
  hg.addColorStop(0, 'rgba(255,255,255,1)');
  hg.addColorStop(0.5, 'rgba(255,255,255,0.45)');
  hg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = hg;
  g.beginPath(); g.arc(hx, hy, hr, 0, TAU); g.fill();
  return c;
}

function makeMeteorSprite(doc, size) {
  const c = doc.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const cx = size * 0.5, cy = size * 0.5, R = size * 0.5;
  const gr = g.createRadialGradient(cx, cy, 0, cx, cy, R);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.22, 'rgba(255,232,176,1)');
  gr.addColorStop(0.55, 'rgba(255,180,80,0.45)');
  gr.addColorStop(1, 'rgba(255,140,40,0)');
  g.fillStyle = gr;
  g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.fill();
  return c;
}

function buildSprites(doc) {
  return {
    dust:    makeSprite(doc, 32, -0.16, -0.10),
    dustLit: makeSprite(doc, 32, -0.28, -0.16),
    glow:    makeSprite(doc, 32, 0, 0),
    meteor:  makeMeteorSprite(doc, 32)
  };
}

/* ==================================================================
   粒子池 —— 上限 2000
   ================================================================== */
const MAX_PARTICLES = CONFIG.particleMax;

function newParticle() {
  return {
    active: false,
    kind: 'dust',
    x: 0, y: 0, vx: 0, vy: 0,
    r: 1, life: 0, maxLife: 1,
    gravity: 0, drag: 0,
    lit: 0,
    rot: 0, spin: 0,
    ang: 0, dist: 0, speed: 0, maxDist: 0,
    tx: 0, ty: 0, flight: 0,
    tail: 0, grow: 0,
    color: null
  };
}

function resetParticle(p) {
  p.kind = 'dust';
  p.vx = 0; p.vy = 0;
  p.r = 1; p.life = 0; p.maxLife = 1;
  p.gravity = 0; p.drag = 0;
  p.lit = 0;
  p.rot = 0; p.spin = 0;
  p.ang = 0; p.dist = 0; p.speed = 0; p.maxDist = 0;
  p.flight = 0;
  p.tail = 0; p.grow = 0;
  p.color = null;
}

function spawnParticle(s) {
  const particles = s.particles;
  for (let i = 0; i < MAX_PARTICLES; i++) {
    const idx = (s.pCursor + i) % MAX_PARTICLES;
    const p = particles[idx];
    if (!p.active) {
      resetParticle(p);
      p.active = true;
      s.pCursor = (idx + 1) % MAX_PARTICLES;
      return p;
    }
  }
  return null;
}

/* ==================================================================
   环形山对象池 —— 上限 80
   ================================================================== */
function acquireCrater(s) {
  const craterPool = s.craterPool;
  for (let i = 0; i < craterPool.length; i++) {
    if (!craterPool[i].inUse) {
      craterPool[i].inUse = true;
      return craterPool[i];
    }
  }
  return null;
}
function releaseCrater(c) { c.inUse = false; }

/* ==================================================================
   月尘团对象池 —— 上限 120
   ================================================================== */
function spawnPuff(s, x, y, vx, vy, r, life, alpha) {
  const puffPool = s.puffPool;
  for (let i = 0; i < puffPool.length; i++) {
    const p = puffPool[i];
    if (!p.active) {
      p.active = true;
      p.x = x; p.y = y; p.vx = vx; p.vy = vy;
      p.r = r; p.life = life; p.maxLife = life; p.alpha = alpha;
      return p;
    }
  }
  return null;
}

/* ==================================================================
   调度器 —— 爆发序列的延时动作
   ================================================================== */
function schedule(s, delay, fn) { s.scheduled.push({ t: delay, fn: fn }); }
function updateScheduler(s, dt) {
  const scheduled = s.scheduled;
  for (let i = scheduled.length - 1; i >= 0; i--) {
    scheduled[i].t -= dt;
    if (scheduled[i].t <= 0) {
      const fn = scheduled[i].fn;
      scheduled.splice(i, 1);
      fn();
    }
  }
}

/* ==================================================================
   月亮状态
   ================================================================== */
function newMoon() {
  return {
    active: false,
    mode: 'phase',
    x: 0, y: 0,
    dx: 0, dy: 0,
    r: 20,
    phase: 0,
    charge: 0,
    birth: 0,
    pulse: 0,
    shake: 0,
    exposure: 0,
    spin: 0,
    mares: [],
    craters: [],
    rays: [],
    meteorTimer: 0,
    dustAcc: 0,
    dying: false,
    dieT: 0,
    dieDur: 0.35
  };
}

function killMoon(s) {
  const moon = s.moon;
  for (let i = 0; i < moon.craters.length; i++) releaseCrater(moon.craters[i]);
  moon.craters.length = 0;
  moon.rays.length = 0;
  moon.mares.length = 0;
  moon.active = false;
  moon.dying = false;
  moon.exposure = 0;
}

/* ---- 月海生成 ---- */
function generateMares(s, count) {
  const moon = s.moon;
  moon.mares.length = 0;
  for (let i = 0; i < count; i++) {
    const a = Math.random() * TAU;
    const d = Math.sqrt(Math.random()) * 0.55;
    const cx = Math.cos(a) * d;
    const cy = Math.sin(a) * d;
    const size = rand(CONFIG.moon.mareBaseR[0], CONFIG.moon.mareBaseR[1]);
    const n = randInt(6, 9);
    const pts = [];
    for (let j = 0; j < n; j++) {
      const aa = (j / n) * TAU + rand(-0.35, 0.35);
      const rr = size * rand(0.55, 1.05);
      pts.push([Math.cos(aa) * rr, Math.sin(aa) * rr]);
    }
    moon.mares.push({ x: cx, y: cy, pts: pts, alpha: rand(0.55, 0.92) });
  }
}

/* ---- 环形山生成 ---- */
function inMare(s, lx, ly) {
  const mares = s.moon.mares;
  for (let i = 0; i < mares.length; i++) {
    const m = mares[i];
    if (Math.hypot(lx - m.x, ly - m.y) < 0.16) return true;
  }
  return false;
}

function addCraterRandom(s, minR, maxR) {
  const c = acquireCrater(s);
  if (!c) return null;
  let lx = 0, ly = 0;
  for (let k = 0; k < 8; k++) {
    const a = Math.random() * TAU;
    const d = Math.sqrt(Math.random()) * 0.82;
    lx = Math.cos(a) * d;
    ly = Math.sin(a) * d;
    if (!inMare(s, lx, ly)) break;
  }
  c.x = lx; c.y = ly;
  c.r = rand(minR, maxR);
  c.big = c.r > 0.16;
  c.peak = c.big && Math.random() < CONFIG.crater.peakChance;
  s.moon.craters.push(c);
  return c;
}

/* ---- 创建月亮 ---- */
function createMoon(s, x, y, mode) {
  const moon = s.moon;
  killMoon(s);
  moon.active = true;
  moon.mode = mode;
  moon.x = x; moon.y = y;
  moon.dx = 0; moon.dy = 0;
  moon.charge = 0;
  moon.birth = 0;
  moon.pulse = 0;
  moon.shake = 0;
  moon.exposure = 0;
  moon.spin = 0;
  moon.meteorTimer = 0.1;
  moon.dustAcc = 0;
  moon.dying = false;
  moon.dieT = 0;

  if (mode === 'phase') {
    moon.r = CONFIG.moon.phaseR0;
    moon.phase = 0;
    generateMares(s, randInt(CONFIG.moon.mareCount[0], CONFIG.moon.mareCount[1]));
    for (let i = 0; i < 16; i++) addCraterRandom(s, 0.05, 0.14);
  } else {
    moon.r = CONFIG.moon.craterR;
    moon.phase = Math.PI;
    generateMares(s, randInt(3, 5));
    for (let i = 0; i < 6; i++) addCraterRandom(s, 0.04, 0.16);
  }
}

/* ==================================================================
   月亮本体绘制 —— 实心天体：本体 + 月海 + 环形山 + 边缘 + 光晕
   ================================================================== */
function drawMoonBody(ctx, cx, cy, r, phase, pal, opts) {
  opts = opts || {};
  const mares   = opts.mares   || [];
  const craters = opts.craters || [];
  const rays    = opts.rays    || [];
  const spin    = opts.spin    || 0;
  const alpha   = opts.alpha != null ? opts.alpha : 1;
  const exposure= opts.exposure || 0;
  const glowMul = opts.glowMul != null ? opts.glowMul : 1;
  const phaseNorm = clamp(phase / Math.PI, 0, 1);

  if (alpha <= 0.001) return;

  ctx.save();
  ctx.globalAlpha = alpha;

  /* ---- 结构 4：光晕（反射光晕）---- */
  const glowA = (CONFIG.moon.ringAlphaMin +
    (CONFIG.moon.ringAlphaMax - CONFIG.moon.ringAlphaMin) * phaseNorm) * glowMul;
  const gr = r * CONFIG.moon.ringLift;
  const gg = ctx.createRadialGradient(cx, cy, r * 0.55, cx, cy, gr);
  gg.addColorStop(0, 'rgba(' + pal.glowRGB + ',' + glowA.toFixed(3) + ')');
  gg.addColorStop(0.45, 'rgba(' + pal.glowRGB + ',' + (glowA * 0.42).toFixed(3) + ')');
  gg.addColorStop(1, 'rgba(' + pal.glowRGB + ',0)');
  ctx.fillStyle = gg;
  ctx.beginPath();
  ctx.arc(cx, cy, gr, 0, TAU);
  ctx.fill();

  /* ---- 裁剪到月面圆内 ---- */
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.clip();

  /* ---- 结构 1：月面本体（径向渐变，受光面在右侧）---- */
  ctx.fillStyle = pal.dark;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

  const lg = ctx.createRadialGradient(cx + r * 0.5, cy - r * 0.1, r * 0.05, cx + r * 0.5, cy, r * 1.75);
  lg.addColorStop(0, hexToRgba(pal.lit, 1));
  lg.addColorStop(0.32, hexToRgba(pal.texture, 0.95));
  lg.addColorStop(0.66, hexToRgba(pal.texture, 0.42));
  lg.addColorStop(1, hexToRgba(pal.dark, 0));
  ctx.fillStyle = lg;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

  /* ---- 结构 2：月海（暗色不规则多边形，随相位可见度变化）---- */
  const mareVis = 0.35 + 0.65 * phaseNorm;
  if (mares.length) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(spin);
    for (let i = 0; i < mares.length; i++) {
      const m = mares[i];
      const px = m.x * r, py = m.y * r;
      ctx.beginPath();
      for (let j = 0; j < m.pts.length; j++) {
        const qx = px + m.pts[j][0] * r;
        const qy = py + m.pts[j][1] * r;
        if (j === 0) ctx.moveTo(qx, qy); else ctx.lineTo(qx, qy);
      }
      ctx.closePath();
      ctx.globalAlpha = alpha * m.alpha * mareVis;
      ctx.fillStyle = pal.mare;
      ctx.fill();
    }
    ctx.globalAlpha = alpha;
    ctx.restore();
  }

  /* ---- 结构 3：环形山（亮边缘 + 暗内部 + 中央峰）---- */
  const craterVis = 0.35 + 0.65 * phaseNorm;
  for (let i = 0; i < craters.length; i++) {
    const c = craters[i];
    const ccx = cx + c.x * r;
    const ccy = cy + c.y * r;
    const cr = Math.max(1, c.r * r);

    ctx.globalAlpha = alpha * craterVis;

    ctx.beginPath();
    ctx.arc(ccx, ccy, cr, 0, TAU);
    ctx.fillStyle = pal.inner;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(ccx, ccy, cr, 0, TAU);
    ctx.strokeStyle = pal.rim;
    ctx.lineWidth = Math.max(1, cr * 0.22);
    ctx.stroke();

    if (c.peak && cr > 4) {
      ctx.beginPath();
      ctx.arc(ccx, ccy, cr * 0.24, 0, TAU);
      ctx.fillStyle = pal.lit;
      ctx.globalAlpha = alpha * craterVis * 0.85;
      ctx.fill();
    }
  }
  ctx.globalAlpha = alpha;

  /* ---- 辐射纹永久印记 ---- */
  for (let i = 0; i < rays.length; i++) {
    const ry = rays[i];
    const ax = cx + ry.x * r;
    const ay = cy + ry.y * r;
    const ex = cx + (ry.x + Math.cos(ry.ang) * ry.len) * r;
    const ey = cy + (ry.y + Math.sin(ry.ang) * ry.len) * r;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ex, ey);
    ctx.strokeStyle = 'rgba(' + pal.glowRGB + ',' + (ry.alpha * mareVis).toFixed(3) + ')';
    ctx.lineWidth = Math.max(1, r * 0.012);
    ctx.stroke();
  }

  /* ---- 结构 5：月相阴影（柔和渐变边界，从右向左扫过）---- */
  const xb = r * Math.cos(phase);
  const soft = Math.max(3, r * CONFIG.moon.shadowSoft);
  const sg = ctx.createLinearGradient(cx + xb - soft, 0, cx + xb + soft, 0);
  sg.addColorStop(0, 'rgba(' + pal.shadow + ',1)');
  sg.addColorStop(0.55, 'rgba(' + pal.shadow + ',0.93)');
  sg.addColorStop(1, 'rgba(' + pal.shadow + ',0)');
  ctx.fillStyle = sg;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

  /* ---- 地球反照（暗部极微弱淡青光）---- */
  const esA = CONFIG.moon.earthshineA * (1 - phaseNorm * 0.55);
  const eg = ctx.createRadialGradient(cx - r * 0.55, cy + r * 0.1, 0, cx - r * 0.55, cy + r * 0.1, r * 1.55);
  eg.addColorStop(0, 'rgba(' + pal.earthshine + ',' + esA.toFixed(3) + ')');
  eg.addColorStop(0.6, 'rgba(' + pal.earthshine + ',' + (esA * 0.4).toFixed(3) + ')');
  eg.addColorStop(1, 'rgba(' + pal.earthshine + ',0)');
  ctx.fillStyle = eg;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

  /* ---- 月面边缘细亮边 ---- */
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(0.5, r - 0.5), 0, TAU);
  ctx.strokeStyle = hexToRgba(pal.edge, 0.2 + 0.42 * phaseNorm);
  ctx.lineWidth = 1;
  ctx.stroke();

  /* ---- 过曝 ---- */
  if (exposure > 0) {
    ctx.fillStyle = 'rgba(255,255,255,' + (exposure * 0.7).toFixed(3) + ')';
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }

  ctx.restore(); // 取消 clip
  ctx.restore(); // 取消 globalAlpha
}

/* ---- 绘制当前月亮 ---- */
function drawMoon(ctx, s) {
  const moon = s.moon;
  if (!moon.active) return;
  const pal = moon.mode === 'phase' ? CONFIG.phasePalette : CONFIG.craterPalette;

  // 弹出缩放
  const bt = Math.min(moon.birth / 0.2, 1);
  const be = 1 - Math.pow(1 - bt, 2);
  const birthScale = be * (1 + 0.15 * Math.sin(bt * Math.PI));

  // 呼吸脉动
  const pulseScale = 1 + CONFIG.moon.pulseAmp * Math.sin(moon.pulse * TAU * CONFIG.moon.pulseHz);

  // 溶解淡出
  let alpha = 1;
  if (moon.dying) alpha = clamp(1 - moon.dieT / moon.dieDur, 0, 1);

  const r = moon.r * birthScale * pulseScale;
  if (r < 0.5) return;

  const glowMul = moon.mode === 'crater'
    ? clamp(0.9 + moon.craters.length / 40, 1, 1.8)
    : 1;

  drawMoonBody(
    ctx,
    moon.x + moon.dx,
    moon.y + moon.dy,
    r,
    moon.phase,
    pal,
    {
      mares: moon.mares,
      craters: moon.craters,
      rays: moon.rays,
      spin: moon.spin,
      alpha: alpha,
      exposure: moon.exposure,
      glowMul: glowMul
    }
  );
}

/* ==================================================================
   单击脉冲月亮
   ================================================================== */
function spawnPulseMoon(s, x, y) {
  s.pulseMoons.push({
    x: x, y: y,
    r: 18,
    t: 0,
    dur: 0.6,
    phase: Math.PI
  });
}

function updatePulseMoons(s, dt) {
  const pulseMoons = s.pulseMoons;
  for (let i = pulseMoons.length - 1; i >= 0; i--) {
    const m = pulseMoons[i];
    m.t += dt;
    // 0.2s 内弹出（overshoot 到 1.15 再回弹）
    const bt = Math.min(m.t / 0.2, 1);
    m.scale = (1 - Math.pow(1 - bt, 2)) * (1 + 0.15 * Math.sin(bt * Math.PI));
    // 0.5s 内 phase 从 π（满月）到 π/2（下弦月）
    const pt = Math.min(m.t / 0.5, 1);
    m.phase = Math.PI - (Math.PI * 0.5) * pt;
    if (m.t >= m.dur) pulseMoons.splice(i, 1);
  }
}

function drawPulseMoons(ctx, s) {
  const pulseMoons = s.pulseMoons;
  for (let i = 0; i < pulseMoons.length; i++) {
    const m = pulseMoons[i];
    const a = clamp(1 - m.t / m.dur, 0, 1);
    drawMoonBody(ctx, m.x, m.y, m.r * m.scale, m.phase, CONFIG.phasePalette, {
      alpha: a,
      glowMul: 1
    });
  }
}

/* ==================================================================
   残影 / 光斑（爆发余韵）
   ================================================================== */
function spawnGhost(s, x, y, r0, r1, a0, life, rgb) {
  s.ghosts.push({ x: x, y: y, r: r0, r1: r1, a: a0, life: life, maxLife: life, rgb: rgb });
}
function updateGhosts(s, dt) {
  const ghosts = s.ghosts;
  for (let i = ghosts.length - 1; i >= 0; i--) {
    const g = ghosts[i];
    g.life -= dt;
    if (g.life <= 0) { ghosts.splice(i, 1); continue; }
    g.r = g.r + (g.r1 - g.r) * dt * 1.6;
  }
}
function drawGhosts(ctx, s) {
  const ghosts = s.ghosts;
  for (let i = 0; i < ghosts.length; i++) {
    const g = ghosts[i];
    const t = g.life / g.maxLife;
    const a = g.a * t;
    if (a <= 0.002) continue;
    const rg = ctx.createRadialGradient(g.x, g.y, 0, g.x, g.y, g.r);
    rg.addColorStop(0, 'rgba(' + g.rgb + ',' + a.toFixed(3) + ')');
    rg.addColorStop(0.55, 'rgba(' + g.rgb + ',' + (a * 0.45).toFixed(3) + ')');
    rg.addColorStop(1, 'rgba(' + g.rgb + ',0)');
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(g.x, g.y, g.r, 0, TAU);
    ctx.fill();
  }
}

/* ==================================================================
   月尘团更新与绘制
   ================================================================== */
function updatePuffs(s, dt) {
  const puffPool = s.puffPool;
  for (let i = 0; i < puffPool.length; i++) {
    const p = puffPool[i];
    if (!p.active) continue;
    p.life -= dt;
    if (p.life <= 0) { p.active = false; continue; }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 0.985;
    p.vy *= 0.985;
    p.vy += 6 * dt;
    p.r += dt * 6;
  }
}

function drawPuffs(ctx, s) {
  const puffPool = s.puffPool;
  for (let i = 0; i < puffPool.length; i++) {
    const p = puffPool[i];
    if (!p.active) continue;
    const t = p.life / p.maxLife;
    const a = p.alpha * t;
    if (a <= 0.003) continue;
    const rg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
    rg.addColorStop(0, 'rgba(200,202,218,' + a.toFixed(3) + ')');
    rg.addColorStop(0.5, 'rgba(170,172,190,' + (a * 0.4).toFixed(3) + ')');
    rg.addColorStop(1, 'rgba(150,152,170,0)');
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, TAU);
    ctx.fill();
  }
}

/* ==================================================================
   粒子生成辅助
   ================================================================== */

/* ---- 拖尾月尘 ---- */
function spawnTrailDust(s, x, y, vx, vy) {
  const p = spawnParticle(s);
  if (!p) return;
  const C = CONFIG.trail;
  p.kind = 'dust';
  p.x = x + rand(-3, 3);
  p.y = y + rand(-3, 3);
  p.vx = vx * C.velScale + rand(-C.jitter, C.jitter);
  p.vy = vy * C.velScale + rand(-C.jitter, C.jitter);
  p.r = rand(C.rMin, C.rMax);
  p.maxLife = rand(C.lifeMin, C.lifeMax);
  p.life = p.maxLife;
  p.gravity = C.gravity;
  p.drag = 0.7;
  p.lit = 0;
}

/* ---- 撞击月尘 ---- */
function spawnHitDust(s, x, y, baseAngle, speedMin, speedMax) {
  const p = spawnParticle(s);
  if (!p) return;
  const C = CONFIG.dust;
  const a = baseAngle + rand(-1.1, 1.1);
  const sp = rand(speedMin, speedMax);
  p.kind = 'dust';
  p.x = x; p.y = y;
  p.vx = Math.cos(a) * sp;
  p.vy = Math.sin(a) * sp;
  p.r = rand(0.5, 2);
  p.maxLife = rand(1.0, 2.0);
  p.life = p.maxLife;
  p.gravity = C.hitGravity;
  p.drag = 0.45;
  p.lit = 0;
}

/* ==================================================================
   月光照射 / Moonlight Cast —— 点击冲击（照亮而非推挤）
   ================================================================== */
function moonCast(s, cx, cy) {
  const C = CONFIG.cast;
  const half = C.angle * 0.5;

  for (let i = 0; i < MAX_PARTICLES; i++) {
    const p = s.particles[i];
    if (!p.active) continue;
    if (p.kind !== 'dust') continue;

    const dx = p.x - cx, dy = p.y - cy;
    const d = Math.hypot(dx, dy);
    if (d < 1) continue;

    let affected = false;
    if (d <= C.nearRadius) {
      affected = true;
    } else if (d <= C.length) {
      const a = Math.atan2(dy, dx);
      let da = a;
      while (da > Math.PI) da -= TAU;
      while (da < -Math.PI) da += TAU;
      if (Math.abs(da) <= half) affected = true;
    }
    if (!affected) continue;

    p.lit = C.duration + rand(0, 0.18);

    // 生成一道细光线（月光在照射）
    const rp = spawnParticle(s);
    if (rp) {
      rp.kind = 'rayline';
      rp.x = cx; rp.y = cy;
      rp.tx = p.x; rp.ty = p.y;
      rp.life = 0.3; rp.maxLife = 0.3;
    }
  }

  // 额外 8~12 条光线射向扇区内随机点
  const extra = randInt(8, 12);
  for (let i = 0; i < extra; i++) {
    const a = rand(-half, half);
    const len = rand(40, C.length);
    const rp = spawnParticle(s);
    if (!rp) break;
    rp.kind = 'rayline';
    rp.x = cx; rp.y = cy;
    rp.tx = cx + Math.cos(a) * len;
    rp.ty = cy + Math.sin(a) * len;
    rp.life = 0.3; rp.maxLife = 0.3;
  }
}

/* ==================================================================
   单击效果
   ================================================================== */
function doClickEffect(s, x, y) {
  // 小月亮弹出
  spawnPulseMoon(s, x, y);

  // 反射光斑（瞬间高光）
  spawnGhost(s, x, y, 10, 22, 0.55, 0.15, '240,240,255');

  // 月尘散射 8~14
  const n = randInt(8, 14);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU;
    const sp = rand(100, 300);
    const p = spawnParticle(s);
    if (!p) break;
    p.kind = 'dust';
    p.x = x; p.y = y;
    p.vx = Math.cos(a) * sp;
    p.vy = Math.sin(a) * sp;
    p.r = rand(0.5, 2);
    p.maxLife = rand(1.0, 1.8);
    p.life = p.maxLife;
    p.gravity = 15;
    p.drag = 0.6;
  }

  // 月晕环：12~18 个月尘粒子组成圆环
  const ringN = randInt(12, 18);
  for (let i = 0; i < ringN; i++) {
    const a = (i / ringN) * TAU;
    const p = spawnParticle(s);
    if (!p) break;
    p.kind = 'dust';
    p.x = x + Math.cos(a) * 5;
    p.y = y + Math.sin(a) * 5;
    p.vx = Math.cos(a) * 110;
    p.vy = Math.sin(a) * 110;
    p.r = rand(0.8, 1.8);
    p.maxLife = 0.5;
    p.life = 0.5;
    p.drag = 3.2;
    p.gravity = 0;
  }

  // 月光照射
  moonCast(s, x, y);

  spawnPuff(s, x, y, 0, 0, 12, 0.7, 0.16);
}

/* ==================================================================
   撞击事件
   ================================================================== */
function impact(s, x, y, size) {
  const moon = s.moon;
  const mx = moon.x + moon.dx;
  const my = moon.y + moon.dy;
  const mr = Math.max(1, moon.r);

  // 撞击闪光
  const f = spawnParticle(s);
  if (f) {
    f.kind = 'flash';
    f.x = x; f.y = y;
    f.r = 5;
    f.grow = 15 / 0.1;
    f.life = 0.1; f.maxLife = 0.1;
  }

  // 环形山生成（限制在月面内）
  const lx = (x - mx) / mr;
  const ly = (y - my) / mr;
  const ld = Math.hypot(lx, ly);
  if (ld < 0.86) {
    const c = acquireCrater(s);
    if (c) {
      c.x = lx; c.y = ly;
      c.r = clamp(size / mr, 0.03, 0.5);
      c.big = size >= CONFIG.crater.bigThresh;
      c.peak = c.big && Math.random() < CONFIG.crater.peakChance;
      moon.craters.push(c);
    }
  }

  // 辐射纹
  const rayN = randInt(CONFIG.ray.count[0], CONFIG.ray.count[1]);
  for (let i = 0; i < rayN; i++) {
    const a = Math.random() * TAU;
    const len = rand(CONFIG.ray.len[0], CONFIG.ray.len[1]);
    const rp = spawnParticle(s);
    if (!rp) break;
    rp.kind = 'ray';
    rp.x = x; rp.y = y;
    rp.ang = a;
    rp.len = len;
    rp.life = CONFIG.ray.fade;
    rp.maxLife = CONFIG.ray.fade;
  }

  // 辐射纹永久留痕
  if (moon.rays.length < 70) {
    for (let i = 0; i < rayN; i++) {
      const a = Math.random() * TAU;
      moon.rays.push({
        x: lx, y: ly,
        ang: a,
        len: rand(0.15, 0.5),
        alpha: CONFIG.ray.imprintAlpha
      });
    }
  }

  // 月尘
  const dustN = randInt(CONFIG.dust.hitCount[0], CONFIG.dust.hitCount[1]);
  const baseA = Math.random() * TAU;
  for (let i = 0; i < dustN; i++) {
    spawnHitDust(s, x, y, baseA, CONFIG.dust.hitSpeed[0], CONFIG.dust.hitSpeed[1]);
  }

  // 月亮震动
  moon.shake = 0.12;

  // 小月尘团
  spawnPuff(s, x, y, rand(-20, 20), rand(-20, 20), rand(8, 16), rand(0.6, 1.2), 0.16);
}

/* ==================================================================
   陨石
   ================================================================== */
function spawnMeteor(s, prog) {
  const moon = s.moon;
  const mx = moon.x + moon.dx;
  const my = moon.y + moon.dy;
  const r = Math.max(1, moon.r);

  // 目标点
  const ta = Math.random() * TAU;
  const td = Math.sqrt(Math.random()) * 0.78 * r;
  const tx = mx + Math.cos(ta) * td;
  const ty = my + Math.sin(ta) * td;

  // 起点
  const sa = Math.random() * TAU;
  const sd = r + rand(CONFIG.meteor.spawnDist[0], CONFIG.meteor.spawnDist[1]);
  const sx = mx + Math.cos(sa) * sd;
  const sy = my + Math.sin(sa) * sd;

  const dx = tx - sx, dy = ty - sy;
  const dist = Math.hypot(dx, dy);
  const speed = rand(CONFIG.meteor.speed[0], CONFIG.meteor.speed[1]);
  const flight = Math.max(0.05, dist / speed);

  const p = spawnParticle(s);
  if (!p) return;
  p.kind = 'meteor';
  p.x = sx; p.y = sy;
  p.vx = dx / flight;
  p.vy = dy / flight;
  p.tx = tx; p.ty = ty;
  p.flight = flight;
  p.r = rand(CONFIG.meteor.size[0], CONFIG.meteor.size[1]) + prog * CONFIG.meteor.bigBonus;
  p.life = flight; p.maxLife = flight;
}

/* ==================================================================
   月相爆发（左键松开）
   ================================================================== */
function releasePhaseBurst(s, power) {
  const moon = s.moon;
  const x = moon.x + moon.dx;
  const y = moon.y + moon.dy;
  const r = moon.r;

  s.freezeTimer = 0.03;
  moon.exposure = 1;

  // ---- 反射光粒子 + 月相波 + 月尘风暴 ----
  schedule(s, 0.1, function () {
    // 反射光爆发（球形放射）
    const n = Math.floor(150 + 350 * power);
    for (let i = 0; i < n; i++) {
      const p = spawnParticle(s);
      if (!p) break;
      const a = Math.random() * TAU;
      const d = r * rand(0.88, 1.05);
      const sp = (300 + 900 * power) * rand(0.6, 1.25);
      p.kind = 'light';
      p.x = x + Math.cos(a) * d;
      p.y = y + Math.sin(a) * d;
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp;
      p.r = rand(0.5, 2);
      p.maxLife = rand(0.6, 1.5);
      p.life = p.maxLife;
      p.drag = 0.55;
      p.tail = rand(5, 15);
    }
  });

  schedule(s, 0.1, function () {
    // 月相波 —— 由月牙形弧段组成的环形
    const count = 16 + Math.floor(power * 14);
    const maxR = 200 + 500 * power;
    for (let i = 0; i < count; i++) {
      const p = spawnParticle(s);
      if (!p) break;
      const a = (i / count) * TAU;
      p.kind = 'crescent';
      p.tx = x; p.ty = y;
      p.ang = a;
      p.dist = r * 0.9;
      p.maxDist = maxR;
      p.speed = 300 + 500 * power;
      p.r = rand(5, 11);
      p.life = 0.6; p.maxLife = 0.6;
    }
  });

  schedule(s, 0.11, function () {
    // 月尘风暴
    const n = Math.floor(80 + 200 * power);
    for (let i = 0; i < n; i++) {
      const p = spawnParticle(s);
      if (!p) break;
      const a = Math.random() * TAU;
      const d = r * rand(0.85, 1.05);
      const sp = rand(150, 500);
      p.kind = 'dust';
      p.x = x + Math.cos(a) * d;
      p.y = y + Math.sin(a) * d;
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp;
      p.r = rand(0.5, 2);
      p.maxLife = rand(1.2, 2.2);
      p.life = p.maxLife;
      p.gravity = 15;
      p.drag = 0.4;
    }
    // 月尘团
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * TAU;
      spawnPuff(s, x + Math.cos(a) * r, y + Math.sin(a) * r,
        Math.cos(a) * 120, Math.sin(a) * 120,
        rand(14, 26), rand(0.9, 1.6), 0.2);
    }
  });

  // ---- 环形山碎片 ----
  schedule(s, 0.12, function () {
    for (let i = 0; i < moon.craters.length; i++) {
      const c = moon.craters[i];
      const wx = x + c.x * r;
      const wy = y + c.y * r;
      const cnt = randInt(2, 4);
      for (let j = 0; j < cnt; j++) {
        const p = spawnParticle(s);
        if (!p) break;
        const a = Math.random() * TAU;
        const sp = rand(200, 500);
        p.kind = 'arcfrag';
        p.x = wx; p.y = wy;
        p.vx = Math.cos(a) * sp;
        p.vy = Math.sin(a) * sp;
        p.r = Math.max(1.5, c.r * r * 0.55);
        p.rot = Math.random() * TAU;
        p.spin = rand(-8, 8);
        p.maxLife = 0.8;
        p.life = 0.8;
        p.drag = 0.8;
      }
    }
  });

  // ---- 月光残影 ----
  schedule(s, 0.14, function () {
    spawnGhost(s, x, y, 100, 250, 0.22, 1.5, '240,240,255');
  });

  // ---- 月亮逐层溶解 ----
  schedule(s, 0.2, function () {
    moon.dying = true;
    moon.dieT = 0;
    moon.dieDur = 0.3;
  });

  // ---- 拖尾被照亮 ----
  schedule(s, 0.1, function () {
    moonCast(s, x, y);
  });
}

/* ==================================================================
   环形山爆发（右键松开）
   ================================================================== */
function releaseCraterBurst(s, power) {
  const moon = s.moon;
  const x = moon.x + moon.dx;
  const y = moon.y + moon.dy;
  const r = moon.r;

  s.freezeTimer = 0.03;
  moon.exposure = 1;

  // ---- 大规模陨石雨 ----
  const total = Math.floor(30 + 100 * power);
  const gap = 0.5 / Math.max(1, total);
  for (let i = 0; i < total; i++) {
    (function (idx) {
      schedule(s, 0.1 + idx * gap, function () {
        if (!moon.active && !moon.dying) return;
        const mx = moon.x + moon.dx;
        const my = moon.y + moon.dy;
        const ta = Math.random() * TAU;
        const td = Math.sqrt(Math.random()) * 0.75 * r;
        const tx = mx + Math.cos(ta) * td;
        const ty = my + Math.sin(ta) * td;

        const sa = Math.random() * TAU;
        const sd = r + rand(180, 340);
        const sx = mx + Math.cos(sa) * sd;
        const sy = my + Math.sin(sa) * sd;

        const dx = tx - sx, dy = ty - sy;
        const dist = Math.hypot(dx, dy);
        const speed = rand(500, 1000);
        const flight = Math.max(0.04, dist / speed);

        const p = spawnParticle(s);
        if (!p) return;
        p.kind = 'meteor';
        p.x = sx; p.y = sy;
        p.vx = dx / flight;
        p.vy = dy / flight;
        p.tx = tx; p.ty = ty;
        p.flight = flight;
        p.r = rand(3, 8);
        p.life = flight; p.maxLife = flight;
      });
    })(i);
  }

  // ---- 裂纹 ----
  schedule(s, 0.62, function () {
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * TAU;
      const p = spawnParticle(s);
      if (!p) break;
      p.kind = 'crack';
      p.x = x + Math.cos(a) * r * rand(0.1, 0.8);
      p.y = y + Math.sin(a) * r * rand(0.1, 0.8);
      p.ang = a + rand(-0.5, 0.5);
      p.len = rand(8, 26);
      p.life = 0.5; p.maxLife = 0.5;
    }
  });

  // ---- 月亮炸裂 ----
  schedule(s, 0.82, function () {
    const mx = moon.x + moon.dx;
    const my = moon.y + moon.dy;
    const cnt = randInt(8, 15);
    for (let i = 0; i < cnt; i++) {
      const p = spawnParticle(s);
      if (!p) break;
      const a = (i / cnt) * TAU + rand(-0.25, 0.25);
      const sp = rand(300, 700);
      p.kind = 'shard';
      p.x = mx + Math.cos(a) * r * rand(0.3, 0.7);
      p.y = my + Math.sin(a) * r * rand(0.3, 0.7);
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp;
      p.r = r * rand(0.16, 0.32);
      p.rot = Math.random() * TAU;
      p.spin = rand(-6, 6);
      p.maxLife = 1.1;
      p.life = 1.1;
      p.drag = 0.5;
      p.gravity = 30;
      p.seed = randInt(0, 3); // 碎片纹理类型
    }

    // 辐射纹爆发
    const rayN = Math.floor(20 + 50 * power);
    for (let i = 0; i < rayN; i++) {
      const p = spawnParticle(s);
      if (!p) break;
      const a = Math.random() * TAU;
      p.kind = 'ray';
      p.x = mx; p.y = my;
      p.ang = a;
      p.len = rand(CONFIG.ray.burstLen[0], CONFIG.ray.burstLen[1]);
      p.life = 0.9; p.maxLife = 0.9;
    }

    // 月尘风暴
    const dn = Math.floor(100 + 250 * power);
    for (let i = 0; i < dn; i++) {
      const p = spawnParticle(s);
      if (!p) break;
      const a = Math.random() * TAU;
      const sp = rand(200, 600);
      p.kind = 'dust';
      p.x = mx; p.y = my;
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp;
      p.r = rand(0.5, 2);
      p.maxLife = rand(1.2, 2.2);
      p.life = p.maxLife;
      p.gravity = 15;
      p.drag = 0.45;
    }

    // 环形山碎片
    for (let i = 0; i < moon.craters.length; i++) {
      const c = moon.craters[i];
      const wx = mx + c.x * r;
      const wy = my + c.y * r;
      const cc = randInt(2, 4);
      for (let j = 0; j < cc; j++) {
        const p = spawnParticle(s);
        if (!p) break;
        const a = Math.random() * TAU;
        const sp = rand(250, 600);
        p.kind = 'arcfrag';
        p.x = wx; p.y = wy;
        p.vx = Math.cos(a) * sp;
        p.vy = Math.sin(a) * sp;
        p.r = Math.max(1.5, c.r * r * 0.55);
        p.rot = Math.random() * TAU;
        p.spin = rand(-8, 8);
        p.maxLife = 0.8; p.life = 0.8;
        p.drag = 0.8;
      }
    }

    // 月尘残影
    spawnGhost(s, mx, my, 80, 200, 0.17, 1.5, '200,202,218');
    // 月尘团
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * TAU;
      spawnPuff(s, mx + Math.cos(a) * r, my + Math.sin(a) * r,
        Math.cos(a) * 150, Math.sin(a) * 150,
        rand(16, 30), rand(1.0, 1.8), 0.2);
    }

    // 月亮消失
    moon.dying = true;
    moon.dieT = 0;
    moon.dieDur = 0.18;

    // 月光照射
    moonCast(s, mx, my);
  });

  // ---- 拖尾被照亮（提前一波）----
  schedule(s, 0.1, function () {
    moonCast(s, x, y);
  });
}

/* ==================================================================
   右键快速单击
   ================================================================== */
function quickCraterClick(s, x, y) {
  const moon = s.moon;
  killMoon(s);
  moon.active = true;
  moon.mode = 'crater';
  moon.x = x; moon.y = y;
  moon.dx = 0; moon.dy = 0;
  moon.r = CONFIG.moon.craterR;
  moon.phase = Math.PI;
  moon.charge = 0;
  moon.birth = 0.2;
  moon.pulse = 0;
  moon.exposure = 0;
  moon.dying = false;
  moon.dieT = 0;
  generateMares(s, 3);

  const cnt = randInt(2, 3);
  for (let i = 0; i < cnt; i++) {
    const a = Math.random() * TAU;
    const d = Math.random() * moon.r * 0.6;
    impact(s, x + Math.cos(a) * d, y + Math.sin(a) * d, rand(3, 9));
  }

  moon.dying = true;
  moon.dieT = 0;
  moon.dieDur = 0.6;
}

/* ==================================================================
   粒子更新
   ================================================================== */
function updateParticles(s, dt) {
  const moon = s.moon;
  for (let i = 0; i < MAX_PARTICLES; i++) {
    const p = s.particles[i];
    if (!p.active) continue;

    if (p.kind === 'meteor') {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.flight -= dt;
      if (p.flight <= 0) {
        if (moon.active || moon.dying) impact(s, p.tx, p.ty, p.r);
        p.active = false;
      }
      continue;
    }

    if (p.kind === 'crescent') {
      p.dist += p.speed * dt;
      p.x = p.tx + Math.cos(p.ang) * p.dist;
      p.y = p.ty + Math.sin(p.ang) * p.dist;
      p.life -= dt;
      if (p.life <= 0 || p.dist > p.maxDist) p.active = false;
      continue;
    }

    if (p.kind === 'flash') {
      p.life -= dt;
      if (p.life <= 0) p.active = false;
      continue;
    }

    if (p.kind === 'rayline' || p.kind === 'ray' || p.kind === 'crack') {
      p.life -= dt;
      if (p.life <= 0) p.active = false;
      continue;
    }

    // 通用物理
    if (p.gravity) p.vy += p.gravity * dt;
    if (p.drag) {
      const d = Math.exp(-p.drag * dt);
      p.vx *= d;
      p.vy *= d;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;

    if (p.spin) p.rot += p.spin * dt;

    p.life -= dt;
    if (p.lit > 0) p.lit -= dt;
    if (p.life <= 0) p.active = false;
  }
}

/* ==================================================================
   粒子渲染
   ================================================================== */
function drawParticles(ctx, s) {
  const spr = s.spr;
  ctx.lineCap = 'round';

  for (let i = 0; i < MAX_PARTICLES; i++) {
    const p = s.particles[i];
    if (!p.active) continue;

    const t = clamp(p.life / p.maxLife, 0, 1);

    /* ---- 月尘粒子 ---- */
    if (p.kind === 'dust') {
      const fade = t > 0.35 ? 1 : t / 0.35;
      let a = fade * 0.85;
      let sp = spr.dust;
      if (p.lit > 0) {
        a = Math.min(1, a * 1.9);
        sp = spr.dustLit;
      }
      if (a <= 0.004) continue;
      const size = p.r * 4;
      ctx.globalAlpha = a;
      ctx.drawImage(sp, p.x - size, p.y - size, size * 2, size * 2);
      continue;
    }

    /* ---- 反射光粒子 ---- */
    if (p.kind === 'light') {
      const a = t * t;
      if (a <= 0.004) continue;
      const sp2 = Math.hypot(p.vx, p.vy);
      if (sp2 > 1) {
        const tl = Math.min(p.tail, sp2 * 0.035);
        const ux = p.vx / sp2, uy = p.vy / sp2;
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.moveTo(p.x - ux * tl, p.y - uy * tl);
        ctx.lineTo(p.x, p.y);
        ctx.strokeStyle = 'rgba(240,240,255,' + (a * 0.55).toFixed(3) + ')';
        ctx.lineWidth = Math.max(0.6, p.r * 0.9);
        ctx.stroke();
      }
      const size = p.r * 3.2;
      ctx.globalAlpha = a;
      ctx.drawImage(spr.glow, p.x - size, p.y - size, size * 2, size * 2);
      continue;
    }

    /* ---- 月相波月牙弧段 ---- */
    if (p.kind === 'crescent') {
      const a = t * 0.9;
      if (a <= 0.004) continue;
      ctx.globalAlpha = 1;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.ang + Math.PI * 0.5);
      ctx.beginPath();
      ctx.arc(0, 0, p.r, -0.95, 0.95);
      ctx.strokeStyle = 'rgba(240,240,255,' + a.toFixed(3) + ')';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, p.r * 0.62, -0.7, 0.7);
      ctx.strokeStyle = 'rgba(240,240,255,' + (a * 0.45).toFixed(3) + ')';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
      continue;
    }

    /* ---- 撞击闪光 ---- */
    if (p.kind === 'flash') {
      const a = t;
      if (a <= 0.004) continue;
      const r = p.r + (1 - t) * 16;
      const rg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      rg.addColorStop(0, 'rgba(255,255,255,' + a.toFixed(3) + ')');
      rg.addColorStop(0.4, 'rgba(255,255,255,' + (a * 0.5).toFixed(3) + ')');
      rg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, TAU);
      ctx.fill();
      continue;
    }

    /* ---- 月光光线 ---- */
    if (p.kind === 'rayline') {
      const a = t * 0.4;
      if (a <= 0.004) continue;
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.tx, p.ty);
      ctx.strokeStyle = 'rgba(240,240,255,' + a.toFixed(3) + ')';
      ctx.lineWidth = 0.5;
      ctx.stroke();
      continue;
    }

    /* ---- 辐射纹（瞬时）---- */
    if (p.kind === 'ray') {
      const a = t * 0.85;
      if (a <= 0.004) continue;
      const ex = p.x + Math.cos(p.ang) * p.len;
      const ey = p.y + Math.sin(p.ang) * p.len;
      const g = ctx.createLinearGradient(p.x, p.y, ex, ey);
      g.addColorStop(0, 'rgba(240,240,255,' + a.toFixed(3) + ')');
      g.addColorStop(0.7, 'rgba(240,240,255,' + (a * 0.35).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(240,240,255,0)');
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(ex, ey);
      ctx.strokeStyle = g;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      continue;
    }

    /* ---- 裂纹 ---- */
    if (p.kind === 'crack') {
      const a = t * 0.5;
      if (a <= 0.004) continue;
      const ex = p.x + Math.cos(p.ang) * p.len;
      const ey = p.y + Math.sin(p.ang) * p.len;
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(ex, ey);
      ctx.strokeStyle = 'rgba(20,20,32,' + a.toFixed(3) + ')';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      continue;
    }

    /* ---- 环形山弧段碎片 ---- */
    if (p.kind === 'arcfrag') {
      const a = t;
      if (a <= 0.004) continue;
      ctx.globalAlpha = 1;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.beginPath();
      ctx.arc(0, 0, p.r, -1.25, 1.25);
      ctx.strokeStyle = 'rgba(240,240,255,' + a.toFixed(3) + ')';
      ctx.lineWidth = Math.max(1, p.r * 0.24);
      ctx.stroke();
      ctx.restore();
      continue;
    }

    /* ---- 月亮碎片 ---- */
    if (p.kind === 'shard') {
      const a = t;
      if (a <= 0.004) continue;
      ctx.globalAlpha = a;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);

      const n = 6;
      ctx.beginPath();
      for (let k = 0; k < n; k++) {
        const aa = (k / n) * TAU;
        const rr = p.r * (0.7 + ((k * 37 + p.seed * 13) % 10) * 0.05);
        const qx = Math.cos(aa) * rr;
        const qy = Math.sin(aa) * rr;
        if (k === 0) ctx.moveTo(qx, qy); else ctx.lineTo(qx, qy);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(208,208,216,0.92)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(240,240,255,0.6)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // 碎片保留的月面纹理
      if (p.seed === 0) {
        ctx.beginPath();
        ctx.arc(p.r * 0.15, -p.r * 0.1, p.r * 0.32, 0, TAU);
        ctx.fillStyle = 'rgba(80,80,96,0.85)';
        ctx.fill();
      } else if (p.seed === 1) {
        ctx.beginPath();
        ctx.arc(-p.r * 0.2, p.r * 0.15, p.r * 0.22, 0, TAU);
        ctx.fillStyle = 'rgba(42,42,56,0.9)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(160,160,176,0.8)';
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(-p.r * 0.3, 0);
        ctx.lineTo(p.r * 0.4, p.r * 0.2);
        ctx.strokeStyle = 'rgba(240,240,255,0.5)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      ctx.restore();
      continue;
    }

    /* ---- 陨石 ---- */
    if (p.kind === 'meteor') {
      const sp2 = Math.hypot(p.vx, p.vy);
      if (sp2 > 1) {
        const tl = Math.min(26, sp2 * 0.045);
        const ux = p.vx / sp2, uy = p.vy / sp2;
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.moveTo(p.x - ux * tl, p.y - uy * tl);
        ctx.lineTo(p.x, p.y);
        ctx.strokeStyle = 'rgba(255,220,150,0.55)';
        ctx.lineWidth = Math.max(1, p.r * 0.7);
        ctx.stroke();
      }
      const size = p.r * 3;
      ctx.globalAlpha = 1;
      ctx.drawImage(spr.meteor, p.x - size, p.y - size, size * 2, size * 2);
      continue;
    }
  }

  ctx.globalAlpha = 1;
}

/* ==================================================================
   主更新
   ================================================================== */
function updateFrame(s, dtRaw) {
  const moon = s.moon;
  let dt = dtRaw;

  // 冻结一帧
  if (s.freezeTimer > 0) {
    s.freezeTimer -= dtRaw;
    dt = dtRaw * 0.05;
  }

  updateScheduler(s, dtRaw);

  /* ---- 月亮状态 ---- */
  if (moon.active) {
    moon.birth += dtRaw;
    moon.pulse += dt;
    moon.spin += dt * CONFIG.moon.mareDrift;

    if (moon.shake > 0) moon.shake -= dtRaw;

    // 平滑跟随鼠标
    const k = Math.min(1, dt * 12);
    moon.x += (s.input.x - moon.x) * k;
    moon.y += (s.input.y - moon.y) * k;

    // 微震
    let jx = 0, jy = 0;
    if (s.charging) {
      const prog = moon.charge / CONFIG.charge.max;
      if (prog > CONFIG.charge.jitterStart) {
        const amp = (prog - CONFIG.charge.jitterStart) / (1 - CONFIG.charge.jitterStart) * CONFIG.charge.jitterAmp;
        if (moon.mode === 'phase') {
          jx = (Math.random() - 0.5) * amp * 2;
          jy = (Math.random() - 0.5) * amp * 0.6;
        } else {
          jx = (Math.random() - 0.5) * amp * 0.6;
          jy = (Math.random() - 0.5) * amp * 2;
        }
      }
    }
    if (moon.shake > 0) {
      jx += (Math.random() - 0.5) * 4;
      jy += (Math.random() - 0.5) * 4;
    }
    moon.dx = jx;
    moon.dy = jy;

    // 蓄力推进
    if (s.charging) {
      moon.charge = Math.min(moon.charge + dt, CONFIG.charge.max);

      if (moon.mode === 'phase') {
        const prog = moon.charge / CONFIG.charge.max;
        moon.r = CONFIG.moon.phaseR0 + (CONFIG.moon.phaseR1 - CONFIG.moon.phaseR0) * prog;
        moon.phase = Math.PI * prog;

        // 月面漂浮尘埃
        moon.dustAcc += dt;
        if (moon.dustAcc > 0.05) {
          moon.dustAcc = 0;
          const a = Math.random() * TAU;
          const d = moon.r * rand(0.3, 1.0);
          const p = spawnParticle(s);
          if (p) {
            p.kind = 'dust';
            p.x = moon.x + moon.dx + Math.cos(a) * d;
            p.y = moon.y + moon.dy + Math.sin(a) * d;
            p.vx = rand(-10, 10);
            p.vy = rand(-16, -4);
            p.r = rand(0.5, 1.4);
            p.maxLife = rand(1.0, 1.8);
            p.life = p.maxLife;
            p.gravity = 8;
            p.drag = 0.5;
          }
        }
      } else {
        // 陨石坠落节奏
        const prog = moon.charge / CONFIG.charge.max;
        moon.meteorTimer -= dt;
        if (moon.meteorTimer <= 0) {
          const base = CONFIG.crater.rateStart +
            (CONFIG.crater.rateEnd - CONFIG.crater.rateStart) * prog;
          moon.meteorTimer = base * rand(0.75, 1.35);
          spawnMeteor(s, prog);
        }
      }
    }

    // 过曝回落
    if (moon.exposure > 0 && !moon.dying) moon.exposure = Math.max(0, moon.exposure - dt * 8);

    // 溶解
    if (moon.dying) {
      moon.dieT += dtRaw;
      if (moon.dieT >= moon.dieDur) killMoon(s);
    }
  }

  /* ---- 脉冲月亮 ---- */
  updatePulseMoons(s, dt);

  /* ---- 残影 ---- */
  updateGhosts(s, dt);

  /* ---- 月尘团 ---- */
  updatePuffs(s, dt);

  /* ---- 粒子 ---- */
  updateParticles(s, dt);
}

/* ==================================================================
   渲染
   ================================================================== */
function renderFrame(ctx, s) {
  ctx.clearRect(0, 0, s.W, s.H);

  // 残影（底层光斑）
  drawGhosts(ctx, s);

  // 月亮本体
  drawMoon(ctx, s);
  drawPulseMoons(ctx, s);

  // 月尘团
  drawPuffs(ctx, s);

  // 全部粒子
  drawParticles(ctx, s);
}

export class CursorMoon extends CursorEffectElement {
  // 原型用的是 mousemove / mousedown / mouseup（不是 pointer 事件族），
  // 不声明这一行，基类会去监听 pointermove，动效将完全收不到鼠标输入。
  inputFamily = 'mouse';

  /* ==================================================================
     初始化
     ================================================================== */
  // 只建池与状态，不注册任何监听（监听、DPR 缩放、rAF 全归基类）
  setup({ canvas, ctx, width, height, input }) {
    // 与原型一致：初始光标位置取视口中心。
    // 基类的 input 从 (0, 0) 起算，若不在这里对齐，首帧的位移会按「从左上角跳过来」计算，
    // 速度与拖尾生成量会和原型不同。
    input.x = input.lx = width * 0.5;
    input.y = input.ly = height * 0.5;

    // ---- 粒子池 ----
    const particles = [];
    for (let i = 0; i < MAX_PARTICLES; i++) particles.push(newParticle());

    // ---- 环形山对象池 ----
    const craterPool = [];
    for (let i = 0; i < CONFIG.crater.maxPool; i++) {
      craterPool.push({ inUse: false, x: 0, y: 0, r: 0, big: false, peak: false });
    }

    // ---- 月尘团对象池 ----
    const puffPool = [];
    for (let i = 0; i < CONFIG.dust.puffMax; i++) {
      puffPool.push({ active: false, x: 0, y: 0, vx: 0, vy: 0, r: 10, life: 0, maxLife: 1, alpha: 0.2 });
    }

    return {
      // 本实例的画布上下文（已按 DPR 缩放过，统一使用 CSS 像素坐标）
      ctx,

      // 画布尺寸（CSS 像素），由基类 onResize 同步
      W: width,
      H: height,

      input,

      // 离屏粒子贴图（每个实例一份，绝不挂进 DOM）
      spr: buildSprites(canvas.ownerDocument),

      // 粒子池
      particles,
      pCursor: 0,

      // 环形山 / 月尘团对象池
      craterPool,
      puffPool,

      // 爆发序列的延时动作
      scheduled: [],

      // 鼠标输入状态
      charging: false,
      chargeButton: -1,   // 0 = 左键月相，2 = 右键环形山
      freezeTimer: 0,

      // 原始逐帧速度（原型 onMove 里的 mouse.vx / mouse.vy，未经平滑）
      rawVx: 0,
      rawVy: 0,

      // 月亮状态
      moon: newMoon(),

      // 脉冲月亮 / 残影光斑
      pulseMoons: [],
      ghosts: []
    };
  }

  /* ==================================================================
     拖尾月尘 —— 原型在 mousemove 里生成，这里按每帧的位移生成
     ================================================================== */
  _emitTrail(s) {
    const M = s.input;
    const dx = M.x - M.lx;
    const dy = M.y - M.ly;

    // 原型只在 mousemove 事件里生成拖尾：光标静止时浏览器不发事件，也就什么都不生成
    // （包括慢速月尘团那条分支）。基类没有 per-move 钩子，这里按帧位移代替事件，
    // 位移为 0 等价于「这一帧没有 mousemove」，必须直接返回，否则光标不动时会凭空冒月尘团。
    if (dx === 0 && dy === 0) return;

    const speed = Math.hypot(dx, dy);

    // 拖尾月尘
    // 原型第 1811 行把 onMove 里算出的原始逐帧速度 mouse.vx / mouse.vy 传给 spawnTrailDust，
    // 那是未经平滑的 dx / dtm，与基类平滑后的 input.vx / vy 不是一回事，
    // 因此这里用 update() 里同样按原始口径算出的 rawVx / rawVy。
    const steps = Math.min(Math.ceil(speed / CONFIG.trail.stepPx), 6);
    for (let i = 0; i < steps; i++) {
      const f = (i + 1) / steps;
      spawnTrailDust(
        s,
        M.x - dx * (1 - f),
        M.y - dy * (1 - f),
        s.rawVx, s.rawVy
      );
    }

    // 慢速时形成月尘团
    if (speed < 3 && Math.random() < 0.12) {
      spawnPuff(s, M.x, M.y, rand(-6, 6), rand(-6, 6),
        rand(6, 12), rand(0.6, 1.1), 0.09);
    }

    // 蓄力期间污染拖尾：月尘被月亮吸引
    if (s.charging && s.moon.active && Math.random() < 0.3) {
      const a = Math.atan2(s.moon.y - M.y, s.moon.x - M.x);
      const p = spawnParticle(s);
      if (p) {
        p.kind = 'dust';
        p.x = M.x;
        p.y = M.y;
        const d = Math.hypot(s.moon.x - M.x, s.moon.y - M.y);
        const pull = Math.min(120, 4000 / Math.max(40, d));
        p.vx = Math.cos(a) * pull + rand(-20, 20);
        p.vy = Math.sin(a) * pull + rand(-20, 20);
        p.r = rand(0.5, 1.6);
        p.maxLife = rand(0.9, 1.6);
        p.life = p.maxLife;
        p.gravity = 0;
        p.drag = 0.4;
      }
    }
  }

  /* ==================================================================
     输入（按键）—— 这里只处理左右键蓄力；拖尾要用的原始速度在 update() 里算
     ================================================================== */
  onPointerDown(e) {
    const s = this.state;
    if (!s) return;

    if (e.button !== 0 && e.button !== 2) return;
    if (s.charging) return;

    // 原型以 mousedown 时的 mouse.x / mouse.y（即最后一次 mousemove 的位置）作为原点，
    // 与基类的 input.x / input.y 语义一致
    if (e.button === 0) {
      s.charging = true;
      s.chargeButton = 0;
      createMoon(s, s.input.x, s.input.y, 'phase');
    } else {
      s.charging = true;
      s.chargeButton = 2;
      createMoon(s, s.input.x, s.input.y, 'crater');
    }
  }

  onPointerUp(e) {
    const s = this.state;
    if (!s) return;

    if (!s.charging) return;
    if (e.button !== 0 && e.button !== 2) return;
    if (e.button !== s.chargeButton) return;

    s.charging = false;

    const charge = s.moon.charge;
    const power = Math.pow(clamp(charge, 0, CONFIG.charge.max) / CONFIG.charge.max, CONFIG.charge.burstPow);

    if (charge < CONFIG.charge.clickThresh) {
      // 普通单击
      if (s.chargeButton === 0) {
        killMoon(s);
        doClickEffect(s, s.input.x, s.input.y);
      } else {
        quickCraterClick(s, s.input.x, s.input.y);
      }
      s.chargeButton = -1;
      return;
    }

    if (s.moon.mode === 'phase') {
      releasePhaseBurst(s, power);
    } else {
      releaseCraterBurst(s, power);
    }
    s.chargeButton = -1;
  }

  // 失焦收尾（原型 window blur 的行为）
  onBlur() {
    const s = this.state;
    if (!s) return;

    s.charging = false;
    s.chargeButton = -1;
    s.scheduled.length = 0;
    s.freezeTimer = 0;
    if (s.moon.active && !s.moon.dying) killMoon(s);
  }

  /* ==================================================================
     尺寸 —— 只同步动效自己的 W / H，画布尺寸与 DPR 由基类维护
     ================================================================== */
  onResize(width, height) {
    const s = this.state;
    if (!s) return;
    s.W = width;
    s.H = height;
  }

  /* ==================================================================
     更新 / 渲染
     ================================================================== */
  update(dt, s) {
    if (!s) return;

    // —— 鼠标位移：基类每帧写入 this.input（lx/ly → x/y 与原型一致）——
    // 原型 onMove 里的 mouse.vx / mouse.vy 是未经平滑的原始速度 dx / dtm，
    // 基类的 input.vx / vy 走的是 1-exp(-25dt) 平滑，两者口径不同；
    // 本动效只用到原始速度（喂给拖尾月尘），所以在这里单独算一次。
    const M = s.input;
    const mdx = M.x - M.lx, mdy = M.y - M.ly;
    s.rawVx = dt > 0 ? mdx / dt : 0;
    s.rawVy = dt > 0 ? mdy / dt : 0;

    this._emitTrail(s);

    updateFrame(s, dt);
  }

  render(s) {
    if (!s) return;
    renderFrame(s.ctx, s);
  }
}

if (!customElements.get('cursor-moon')) {
  customElements.define('cursor-moon', CursorMoon);
}

export default CursorMoon;
