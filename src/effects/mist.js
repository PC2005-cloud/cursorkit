/**
 * cursor-mist —— 鼠标光标云雾动效（左键积雨云 / 右键浓雾）。
 *
 * 由 html/云雾.html 原型移植：算法流程、数值、视觉表现与原文件一一对应。
 * 作为光标层组件，原型页面自身的行为已剔除：
 *   - 原型的深色背景由页面 CSS 提供，render() 本来就是 clearRect，
 *     移植后同样不铺任何整屏底色，绝不覆盖宿主页面；
 *   - 不拦截 contextmenu，宿主页面的右键菜单不受影响；
 *   - 画布创建、DPR 适配、尺寸同步、监听注册、rAF 循环
 *     以及「鼠标速度平滑 / >300px 跳变归零 / 6000 封顶」全部由基类负责。
 *
 * 原型监听 mousemove / mousedown / mouseup，因此声明 inputFamily = 'mouse'。
 * 所有运行状态都放在 setup() 返回的 state 上，多实例互不干扰。
 */

import { CursorEffectElement } from '../core/base.js';
import { TAU, clamp, lerp, rand, randInt } from '../core/utils.js';

/* ==================================================================
   CONFIG —— 集中配置
   ================================================================== */
const CONFIG = {
  maxBlobs: 900,                       // 软光斑池上限
  texSizes: [12, 24, 48, 80, 140, 220, 320], // 离屏纹理预渲染尺寸档位

  // ---- 配色 ----
  colors: {
    // 冷灰组（积雨云）
    cloudTop:   '#F5F8FC',
    cloudWaist: '#D8DEE8',
    cloudBelly: '#8A9AAE',
    cloudBase:  '#4A5666',
    cbDeep:     '#2A3038',
    boltCore:   '#FFFFFF',
    boltGlow:   '#A8D8FF',
    innerFlash: '#FFF8D8',
    // 暮色组（浓雾）
    mistWhite:  '#E8EEF4',
    mistGray:   '#B0BEC8',
    mistBlue:   '#8A9EB0',
    mistCyan:   '#6B8A9C',
    mistPurple: '#7A6A8A',
    mistGold:   '#FFE8B0'
  },

  // ---- 湍流场（3~4 层正弦叠加）----
  turb: {
    a1: 26, f1: 0.0042, s1: 0.55,
    a2: 18, f2: 0.0061, s2: -0.42,
    a3: 12, f3: 0.0031, s3: 0.28,
    b1: 24, g1: 0.0050, r1: 0.48,
    b2: 16, g2: 0.0037, r2: -0.60,
    b3: 10, g3: 0.0068, r3: 0.33,
    follow: 1.9                        // 速度跟随系数
  },

  // ---- 拖尾 ----
  trail: {
    spacing: 9,                        // 采样间距 px
    spread: 16,                        // 横向散布基准
    spreadMax: 52,                     // 快速移动时的最大散布
    densCenter: 0.46,                  // 路径中心浓度
    densEdge: 0.16                     // 路径边缘浓度
  },

  // ---- 软光斑尺寸分层（底 5 : 中 3 : 顶 1）----
  layers: {
    base:  { p: 0.56, rMin: 45, rMax: 100, aMin: 0.030, aMax: 0.062 },
    mid:   { p: 0.32, rMin: 20, rMax: 46,  aMin: 0.048, aMax: 0.090 },
    top:   { p: 0.12, rMin: 8,  rMax: 18,  aMin: 0.075, aMax: 0.135 }
  },

  // ---- 凝结 / 蒸发 ----
  condense: 0.30,
  evaporate: 0.60,
  stableMin: 0.50,
  stableMax: 1.50,

  // ---- 蓄力 ----
  chargeMax: 2.5,
  chargeMinClick: 0.12,

  // ---- 积雨云 ----
  cloud: {
    rate: 118,                         // 每秒生成数
    heightMin: 30,
    heightMax: 240,
    baseDrop0: 20,
    baseDrop1: 80,
    waistMin: 34,
    waistMax: 64,
    anvilHalf: 90,                     // 砧状云顶半宽
    anvilStart: 1.5,                   // 砧状云顶开始时间(s)
    breathCycle: 1.2,
    shakeStart: 0.55,                  // 抖动起始蓄力比例
    flashStart: 1.0,
    streakStart: 1.8,
    updraftRate: 22
  },

  // ---- 浓雾 ----
  mist: {
    rate: 78,
    radiusMin: 40,
    radiusMax: 240,
    vHalfMin: 22,
    vHalfMax: 42,
    sink0: 20,
    sink1: 40,
    sectors: 20,
    strandChance: 0.09,
    goldChance: 0.028,
    holeStart: 1.5
  },

  // ---- 气旋扰动（单击冲击）----
  vortex: {
    radius: 200,
    spin: 620,                         // 切向加速度基准
    dur: 0.4,
    densBoost: 0.16,
    strands: 5,
    waveMax: 120,
    waveLife: 0.35
  },

  // ---- 闪电 ----
  bolt: {
    life: 0.12,
    coreWidth: 3,
    glowWidth: 6,
    glowAlpha: 0.6,
    segMin: 8,
    segMax: 15,
    branchMin: 2,
    branchMax: 4,
    lenBase: 150,
    lenPower: 400
  },

  // ---- 云爆 / 降雨 ----
  burst: {
    expand: 1.8,
    expandT: 0.15,
    ringMin: 30,
    ringMax: 50,
    ringR0: 40,
    ringR1: 150,
    ringPower: 450,
    ringLife: 0.8,
    dropBase: 40,
    dropPower: 150,
    dropSpeed: 500,
    dropSpeedPower: 900,
    groundMin: 100,
    groundMax: 200,
    glowLife: 0.4
  },

  // ---- 雾墙 ----
  wall: {
    speedBase: 200,
    speedPower: 600,
    distBase: 150,
    distPower: 450,
    dur: 0.62,
    burstBase: 40,
    burstPower: 120,
    burstSpeedBase: 200,
    burstSpeedPower: 500,
    backFlow: 26
  }
};

/* ==================================================================
   工具函数（纯函数，无实例状态）
   ================================================================== */
function smoothstep(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }

// 标准正态分布（Box-Muller）
// 原型此处写的是全精度 6.283185307179586，与 utils 的 TAU 完全相等，故直接用 TAU。
function gaussian() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/* ==================================================================
   离屏纹理预渲染
   ================================================================== */
// 原型用全局 document.createElement 预渲染软光斑贴图。
// 移植后改用元素自身的 ownerDocument 创建：不触碰任何全局对象，
// 每个实例各自持有一份，且绝不挂进 DOM。
// 这里的 c.width / c.height / getContext 都只作用于离屏贴图画布，与主画布无关。
function buildTextures(doc) {
  const TEX = {};
  for (const name in CONFIG.colors) {
    const [r, g, b] = hexToRgb(CONFIG.colors[name]);
    const arr = [];
    for (let i = 0; i < CONFIG.texSizes.length; i++) {
      const size = CONFIG.texSizes[i];
      const c = doc.createElement('canvas');
      c.width = size; c.height = size;
      const g2 = c.getContext('2d');
      const half = size * 0.5;
      const grd = g2.createRadialGradient(half, half, 0, half, half, half);
      grd.addColorStop(0.00, 'rgba(' + r + ',' + g + ',' + b + ',1)');
      grd.addColorStop(0.16, 'rgba(' + r + ',' + g + ',' + b + ',0.74)');
      grd.addColorStop(0.38, 'rgba(' + r + ',' + g + ',' + b + ',0.34)');
      grd.addColorStop(0.66, 'rgba(' + r + ',' + g + ',' + b + ',0.10)');
      grd.addColorStop(1.00, 'rgba(' + r + ',' + g + ',' + b + ',0)');
      g2.fillStyle = grd;
      // 贴图自身的整块填充：它落在离屏画布上，不是视口铺底，必须保留
      g2.fillRect(0, 0, size, size);
      arr.push(c);
    }
    TEX[name] = arr;
  }
  return TEX;
}

// 取最接近目标直径的预渲染档位
function texFor(TEX, name, r) {
  const sizes = CONFIG.texSizes;
  const d = r * 2;
  let bi = 0, bd = 1e9;
  for (let i = 0; i < sizes.length; i++) {
    const df = sizes[i] > d ? sizes[i] - d : d - sizes[i];
    if (df < bd) { bd = df; bi = i; }
  }
  return TEX[name][bi];
}

/* ==================================================================
   软光斑池
   ================================================================== */
function spawnBlob(s, o) {
  if (s.pool.length >= CONFIG.maxBlobs) s.pool.shift();
  const p = {
    x: o.x, y: o.y,
    vx: o.vx || 0, vy: o.vy || 0,
    r: 0, rTarget: o.r,
    alpha: 0, alphaTarget: o.alpha,
    density: 0, densityTarget: o.density,
    color: o.color,
    age: 0,
    condT: o.condT !== undefined ? o.condT : CONFIG.condense,
    stableT: o.stableT !== undefined ? o.stableT : rand(CONFIG.stableMin, CONFIG.stableMax),
    evapT: o.evapT !== undefined ? o.evapT : CONFIG.evaporate,
    kind: o.kind || 'trail',
    sx: o.sx || 1, sy: o.sy || 1, rot: o.rot || 0,
    stretchX: 1, stretchY: 1, stretchRot: 0,
    stretchT: 0, stretchDur: 0.3, stretchMax: 1,
    spin: 0, spinUntil: 0, cx: 0, cy: 0,
    rise: o.rise || 0, grav: o.grav || 0,
    turbScale: o.turbScale || 1,
    attract: null, attractUntil: 0,
    dead: false
  };
  s.pool.push(p);
  return p;
}

function applyStretch(p, amount, angle, dur) {
  p.stretchMax = amount;
  p.stretchRot = angle;
  p.stretchDur = dur;
  p.stretchT = dur;
}

/* ==================================================================
   湍流场
   ================================================================== */
function turbulence(x, y, t, out) {
  const T = CONFIG.turb;
  out.vx = T.a1 * Math.sin(x * T.f1 + t * T.s1)
         + T.a2 * Math.sin(y * T.f2 + t * T.s2)
         + T.a3 * Math.sin((x + y) * T.f3 + t * T.s3);
  out.vy = T.b1 * Math.cos(y * T.g1 + t * T.r1)
         + T.b2 * Math.cos(x * T.g2 + t * T.r2)
         + T.b3 * Math.cos((x - y) * T.g3 + t * T.r3);
  return out;
}

// 延迟任务：t 秒后执行 fn
function after(s, t, fn) { s.timers.push({ t: t, fn: fn }); }

/* ==================================================================
   拖尾
   ================================================================== */
function layerPick() {
  const r = Math.random();
  if (r < CONFIG.layers.base.p) return CONFIG.layers.base;
  if (r < CONFIG.layers.base.p + CONFIG.layers.mid.p) return CONFIG.layers.mid;
  return CONFIG.layers.top;
}

function emitTrail(s, dt) {
  const M = s.input;
  // 原型在此处自行维护 mouse.px / mouse.py；基类每帧末把 lx / ly 对齐到 x / y，
  // 语义与原型完全一致，这里直接取用，不再重复记录上一帧位置。
  const dx = M.x - M.lx;
  const dy = M.y - M.ly;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1.6) return;

  const dirX = dx / dist, dirY = dy / dist;
  const perpX = -dirY, perpY = dirX;
  const speed = dist / Math.max(dt, 0.008);
  const spread = Math.min(CONFIG.trail.spreadMax, CONFIG.trail.spread + speed * 0.055);

  const spacing = CONFIG.trail.spacing;
  const steps = Math.min(22, Math.floor(dist / spacing) + 1);

  const L = s.left;
  const cloudActive = !!L;

  for (let i = 0; i < steps; i++) {
    const k = steps <= 1 ? 1 : i / (steps - 1);
    const bx = M.x - dx * (1 - k);
    const by = M.y - dy * (1 - k);

    const n = 2;
    for (let j = 0; j < n; j++) {
      const off = gaussian() * spread * 0.5;
      const edge = Math.min(1, Math.abs(off) / spread);
      const x = bx + perpX * off + gaussian() * 4;
      const y = by + perpY * off + gaussian() * 4;

      const lay = layerPick();
      const rad = rand(lay.rMin, lay.rMax);
      const al = rand(lay.aMin, lay.aMax) * (1 - edge * 0.45);
      const dens = lerp(CONFIG.trail.densCenter, CONFIG.trail.densEdge, edge);

      let col;
      const cr = Math.random();
      if (dens > 0.36) col = cr < 0.5 ? 'cloudBelly' : 'cloudWaist';
      else if (dens > 0.22) col = cr < 0.5 ? 'cloudWaist' : 'cloudTop';
      else col = 'cloudTop';

      const p = spawnBlob(s, {
        x: x, y: y,
        vx: dirX * speed * 0.06, vy: dirY * speed * 0.06,
        r: rad, alpha: al, density: dens,
        color: col, kind: 'trail',
        stableT: rand(0.4, 1.2),
        evapT: rand(0.5, 0.7)
      });

      if (cloudActive && p) {
        p.attract = { x: L.x, y: L.y + 10, f: 70 };
        p.attractUntil = s.time + 0.9;
      }
    }

    // 丝缕
    if (Math.random() < 0.05) {
      const ang = Math.atan2(dirY, dirX) + rand(-0.6, 0.6);
      spawnBlob(s, {
        x: bx + gaussian() * 6, y: by + gaussian() * 6,
        r: rand(10, 22), alpha: rand(0.05, 0.10), density: rand(0.25, 0.42),
        color: 'cloudTop', kind: 'trail',
        sx: rand(5, 9), sy: 1, rot: ang,
        stableT: rand(0.5, 1.0), evapT: 0.7
      });
    }
  }
}

/* ==================================================================
   单击
   ================================================================== */
function vortexBurst(s, x, y) {
  const V = CONFIG.vortex;
  const R2 = V.radius * V.radius;

  for (let i = 0; i < s.pool.length; i++) {
    const p = s.pool[i];
    if (p.kind !== 'trail') continue;
    const dx = p.x - x, dy = p.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 > R2) continue;
    const d = Math.sqrt(d2) + 0.001;
    const fall = 1 - d / V.radius;
    p.spin = V.spin * fall;
    p.spinUntil = s.time + V.dur;
    p.cx = x; p.cy = y;
    p.densityTarget = Math.min(0.8, p.densityTarget + V.densBoost * fall);
  }

  // 气旋丝缕
  for (let i = 0; i < V.strands; i++) {
    const a = Math.random() * 6.283185;
    const rr = rand(30, 90);
    spawnBlob(s, {
      x: x + Math.cos(a) * rr,
      y: y + Math.sin(a) * rr,
      r: rand(10, 20),
      alpha: rand(0.06, 0.13),
      density: rand(0.25, 0.45),
      color: Math.random() < 0.5 ? 'cloudTop' : 'cloudWaist',
      kind: 'strand',
      sx: rand(6, 10), sy: 1,
      rot: a + Math.PI * 0.5,
      condT: 0.06, stableT: 0.06, evapT: 0.24
    });
  }

  // 气压波
  s.glow.push({
    x: x, y: y, r: 10, rMax: V.waveMax,
    alpha: 0.15, life: V.waveLife, maxLife: V.waveLife,
    color: 'cloudTop'
  });
}

function doClickPuff(s, x, y) {
  const n = randInt(8, 14);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * 6.283185;
    const rr = Math.abs(gaussian()) * 15 + Math.random() * 12;
    const lay = layerPick();
    spawnBlob(s, {
      x: x + Math.cos(a) * rr,
      y: y + Math.sin(a) * rr,
      vx: Math.cos(a) * 24, vy: Math.sin(a) * 24 - 12,
      r: rand(lay.rMin * 0.7, lay.rMax * 0.75),
      alpha: rand(lay.aMin, lay.aMax) * 1.3,
      density: rand(0.22, 0.5),
      color: Math.random() < 0.45 ? 'cloudTop' : (Math.random() < 0.6 ? 'cloudWaist' : 'cloudBelly'),
      kind: 'puff',
      condT: 0.16,
      stableT: rand(0.15, 0.35),
      evapT: 0.55
    });
  }

  // 气浪环
  const ring = randInt(8, 12);
  for (let i = 0; i < ring; i++) {
    const a = (i / ring) * 6.283185 + rand(-0.12, 0.12);
    spawnBlob(s, {
      x: x + Math.cos(a) * 15,
      y: y + Math.sin(a) * 15,
      vx: Math.cos(a) * 110,
      vy: Math.sin(a) * 110,
      r: rand(14, 26),
      alpha: rand(0.05, 0.09),
      density: rand(0.12, 0.25),
      color: 'cloudTop',
      kind: 'ring',
      condT: 0.05, stableT: 0.05, evapT: 0.42
    });
  }

  // 凝结高光
  spawnBlob(s, {
    x: x, y: y, r: 6, alpha: 0.55, density: 0.1,
    color: 'innerFlash', kind: 'flash',
    condT: 0.01, stableT: 0.02, evapT: 0.06
  });
}

/* ==================================================================
   左键 —— 积雨云
   ================================================================== */
function cloudHalf(u, prog, anvilP) {
  const waist = lerp(CONFIG.cloud.waistMin, CONFIG.cloud.waistMax, prog);
  let w;
  if (u < 0.5) {
    w = waist * (0.72 + 0.28 * (u / 0.5));
  } else if (u < 0.8) {
    w = waist * (1.0 + 0.08 * Math.sin((u - 0.5) / 0.3 * Math.PI));
  } else {
    const k = (u - 0.8) / 0.2;
    const target = lerp(waist, CONFIG.cloud.anvilHalf, anvilP);
    w = lerp(waist, target, smoothstep(k));
  }
  return w;
}

function emitCloud(s, dt) {
  const L = s.left;
  const M = s.input;
  const C = CONFIG.cloud;
  const prog = clamp(L.t / CONFIG.chargeMax, 0, 1);
  const anvilP = clamp((L.t - C.anvilStart) / (CONFIG.chargeMax - C.anvilStart), 0, 1);

  // 跟随光标（带滞后）
  L.x += (M.x - L.x) * Math.min(1, dt * 9);
  L.y += (M.y - L.y) * Math.min(1, dt * 9);

  // 微震
  let sh = 0;
  if (prog > C.shakeStart) {
    const k = (prog - C.shakeStart) / (1 - C.shakeStart);
    sh = k * 2.2;
  }
  L.shakeX = (Math.random() - 0.5) * 2 * sh;
  L.shakeY = (Math.random() - 0.5) * 2 * sh;

  const cx = L.x + L.shakeX;
  const cy = L.y + L.shakeY;

  const breath = 1 + 0.05 * Math.sin(L.t * (6.283185 / C.breathCycle));
  const Hgt = lerp(C.heightMin, C.heightMax, prog) * breath;
  const baseY = cy + lerp(C.baseDrop0, C.baseDrop1, prog);
  const topY = baseY - Hgt;

  L.baseY = baseY;
  L.topY = topY;
  L.cx = cx;
  L.cy = cy;
  L.Hgt = Hgt;

  // 生成云体光斑
  L.spawnAcc += C.rate * dt;
  while (L.spawnAcc >= 1) {
    L.spawnAcc -= 1;
    const u = Math.pow(Math.random(), 0.85);
    const y = baseY - u * Hgt;
    const hw = cloudHalf(u, prog, anvilP);
    const x = cx + gaussian() * hw * 0.44;

    // 光照：左上偏亮
    const lx = (x - cx) / Math.max(20, hw);
    const lit = clamp(0.5 - lx * 0.55 - (0.55 - u) * 0.25, 0, 1);

    // 云底随蓄力变暗
    const darken = u < 0.42 ? (1 - u / 0.42) * (0.35 + 0.65 * prog) : 0;

    let col, dens;
    if (u < 0.34) {
      col = darken > 0.55 ? 'cbDeep' : (Math.random() < 0.5 ? 'cloudBase' : 'cbDeep');
      dens = 0.55 + 0.32 * darken;
    } else if (u < 0.62) {
      col = Math.random() < 0.55 ? 'cloudBelly' : 'cloudBase';
      dens = 0.42 + 0.14 * (1 - lit);
    } else if (u < 0.86) {
      col = lit > 0.55 ? 'cloudWaist' : (Math.random() < 0.5 ? 'cloudBelly' : 'cloudWaist');
      dens = 0.30 + 0.16 * (1 - lit);
    } else {
      col = lit > 0.5 ? 'cloudTop' : 'cloudWaist';
      dens = 0.18 + 0.14 * (1 - lit);
    }

    const lay = layerPick();
    let rad = rand(lay.rMin, lay.rMax);
    let al = rand(lay.aMin, lay.aMax);

    // 云顶更亮更轻，云底更厚更暗
    if (u > 0.7) al *= 1.25;
    if (u < 0.3) { rad *= 1.15; al *= 1.1; }

    spawnBlob(s, {
      x: x, y: y,
      vx: gaussian() * 8, vy: -rand(8, 30),
      r: rad, alpha: al, density: dens,
      color: col, kind: 'cloud',
      turbScale: 2,
      condT: 0.22,
      stableT: rand(0.35, 0.85),
      evapT: 0.55
    });
  }

  // 上升气流
  L.upAcc += C.updraftRate * dt;
  while (L.upAcc >= 1) {
    L.upAcc -= 1;
    spawnBlob(s, {
      x: cx + gaussian() * 60,
      y: cy + rand(60, 130),
      r: rand(18, 38),
      alpha: rand(0.03, 0.06),
      density: rand(0.16, 0.32),
      color: Math.random() < 0.6 ? 'cloudWaist' : 'cloudBelly',
      kind: 'updraft',
      rise: rand(30, 80),
      condT: 0.15,
      stableT: rand(0.5, 1.1),
      evapT: 0.5
    });
  }

  // 内部闪光
  if (L.t > C.flashStart) {
    const freq = 0.5 + 3.5 * clamp((L.t - C.flashStart) / (CONFIG.chargeMax - C.flashStart), 0, 1);
    L.flashAcc += dt * freq;
    while (L.flashAcc >= 1) {
      L.flashAcc -= 1;
      const u = rand(0.45, 1.0);
      const y = baseY - u * Hgt;
      const hw = cloudHalf(u, prog, anvilP);
      spawnBlob(s, {
        x: cx + gaussian() * hw * 0.5,
        y: y,
        r: rand(14, 42),
        alpha: rand(0.28, 0.55),
        density: 0.08,
        color: 'innerFlash',
        kind: 'flash',
        condT: 0.012, stableT: 0.026, evapT: 0.042
      });
    }
  }

  // 电荷纹路
  if (L.t > C.streakStart) {
    L.streakAcc += dt * (1 + 4 * clamp((L.t - C.streakStart) / (CONFIG.chargeMax - C.streakStart), 0, 1));
    while (L.streakAcc >= 1) {
      L.streakAcc -= 1;
      const u = rand(0.4, 1.0);
      const y0 = baseY - u * Hgt;
      const hw = cloudHalf(u, prog, anvilP);
      const x0 = cx + gaussian() * hw * 0.5;
      const ang = rand(0, 6.283185);
      const len = rand(20, 60);
      s.chargeLines.push({
        x: x0, y: y0,
        dx: Math.cos(ang) * len,
        dy: Math.sin(ang) * len,
        life: 0.3, maxLife: 0.3
      });
    }
  }
}

function releaseLeft(s) {
  const L = s.left;
  s.left = null;
  if (!L) return;

  if (L.t < CONFIG.chargeMinClick) {
    doClickPuff(s, L.x, L.y);
    return;
  }

  const power = Math.pow(clamp(L.t, 0, CONFIG.chargeMax) / CONFIG.chargeMax, 1.6);
  const bx = L.cx !== undefined ? L.cx : L.x;
  const by = L.baseY !== undefined ? L.baseY : L.y + 60;

  s.freeze = 0.03;

  after(s, 0.03, function () {
    // 闪电
    const len = CONFIG.bolt.lenBase + CONFIG.bolt.lenPower * power;
    s.bolts.push(makeBolt(bx, by, len, power));

    // 电离辉光
    s.glow.push({
      x: bx, y: by - 90, r: 60, rMax: 260,
      alpha: 0.15, life: CONFIG.burst.glowLife, maxLife: CONFIG.burst.glowLife,
      color: 'boltGlow'
    });

    // 云体炸开 + 冲击波 + 降雨
    after(s, 0.08, function () { cloudBurst(s, bx, by, power); });
  });
}

function makeBolt(x, y, length, power) {
  const B = CONFIG.bolt;
  const segs = randInt(B.segMin, B.segMax);
  const segLen = length / segs;
  let ang = Math.PI * 0.5 + rand(-0.32, 0.32);
  let cx = x, cy = y;
  const pts = [{ x: cx, y: cy }];
  for (let i = 0; i < segs; i++) {
    ang += rand(-0.42, 0.42);
    cx += Math.cos(ang) * segLen;
    cy += Math.sin(ang) * segLen;
    pts.push({ x: cx, y: cy });
  }
  const branches = [];
  const nB = randInt(B.branchMin, B.branchMax);
  for (let b = 0; b < nB; b++) {
    const i0 = randInt(1, Math.max(1, pts.length - 2));
    let bx2 = pts[i0].x, by2 = pts[i0].y;
    let a2 = ang + rand(-1.3, 1.3);
    const bp = [{ x: bx2, y: by2 }];
    const bn = randInt(2, 4);
    for (let i = 0; i < bn; i++) {
      a2 += rand(-0.55, 0.55);
      bx2 += Math.cos(a2) * segLen * 0.62;
      by2 += Math.sin(a2) * segLen * 0.62;
      bp.push({ x: bx2, y: by2 });
    }
    branches.push(bp);
  }
  return { pts: pts, branches: branches, age: 0, life: B.life, power: power };
}

function cloudBurst(s, x, y, power) {
  const B = CONFIG.burst;

  // 云体稀释炸开
  for (let i = 0; i < s.pool.length; i++) {
    const p = s.pool[i];
    if (p.kind !== 'cloud' && p.kind !== 'updraft') continue;
    const dx = p.x - x, dy = p.y - y;
    const d = Math.sqrt(dx * dx + dy * dy) + 1;
    const f = 260 + 420 * power;
    p.vx += (dx / d) * f * (0.5 + Math.random() * 0.8);
    p.vy += (dy / d) * f * (0.5 + Math.random() * 0.8) - 40 * Math.random();
    p.rTarget *= B.expand;
    p.densityTarget *= 0.35;
    p.alphaTarget *= 0.75;
    p.evapT = Math.min(p.evapT, 0.4);
    p.age = Math.max(p.age, p.condT + p.stableT * 0.55);
  }

  // 膨胀云环
  const nRing = randInt(B.ringMin, B.ringMax);
  const ringR = B.ringR0;
  const targetR = B.ringR1 + B.ringPower * power;
  for (let i = 0; i < nRing; i++) {
    const a = (i / nRing) * 6.283185 + rand(-0.08, 0.08);
    const spd = (targetR - ringR) / B.ringLife * rand(0.85, 1.15);
    spawnBlob(s, {
      x: x + Math.cos(a) * ringR,
      y: y + Math.sin(a) * ringR,
      vx: Math.cos(a) * spd,
      vy: Math.sin(a) * spd * 0.7,
      r: rand(22, 52),
      alpha: rand(0.09, 0.18),
      density: rand(0.14, 0.30),
      color: Math.random() < 0.6 ? 'cloudTop' : 'cloudWaist',
      kind: 'ring',
      condT: 0.06,
      stableT: 0.10,
      evapT: B.ringLife - 0.16
    });
  }

  // 降雨 / 冰雹
  const nDrop = Math.floor(B.dropBase + B.dropPower * power);
  const groundBase = y + rand(B.groundMin, B.groundMax);
  for (let i = 0; i < nDrop; i++) {
    const sx = x + gaussian() * (60 + 90 * power);
    const sy = y + gaussian() * 22;
    s.drops.push({
      x: sx, y: sy,
      vx: gaussian() * 40,
      vy: B.dropSpeed + B.dropSpeedPower * power * (0.65 + Math.random() * 0.5),
      len: rand(4, 10),
      life: 1.6,
      ground: groundBase + gaussian() * 30,
      splash: false,
      color: Math.random() < 0.5 ? 'boltGlow' : 'boltCore'
    });
  }

  // 冲击扰动：拖尾光斑被径向拉伸
  for (let i = 0; i < s.pool.length; i++) {
    const p = s.pool[i];
    if (p.kind !== 'trail' && p.kind !== 'puff' && p.kind !== 'mist') continue;
    const dx = p.x - x, dy = p.y - y;
    const d = Math.sqrt(dx * dx + dy * dy) + 1;
    if (d > 620) continue;
    applyStretch(p, 1 + 2.6 * (1 - d / 620), Math.atan2(dy, dx), 0.3);
  }

  // 余韵散雾
  for (let i = 0; i < 22; i++) {
    const a = Math.random() * 6.283185;
    const rr = rand(20, 130);
    spawnBlob(s, {
      x: x + Math.cos(a) * rr,
      y: y + Math.sin(a) * rr * 0.7,
      vx: Math.cos(a) * rand(10, 40),
      vy: -rand(4, 22),
      r: rand(40, 95),
      alpha: rand(0.028, 0.055),
      density: rand(0.12, 0.26),
      color: Math.random() < 0.5 ? 'cloudWaist' : 'cloudBelly',
      kind: 'residue',
      condT: 0.3,
      stableT: rand(0.6, 1.3),
      evapT: 0.9
    });
  }

  // 后续小雨
  after(s, 0.4, function () {
    const n = Math.floor(18 + 40 * power);
    for (let i = 0; i < n; i++) {
      s.drops.push({
        x: x + gaussian() * 80,
        y: y + gaussian() * 30,
        vx: gaussian() * 30,
        vy: rand(240, 460),
        len: rand(4, 9),
        life: 1.4,
        ground: groundBase + gaussian() * 30,
        splash: false,
        color: 'boltGlow'
      });
    }
  });
}

/* ==================================================================
   右键 —— 浓雾
   ================================================================== */
function emitMist(s, dt) {
  const R = s.right;
  const M = s.input;
  const C = CONFIG.mist;
  const prog = clamp(R.t / CONFIG.chargeMax, 0, 1);
  const maxR = lerp(C.radiusMin, C.radiusMax, prog);
  const vHalf = lerp(C.vHalfMin, C.vHalfMax, prog);
  const sink = lerp(C.sink0, C.sink1, prog);

  R.cx += (M.x - R.cx) * Math.min(1, dt * 8);
  R.cy = R.cx * 0 + (M.y + sink);
  R.maxR = maxR;

  // 微震（以水平为主）
  let sh = 0;
  if (prog > 0.55) sh = (prog - 0.55) / 0.45 * 2.2;
  const cxx = R.cx + (Math.random() - 0.5) * 2 * sh * 1.4;
  const cyy = R.cy + (Math.random() - 0.5) * 2 * sh * 0.5;

  R.px = cxx;
  R.py = cyy;

  const nSec = R.sectors.length;

  R.acc += dt * (C.rate + 55 * prog);
  while (R.acc >= 1) {
    R.acc -= 1;

    const si = randInt(0, nSec - 1);
    const sec = R.sectors[si];
    const ang = (si / nSec) * 6.283185 + sec.ph * 0.3;
    const kk = sec.k * (1 + 0.18 * Math.sin(R.t * sec.sp + sec.ph));
    const rr = Math.pow(Math.random(), 0.62) * maxR * kk;
    const nr = clamp(rr / maxR, 0, 1.2);

    // 雾中暗区
    let dim = 1;
    if (R.t > C.holeStart) {
      const holeK = clamp((R.t - C.holeStart) / 1.0, 0, 1);
      const hv = 0.42 + 0.58 * Math.abs(Math.sin(ang * 2.3 + R.t * 0.75 + sec.ph * 1.7));
      dim = lerp(1, hv, holeK);
    }

    let dens;
    if (nr < 0.35) dens = 0.45 + 0.45 * (nr / 0.35);
    else if (nr < 0.62) dens = 0.90 - 0.35 * (nr - 0.35) / 0.27;
    else dens = Math.max(0, 0.55 * (1 - (nr - 0.62) / 0.38));
    dens *= dim;

    const ex = Math.cos(ang) * rr;
    const ey = Math.sin(ang) * rr * (vHalf / maxR);
    const x = cxx + ex;
    const y = cyy + ey;

    // 暖色透光
    if (nr > 0.68 && Math.random() < C.goldChance) {
      spawnBlob(s, {
        x: x, y: y,
        r: rand(30, 62),
        alpha: rand(0.05, 0.10),
        density: rand(0.10, 0.22),
        color: 'mistGold',
        kind: 'mist',
        condT: 0.4, stableT: rand(0.3, 0.8), evapT: 0.8
      });
      continue;
    }

    // 流雾丝缕
    if (Math.random() < C.strandChance) {
      const sa = ang + Math.PI * 0.5 + rand(-0.7, 0.7);
      spawnBlob(s, {
        x: x, y: y,
        vx: Math.cos(sa) * rand(8, 24),
        vy: Math.sin(sa) * rand(4, 14),
        r: rand(11, 24),
        alpha: rand(0.05, 0.11),
        density: rand(0.20, 0.42),
        color: 'mistWhite',
        kind: 'mist',
        sx: rand(5, 9), sy: 1, rot: sa,
        condT: 0.25,
        stableT: rand(0.9, 1.8),
        evapT: 0.7
      });
      continue;
    }

    let col;
    if (dens > 0.68) col = Math.random() < 0.42 ? 'mistPurple' : 'mistCyan';
    else if (dens > 0.42) col = Math.random() < 0.5 ? 'mistBlue' : 'mistGray';
    else col = Math.random() < 0.55 ? 'mistGray' : 'mistWhite';

    const lay = layerPick();
    const rad = rand(lay.rMin, lay.rMax);
    const al = rand(lay.aMin, lay.aMax);

    spawnBlob(s, {
      x: x, y: y,
      vx: Math.cos(ang) * rand(6, 22),
      vy: Math.sin(ang) * rand(2, 8) - rand(0, 6),
      r: rad, alpha: al, density: dens,
      color: col, kind: 'mist',
      condT: 0.3,
      stableT: rand(0.7, 1.7),
      evapT: 0.8
    });
  }

  // 拖尾被同化
  for (let i = 0; i < s.pool.length; i++) {
    const p = s.pool[i];
    if (p.kind !== 'trail') continue;
    const dx = p.x - cxx, dy = (p.y - cyy) / Math.max(0.25, vHalf / maxR);
    if (dx * dx + dy * dy > maxR * maxR) continue;
    p.kind = 'mist';
    p.color = 'mistGray';
    p.densityTarget = Math.min(0.7, p.densityTarget + 0.22);
  }
}

function releaseRight(s) {
  const R = s.right;
  s.right = null;
  if (!R) return;

  if (R.t < CONFIG.chargeMinClick) {
    // 小规模：一小团雾快速推进 80px 后消散
    const dir = lastDir(s);
    const n = 14;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283185;
      const rr = Math.abs(gaussian()) * 18;
      spawnBlob(s, {
        x: R.cx + Math.cos(a) * rr,
        y: R.cy + Math.sin(a) * rr * 0.4,
        vx: dir.x * 140 + Math.cos(a) * 30,
        vy: dir.y * 140 + Math.sin(a) * 14,
        r: rand(26, 58),
        alpha: rand(0.05, 0.10),
        density: rand(0.20, 0.45),
        color: Math.random() < 0.5 ? 'mistGray' : 'mistBlue',
        kind: 'mist',
        condT: 0.12, stableT: 0.2, evapT: 0.6
      });
    }
    return;
  }

  const power = Math.pow(clamp(R.t, 0, CONFIG.chargeMax) / CONFIG.chargeMax, 1.6);
  const dir = lastDir(s);
  const W2 = CONFIG.wall;

  s.wall = {
    t: 0,
    dur: W2.dur,
    dirX: dir.x, dirY: dir.y,
    speed: W2.speedBase + W2.speedPower * power,
    dist: 0,
    target: W2.distBase + W2.distPower * power,
    ox: R.cx, oy: R.cy,
    fired: false,
    power: power,
    lastTrail: 0
  };

  // 雾体整体获得推进速度
  for (let i = 0; i < s.pool.length; i++) {
    const p = s.pool[i];
    if (p.kind !== 'mist') continue;
    p.vx += dir.x * (W2.speedBase + W2.speedPower * power) * 0.85;
    p.vy += dir.y * (W2.speedBase + W2.speedPower * power) * 0.85 - 20;
    p.stableT = Math.max(p.stableT, 0.9);
    applyStretch(p, 1.9, Math.atan2(dir.y, dir.x), 0.6);
  }

  // 拖尾沿推进方向被拉伸
  for (let i = 0; i < s.pool.length; i++) {
    const p = s.pool[i];
    if (p.kind !== 'trail' && p.kind !== 'puff') continue;
    applyStretch(p, 2.4, Math.atan2(dir.y, dir.x), 0.4);
  }
}

// 推进方向：取最近 0.15s 光标轨迹的首尾差；位移太小则随机
function lastDir(s) {
  const h = s.history;
  if (h.length >= 2) {
    const a = h[0], b = h[h.length - 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > 6) return { x: dx / d, y: dy / d };
  }
  const a = Math.random() * 6.283185;
  return { x: Math.cos(a), y: Math.sin(a) * 0.45 };
}

function updateWall(s, dt) {
  const w = s.wall;
  if (!w) return;
  w.t += dt;

  const active = w.t < w.dur;
  const push = w.speed * dt;

  if (active) {
    w.dist += push;
    for (let i = 0; i < s.pool.length; i++) {
      const p = s.pool[i];
      if (p.kind !== 'mist') continue;
      p.x += w.dirX * push;
      p.y += w.dirY * push;
    }

    // 推进中沿途留下雾迹
    w.lastTrail += push;
    if (w.lastTrail > 26) {
      w.lastTrail = 0;
      const px = w.ox + w.dirX * w.dist + gaussian() * 40;
      const py = w.oy + w.dirY * w.dist + gaussian() * 26;
      for (let i = 0; i < 3; i++) {
        spawnBlob(s, {
          x: px + gaussian() * 30,
          y: py + gaussian() * 16,
          r: rand(34, 72),
          alpha: rand(0.035, 0.075),
          density: rand(0.14, 0.30),
          color: Math.random() < 0.6 ? 'mistGray' : 'mistBlue',
          kind: 'mist',
          condT: 0.2,
          stableT: rand(1.0, 1.9),
          evapT: 0.7
        });
      }
    }

    // 前缘压缩
    const fx = w.ox + w.dirX * w.dist;
    const fy = w.oy + w.dirY * w.dist;
    for (let i = 0; i < 2; i++) {
      spawnBlob(s, {
        x: fx + gaussian() * 70 - w.dirY * gaussian() * 34,
        y: fy + gaussian() * 22 - w.dirX * gaussian() * 34,
        vx: w.dirX * w.speed * 0.5,
        vy: w.dirY * w.speed * 0.5,
        r: rand(30, 68),
        alpha: rand(0.05, 0.11),
        density: rand(0.42, 0.72),
        color: Math.random() < 0.5 ? 'mistWhite' : 'mistGray',
        kind: 'mist',
        condT: 0.12,
        stableT: rand(0.35, 0.7),
        evapT: 0.55
      });
    }

    // 前缘分离的小雾团
    if (Math.random() < dt * 14) {
      const ang = Math.atan2(w.dirY, w.dirX) + rand(-0.7, 0.7);
      spawnBlob(s, {
        x: fx + gaussian() * 30,
        y: fy + gaussian() * 18,
        vx: Math.cos(ang) * rand(180, 340),
        vy: Math.sin(ang) * rand(90, 180),
        r: rand(16, 34),
        alpha: rand(0.06, 0.12),
        density: rand(0.35, 0.60),
        color: 'mistWhite',
        kind: 'mist',
        condT: 0.1, stableT: rand(0.3, 0.7), evapT: 0.6
      });
    }
  }

  if (!w.fired && w.dist >= w.target * 0.94) {
    w.fired = true;
    mistBurst(s, w);
  }

  if (w.t > w.dur + 0.9) s.wall = null;
}

function mistBurst(s, w) {
  const W2 = CONFIG.wall;
  const p = w.power;
  const fx = w.ox + w.dirX * w.dist;
  const fy = w.oy + w.dirY * w.dist;

  const n = Math.floor(W2.burstBase + W2.burstPower * p);
  const spd = W2.burstSpeedBase + W2.burstSpeedPower * p;

  for (let i = 0; i < n; i++) {
    const a = Math.atan2(w.dirY, w.dirX) + gaussian() * 1.0;
    const s2 = spd * rand(0.5, 1.2);
    const col = Math.random() < 0.35 ? 'mistWhite'
              : (Math.random() < 0.5 ? 'mistGray' : (Math.random() < 0.5 ? 'mistBlue' : 'mistCyan'));
    spawnBlob(s, {
      x: fx + gaussian() * 34,
      y: fy + gaussian() * 18,
      vx: Math.cos(a) * s2,
      vy: Math.sin(a) * s2 * 0.55 - rand(20, 90),
      r: rand(22, 58),
      alpha: rand(0.06, 0.14),
      density: rand(0.20, 0.55),
      color: col,
      kind: 'mist',
      condT: 0.08,
      stableT: rand(0.5, 1.2),
      evapT: 0.75
    });
  }

  // 回流
  for (let i = 0; i < W2.backFlow; i++) {
    const a = Math.atan2(w.dirY, w.dirX) + Math.PI + gaussian() * 0.9;
    spawnBlob(s, {
      x: fx + gaussian() * 40,
      y: fy + gaussian() * 22,
      vx: Math.cos(a) * rand(90, 220),
      vy: Math.sin(a) * rand(40, 110),
      r: rand(26, 60),
      alpha: rand(0.035, 0.075),
      density: rand(0.14, 0.30),
      color: Math.random() < 0.6 ? 'mistBlue' : 'mistPurple',
      kind: 'mist',
      condT: 0.15,
      stableT: rand(0.5, 1.1),
      evapT: 0.8
    });
  }

  // 余韵：缓慢上升的极淡雾团
  for (let i = 0; i < 10; i++) {
    spawnBlob(s, {
      x: fx + gaussian() * 70,
      y: fy + gaussian() * 30,
      vy: -rand(6, 22),
      r: rand(40, 80),
      alpha: rand(0.03, 0.06),
      density: rand(0.10, 0.22),
      color: 'mistGray',
      kind: 'mist',
      condT: 0.3,
      stableT: rand(0.7, 1.4),
      evapT: 0.9
    });
  }
}

/* ==================================================================
   粒子更新
   ================================================================== */
function updateParticles(s, dt) {
  const T = CONFIG.turb;
  const frozen = s.freeze > 0;
  const tv = s.tv;

  for (let i = 0; i < s.pool.length; i++) {
    const p = s.pool[i];
    p.age += dt;

    const cT = p.condT, sT = p.stableT, eT = p.evapT;

    if (p.age < cT) {
      const k = smoothstep(p.age / cT);
      p.r = p.rTarget * k;
      p.alpha = p.alphaTarget * k;
      p.density = p.densityTarget * k;
    } else if (p.age < cT + sT) {
      p.r = p.rTarget;
      p.alpha = p.alphaTarget;
      p.density = p.densityTarget;
    } else {
      const k = clamp((p.age - cT - sT) / eT, 0, 1);
      p.r = p.rTarget * (1 + 0.35 * k);
      p.alpha = p.alphaTarget * (1 - k);
      p.density = p.densityTarget * (1 - k);
      if (k >= 1) { p.dead = true; continue; }
    }

    if (p.stretchT > 0) {
      p.stretchT -= dt;
      const k = Math.max(0, p.stretchT / p.stretchDur);
      const amt = 1 + (p.stretchMax - 1) * k;
      p.stretchX = amt;
      p.stretchY = 1 / Math.sqrt(amt);
    } else if (p.stretchX !== 1) {
      p.stretchX = 1;
      p.stretchY = 1;
    }

    if (frozen) continue;

    // 湍流场驱动
    const ts = p.turbScale;
    turbulence(p.x, p.y, s.time * ts, tv);
    p.vx += (tv.vx - p.vx) * T.follow * dt;
    p.vy += (tv.vy - p.vy) * T.follow * dt;

    if (p.rise) p.vy -= p.rise * dt;
    if (p.grav) p.vy += p.grav * dt;

    // 气旋扰动
    if (p.spinUntil > s.time) {
      const dx = p.x - p.cx, dy = p.y - p.cy;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.001;
      const fall = Math.max(0, 1 - d / CONFIG.vortex.radius);
      const tan = p.spin * fall * fall;
      p.vx += (-dy / d) * tan * dt;
      p.vy += (dx / d) * tan * dt;
      p.vx += (dx / d) * tan * 0.16 * dt;
      p.vy += (dy / d) * tan * 0.16 * dt;
    }

    // 云体吸引
    if (p.attract && p.attractUntil > s.time) {
      const dx = p.attract.x - p.x, dy = p.attract.y - p.y;
      const d = Math.sqrt(dx * dx + dy * dy) + 1;
      if (d < 420) {
        const f = (1 - d / 420) * p.attract.f;
        p.vx += (dx / d) * f * dt;
        p.vy += (dy / d) * f * dt;
      }
    }

    // 拖尾之间极弱聚拢（同源感）
    if (p.kind === 'trail' && Math.random() < 0.02) {
      p.vx *= 0.995;
      p.vy *= 0.995;
    }

    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }

  // 回收
  let w = 0;
  for (let i = 0; i < s.pool.length; i++) {
    const p = s.pool[i];
    if (p.dead) continue;
    s.pool[w++] = p;
  }
  s.pool.length = w;
}

/* ==================================================================
   雨滴 / 闪电 / 电荷纹路 / 辉光
   ================================================================== */
function updateDrops(s, dt) {
  for (let i = s.drops.length - 1; i >= 0; i--) {
    const d = s.drops[i];
    d.life -= dt;
    if (d.life <= 0) { s.drops.splice(i, 1); continue; }
    d.vy += (d.splash ? 120 : 900) * dt;
    d.x += d.vx * dt;
    d.y += d.vy * dt;

    if (!d.splash && d.y >= d.ground) {
      // 溅开
      for (let k = 0; k < 4; k++) {
        s.drops.push({
          x: d.x, y: d.y,
          vx: (Math.random() < 0.5 ? -1 : 1) * rand(40, 160),
          vy: -rand(20, 90),
          len: rand(2, 5),
          life: 0.22,
          ground: 1e9,
          splash: true,
          color: d.color
        });
      }
      s.drops.splice(i, 1);
      continue;
    }
  }
}

function updateBolts(s, dt) {
  for (let i = s.bolts.length - 1; i >= 0; i--) {
    const b = s.bolts[i];
    b.age += dt;
    if (b.age >= b.life) s.bolts.splice(i, 1);
  }
}

function updateChargeLines(s, dt) {
  for (let i = s.chargeLines.length - 1; i >= 0; i--) {
    const c = s.chargeLines[i];
    c.life -= dt;
    if (c.life <= 0) s.chargeLines.splice(i, 1);
  }
}

function updateGlow(s, dt) {
  for (let i = s.glow.length - 1; i >= 0; i--) {
    const g = s.glow[i];
    g.life -= dt;
    if (g.life <= 0) { s.glow.splice(i, 1); continue; }
    const k = 1 - g.life / g.maxLife;
    g.r = lerp(g.r, g.rMax, Math.min(1, dt * 6 + k * 0.06));
    g.alpha *= (1 - dt / Math.max(0.0001, g.maxLife));
  }
}

/* ==================================================================
   渲染
   ================================================================== */
function drawBlob(ctx, TEX, p, mode) {
  let sx = p.sx * p.stretchX;
  let sy = p.sy * p.stretchY;
  const rot = p.rot + p.stretchRot;
  const r = p.r;
  if (r <= 0.2) return;

  const texR = r * Math.max(sx, sy);
  const tex = texFor(TEX, p.color, texR);

  let a = p.alpha;
  if (mode === 'dark') a *= 0.9;
  ctx.globalAlpha = a < 0 ? 0 : (a > 1 ? 1 : a);

  if (sx === 1 && sy === 1 && rot === 0) {
    ctx.drawImage(tex, p.x - r, p.y - r, r * 2, r * 2);
  } else {
    const w = r * 2 * sx;
    const h = r * 2 * sy;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(rot);
    ctx.drawImage(tex, -w * 0.5, -h * 0.5, w, h);
    ctx.restore();
  }
}

function strokeBoltPaths(ctx, b) {
  ctx.beginPath();
  const pts = b.pts;
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();

  for (let i = 0; i < b.branches.length; i++) {
    const br = b.branches[i];
    ctx.beginPath();
    ctx.moveTo(br[0].x, br[0].y);
    for (let j = 1; j < br.length; j++) ctx.lineTo(br[j].x, br[j].y);
    ctx.stroke();
  }
}

// 每帧绘制（类里的 render 钩子转调这里）
function drawFrame(s) {
  const ctx = s.ctx;
  const W = s.W, H = s.H;

  // 画布缓冲与 DPR 缩放由基类维护，这里统一使用 CSS 像素坐标。
  // 原型在此处就是 clearRect（深色背景由页面 CSS 提供），
  // 移植后同样不铺任何整屏底色，保证光标层透明。
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, W, H);

  // ---- 加色层（density < 0.55）----
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < s.pool.length; i++) {
    const p = s.pool[i];
    if (p.density < 0.55) drawBlob(ctx, s.TEX, p, 'add');
  }

  // ---- 压暗层（density > 0.45）----
  ctx.globalCompositeOperation = 'source-over';
  for (let i = 0; i < s.pool.length; i++) {
    const p = s.pool[i];
    if (p.density > 0.45) drawBlob(ctx, s.TEX, p, 'dark');
  }

  // ---- 大范围辉光 / 气压波 ----
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < s.glow.length; i++) {
    const g = s.glow[i];
    const a = clamp(g.alpha * (g.life / g.maxLife), 0, 1);
    ctx.globalAlpha = a;
    const tex = texFor(s.TEX, g.color, g.r);
    ctx.drawImage(tex, g.x - g.r, g.y - g.r, g.r * 2, g.r * 2);
  }

  // ---- 电荷纹路 ----
  if (s.chargeLines.length) {
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(168,216,255,1)';
    for (let i = 0; i < s.chargeLines.length; i++) {
      const c = s.chargeLines[i];
      const k = c.life / c.maxLife;
      const wave = 0.6 + 0.4 * Math.sin(s.time * 30 + i);
      ctx.globalAlpha = 0.12 * k * wave;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(c.x + c.dx, c.y + c.dy);
      ctx.stroke();

      ctx.globalAlpha = 0.42 * k * wave;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(c.x + c.dx, c.y + c.dy);
      ctx.stroke();
    }
  }

  // ---- 闪电 ----
  if (s.bolts.length) {
    for (let i = 0; i < s.bolts.length; i++) {
      const b = s.bolts[i];
      const k = 1 - b.age / b.life;
      const blink = (Math.floor(b.age * 70) % 2 === 0) ? 1 : 0.32;
      const alpha = k * blink;

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // 外圈青色辉光
      ctx.globalAlpha = alpha * CONFIG.bolt.glowAlpha;
      ctx.strokeStyle = CONFIG.colors.boltGlow;
      ctx.lineWidth = CONFIG.bolt.glowWidth;
      strokeBoltPaths(ctx, b);

      // 内圈纯白核心
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = CONFIG.colors.boltCore;
      ctx.lineWidth = CONFIG.bolt.coreWidth;
      strokeBoltPaths(ctx, b);
    }
  }

  // ---- 雨滴 ----
  if (s.drops.length) {
    ctx.lineCap = 'round';
    for (let i = 0; i < s.drops.length; i++) {
      const d = s.drops[i];
      const a = clamp(d.life * 2.2, 0, 1);
      ctx.globalAlpha = a * 0.65;
      ctx.strokeStyle = CONFIG.colors[d.color];
      ctx.lineWidth = d.splash ? 1 : 1.4;
      const len = d.len;
      const sp = Math.sqrt(d.vx * d.vx + d.vy * d.vy) + 0.001;
      ctx.beginPath();
      ctx.moveTo(d.x, d.y);
      ctx.lineTo(d.x - (d.vx / sp) * len, d.y - (d.vy / sp) * len);
      ctx.stroke();
    }
  }

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

/* ==================================================================
   组件
   ================================================================== */
export class CursorMist extends CursorEffectElement {
  /**
   * 滚轮动效：雾团缓慢散开并变淡，几乎没有初速，靠膨胀铺开。
   */
  wheelTheme() {
    return {
      style: 'puff',
      color:  [184, 200, 220],
      color2: [220, 232, 245],
      sizeMin: 5, sizeMax: 13,
      lifeMin: 0.9, lifeMax: 1.8,
      upSpeed: 70,
      downSpeed: 60,
      spread: 60,
      drag: 2.6,             // 很快停下
      turbulence: 22,
      grow: 16,              // 主要靠膨胀
      jitter: 18
    };
  }

  /** 主题光标：灰蓝描边 + 寒气装饰 */
  cursorTheme() {
    return {
      edge: '#b8c8dc',
      fill: 'rgba(20, 26, 36, .88)',
      glow: '#9fb4cc',
      deco: { color: [184, 200, 220], style: 'cold', rate: 12, speedGain: 0.18 }
    };
  }

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
    // 拖尾生成量会和原型不同。
    input.x = input.lx = width * 0.5;
    input.y = input.ly = height * 0.5;

    return {
      // 本实例的画布上下文（已按 DPR 缩放过，统一使用 CSS 像素坐标）
      ctx,

      // 画布尺寸（CSS 像素），由基类 onResize 同步
      W: width,
      H: height,

      input,

      // 离屏软光斑贴图（每个实例一份）
      TEX: buildTextures(canvas.ownerDocument),

      // 软光斑池
      pool: [],

      // 湍流场复用的输出对象（放在 state 里，多实例互不干扰）
      tv: { vx: 0, vy: 0 },

      // 全局时间（原型的 time）
      time: 0,

      // 左键蓄力 / 右键蓄力状态
      left: null,
      right: null,

      // 放电前静默
      freeze: 0,

      // 延迟任务 / 闪电 / 雨滴 / 电荷纹路 / 电离辉光 / 雾墙
      timers: [],
      bolts: [],
      drops: [],
      chargeLines: [],
      glow: [],
      wall: null,

      // 光标轨迹采样（供 lastDir 判定推进方向，见 update）
      history: []
    };
  }

  /* ==================================================================
     输入（按键）—— 鼠标位移与速度由基类维护，这里只处理左右键交互
     ================================================================== */
  onPointerDown(e) {
    const s = this.state;
    if (!s) return;

    // 原型以 mousedown 时的 mouse.x / mouse.y（最后一次 mousemove 的位置）作为原点，
    // 与基类的 input.x / input.y 语义一致
    const x = s.input.x, y = s.input.y;

    if (e.button === 0) {
      vortexBurst(s, x, y);
      s.left = {
        t: 0, x: x, y: y,
        flashAcc: 0, streakAcc: 0, spawnAcc: 0, upAcc: 0, shakeX: 0, shakeY: 0
      };
    } else if (e.button === 2) {
      s.right = {
        t: 0, x: x, y: y,
        acc: 0, sectors: null, cx: x, cy: y + 20, maxR: 40
      };
      const R = s.right;
      R.sectors = [];
      for (let i = 0; i < CONFIG.mist.sectors; i++) {
        R.sectors.push({
          ph: Math.random() * 6.283185,
          k: 1 + Math.random() * 0.26,
          sp: rand(0.15, 0.55)
        });
      }
    }
  }

  onPointerUp(e) {
    const s = this.state;
    if (!s) return;

    if (e.button === 0) {
      if (s.left) releaseLeft(s);
    } else if (e.button === 2) {
      if (s.right) releaseRight(s);
    }
  }

  // 失焦时按键状态已丢失，收尾全部蓄力（原型 window blur 的行为）
  onBlur() {
    const s = this.state;
    if (!s) return;
    s.left = null;
    s.right = null;
    s.wall = null;
    s.history.length = 0;
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
     主更新
     ================================================================== */
  update(dt, s) {
    if (!s) return;
    s.time += dt;

    // 光标轨迹采样：原型在 mousemove 里维护 history，基类不暴露原始事件，
    // 这里改为每帧采样一次。lastDir() 只关心首尾位移是否超过 6px，
    // 每帧一个采样点与原型的事件采样结果一致。
    const h = s.history;
    h.push({ x: s.input.x, y: s.input.y, t: s.time });
    while (h.length > 24 || (h.length && s.time - h[0].t > 0.15)) {
      h.shift();
    }

    // 延迟任务
    for (let i = s.timers.length - 1; i >= 0; i--) {
      const t = s.timers[i];
      t.t -= dt;
      if (t.t <= 0) {
        t.fn();
        s.timers.splice(i, 1);
      }
    }

    if (s.freeze > 0) s.freeze -= dt;

    // 左键蓄力
    if (s.left) {
      s.left.t += dt;
      emitCloud(s, dt);
    }

    // 右键蓄力
    if (s.right) {
      s.right.t += dt;
      emitMist(s, dt);
    }

    // 拖尾
    emitTrail(s, dt);

    // 雾墙推进
    updateWall(s, dt);

    // 粒子
    updateParticles(s, dt);

    // 其它
    updateDrops(s, dt);
    updateBolts(s, dt);
    updateChargeLines(s, dt);
    updateGlow(s, dt);
  }

  render(s) {
    if (!s) return;
    drawFrame(s);
  }
}

if (!customElements.get('cursor-mist')) {
  customElements.define('cursor-mist', CursorMist);
}

export default CursorMist;
