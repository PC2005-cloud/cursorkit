/**
 * cursor-cell —— 鼠标光标细胞动效（左键分裂繁殖 / 右键吞噬消化）。
 *
 * 由 html/细胞.html 原型移植：算法流程、数值、视觉表现与原文件一一对应。
 * 作为光标层组件，原型页面自身的行为已剔除：
 *   - 原型在 JS 里自建主画布并挂到 body（原第 198~201 行
 *     `const canvas = document.createElement('canvas'); document.body.appendChild(canvas);`），
 *     移植后主画布由基类提供，这两行已删除；本动效不创建、不挂载任何主画布，
 *     也不需要离屏画布（全程直接画在主上下文上）；
 *   - 原型 body 的深色底 #04050a 是页面 CSS 背景，绘制里本来就只有 clearRect
 *     （原第 1963 行），没有任何整屏铺底，因此 render() 保持 clearRect，
 *     绝不覆盖宿主页面；
 *   - 不拦截 contextmenu（原第 1405 行已删），宿主页面的右键菜单不受影响，基类统一处理；
 *   - 原型的 window resize 监听与画布尺寸/DPR 逻辑（原第 205~216 行）→ onResize()；
 *   - 画布创建、DPR 适配、监听注册、rAF 循环全部由基类负责。
 *
 * 原型监听 mousemove / mousedown / mouseup，因此声明 inputFamily = 'mouse'。
 * 所有运行状态都放在 setup() 返回的 state 上，多实例互不干扰。
 */

import { CursorEffectElement } from '../core/base.js';
import { TAU, clamp, lerp, rand, randInt, mixColor } from '../core/utils.js';

/* ============================================================
   全局配置 CONFIG —— 所有可调参数集中于此
   ============================================================ */
const CONFIG = {
  /* ---- 配色：两套严格区分 ---- */
  colors: {
    left: {
      membrane:  '#4FE3FF',
      cytoplasm: '#7AC8E0',
      nucleus:   '#9B5CFF',
      nucleolus: '#FF4FD8',
      organelle: '#3DFFD0'
    },
    right: {
      membrane:  '#FF5CD8',
      cytoplasm: '#FF8C1A',
      nucleus:   '#C41E3A',
      nucleolus: '#FFFFFF',
      organelle: '#8A5CFF',
      engulfed:  '#8A5CFF',
      digest:    '#FFD24A'
    }
  },

  /* ---- 细胞基础参数 ---- */
  cell: {
    minRadius:     6,
    maxRadius:     50,
    matureMin:     30,
    matureMax:     50,
    growRateMin:   8,
    growRateMax:   15,
    lifeMin:       6,
    lifeMax:       11,
    apoptosisTime: 1.4,
    /* 分裂硬限制：低于此半径不再分裂；超过此代数不再分裂 */
    minDivideRadius: 6,
    maxGeneration:   5
  },

  /* ---- 分裂（拉长 → 收窄 → 断裂） ---- */
  division: {
    duration:       0.6,
    stretchEnd:     0.4,
    pinchEnd:       0.75,
    childRatio:     0.7,
    childSpeedMin:  80,
    childSpeedMax:  150,
    fastDuration:   0.15
  },

  /* ---- 左键：分裂繁殖（指数增长） ---- */
  fission: {
    seedRadius:     8,
    seedGrowRate:   20,
    seedMature:     40,
    maxCount:       26,
    clusterRadius:  180,
    chargeMax:      2.5,
    powerExp:       1.6,
    burstSpeedBase: 200,
    burstSpeedScale:600,
    shatterChance:  0.2,
    ringBase:       150,
    ringScale:      400,
    /* 爆散后子细胞寿命范围 */
    burstLifeMin:   2.5,
    burstLifeMax:   5.0
  },

  /* ---- 右键：吞噬消化 ---- */
  phagocytosis: {
    phagoStartRadius: 12,
    phagoMaxRadius:   60,
    preyRadiusMin:    4,
    preyRadiusMax:    10,
    preyMaxCount:     20,
    preySpawnMin:     80,
    preySpawnMax:     150,
    preyAttract:      70,
    pseudopodRange:   120,
    pseudopodMax:     3,
    extendDur:        0.3,
    wrapDur:          0.2,
    retractDur:       0.2,
    digestMin:        0.5,
    digestMax:        1.0,
    burstRingBase:    120,
    burstRingScale:   350
  },

  /* ---- 拖尾 ---- */
  trail: {
    spacing:   26,
    radiusMin: 4,
    radiusMax: 10,
    growRate:  7,
    matureMin: 10,
    matureMax: 16,
    lifeMin:   3,
    lifeMax:   6
  },

  /* ---- 有丝分裂波（点击冲击） ---- */
  mitosisWave: {
    radius:         250,
    duration:       0.3,
    minSplitRadius: 5
  },

  /* ---- 碰撞空间网格 ---- */
  gridSize: 80,

  /* ---- 细胞对象池上限 ---- */
  maxCells: 220,

  /* ---- 粒子上限 ---- */
  maxParts: 520
};

/* ============================================================
   基础工具
   （数学函数取自 core/utils.js，不重复定义；hex 解析与串化原型自带，保留）
   ============================================================ */
const easeOut = t => 1 - Math.pow(1 - t, 3);

const RGB_CACHE = Object.create(null);

/* hex → [r, g, b]（带缓存；数组形态是为了直接喂给 utils 的 mixColor） */
function rgbOf(hex) {
  let c = RGB_CACHE[hex];
  if (c) return c;
  const h = hex.charCodeAt(0) === 35 ? hex.slice(1) : hex;
  c = [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16)
  ];
  RGB_CACHE[hex] = c;
  return c;
}

function rgbStr(hex) {
  const c = rgbOf(hex);
  return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
}

function rgbaStr(hex, a) {
  const c = rgbOf(hex);
  return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
}

/* 通道混合交给 utils 的 mixColor，这里只负责 hex 解析与结果串化 */
function mixHex(a, b, t) {
  const m = mixColor(rgbOf(a), rgbOf(b), t);
  const h = v => {
    const n = Math.round(clamp(v, 0, 255)).toString(16);
    return n.length < 2 ? '0' + n : n;
  };
  return '#' + h(m[0]) + h(m[1]) + h(m[2]);
}

/* 常用色预计算（原型 PAL：cyto / nuc 两项原文中从未被读取，为对齐原文件保留） */
const PAL = {
  L: {
    mem: rgbStr(CONFIG.colors.left.membrane),
    cyto: rgbStr(CONFIG.colors.left.cytoplasm),
    nuc: rgbStr(CONFIG.colors.left.nucleus),
    nlo: rgbStr(CONFIG.colors.left.nucleolus),
    org: rgbStr(CONFIG.colors.left.organelle)
  },
  R: {
    mem: rgbStr(CONFIG.colors.right.membrane),
    cyto: rgbStr(CONFIG.colors.right.cytoplasm),
    nuc: rgbStr(CONFIG.colors.right.nucleus),
    nlo: rgbStr(CONFIG.colors.right.nucleolus),
    org: rgbStr(CONFIG.colors.right.organelle),
    digest: rgbStr(CONFIG.colors.right.digest)
  }
};

/* ============================================================
   细胞膜波动系统（采样表预计算）
   ============================================================ */
const MEM_N = 10;
const MEM_INV = TAU / MEM_N;
const MEM_COS = new Float32Array(MEM_N);
const MEM_SIN = new Float32Array(MEM_N);
(function fillMembraneTable() {
  for (let i = 0; i < MEM_N; i++) {
    MEM_COS[i] = Math.cos(i * MEM_INV);
    MEM_SIN[i] = Math.sin(i * MEM_INV);
  }
})();

const PART_MAX = CONFIG.maxParts;
const GRID = CONFIG.gridSize;

/* ============================================================
   细胞质径向渐变缓存
   ============================================================ */
/* 原型把渐变缓存放在模块级（原第 221 行），但它持有 ctx 创建的渐变对象，
   移植后必须挂到 state 上，否则多实例会互相串用已失效的上下文。 */
function getCytoGrad(ctx, s, group, radius) {
  const rq = Math.max(2, Math.round(radius / 3) * 3);
  const cache = s.gradCache[group];
  let g = cache[rq];
  if (g) return g;
  const base = group === 0 ? CONFIG.colors.left : CONFIG.colors.right;
  const c0 = mixHex(base.cytoplasm, base.nucleus, 0.28);
  const c1 = mixHex(base.cytoplasm, '#ffffff', 0.20);
  g = ctx.createRadialGradient(0, 0, rq * 0.08, 0, 0, rq * 1.02);
  g.addColorStop(0, rgbaStr(c0, 0.30));
  g.addColorStop(0.55, rgbaStr(base.cytoplasm, 0.38));
  g.addColorStop(1, rgbaStr(c1, 0.50));
  cache[rq] = g;
  return g;
}

/* ============================================================
   细胞池
   ============================================================ */
function buildPalette(c) {
  const base = c.group === 0 ? CONFIG.colors.left : CONFIG.colors.right;
  const pal = c.group === 0 ? PAL.L : PAL.R;
  const tint = Math.min(c.gen * 0.05, 0.34);

  const mem = mixHex(base.membrane, '#ffffff', tint * 0.55);
  const cyt = mixHex(base.cytoplasm, '#ffffff', tint * 0.42);
  const nuc = mixHex(base.nucleus, '#ffffff', tint * 0.26);
  const orgB = mixHex(base.organelle, base.nucleolus, 0.5);

  c.s = {
    mem: rgbStr(mem),
    cyto: rgbStr(cyt),
    nuc: rgbStr(nuc),
    nucLine: rgbStr(mem),
    nlo: pal.nlo,
    orgA: pal.org,
    orgB: rgbStr(orgB),
    memHex: base.membrane
  };
}

function spawnCell(s, x, y, r, group, opts) {
  opts = opts || {};
  const c = s.freeCells.pop();
  if (!c) return null;

  c.dead = false;
  c.uid = ++s.uidCounter;
  c.x = x;
  c.y = y;
  c.vx = opts.vx || 0;
  c.vy = opts.vy || 0;
  c.dirX = 0;
  c.dirY = 0;
  c.dirT = rand(0, 1.5);

  c.r = opts.startR !== undefined ? opts.startR : r;
  c.rMax = opts.rMax !== undefined ? opts.rMax : Math.max(r, CONFIG.cell.minRadius);
  c.growRate = opts.growRate !== undefined ? opts.growRate
    : rand(CONFIG.cell.growRateMin, CONFIG.cell.growRateMax);

  c.group = group;
  c.state = 'grow';
  c.age = 0;
  c.life = opts.life !== undefined ? opts.life : rand(CONFIG.cell.lifeMin, CONFIG.cell.lifeMax);
  c.gen = opts.gen || 0;

  c.canDivide = !!opts.canDivide;
  c.inCluster = !!opts.inCluster;
  c.isPhago = !!opts.isPhago;
  c.isPrey = !!opts.isPrey;
  c.captured = false;
  c.burst = !!opts.burst;
  c.burstSpd = opts.burstSpd || 0;
  c.lastWave = -1;

  c.axis = opts.axis !== undefined ? opts.axis : rand(0, TAU);
  c.divT = 0;
  c.divDur = CONFIG.division.duration;
  c.apo = 0;

  c.wobbleAmp = opts.wobbleAmp !== undefined ? opts.wobbleAmp : rand(0.05, 0.09);
  c.phase = opts.phase !== undefined ? opts.phase : rand(0, TAU);
  c.nucPhase = rand(0, TAU);
  c.flowPhase = rand(0, TAU);
  c.flowN = randInt(2, 3);

  const cn = randInt(8, 11);
  const ctrl = new Array(cn);
  for (let i = 0; i < cn; i++) {
    ctrl[i] = { amp: rand(0.45, 1), phase: rand(0, TAU), freq: rand(0.9, 2.2) };
  }
  c.memCtrl = ctrl;

  const on = randInt(3, 7);
  const orgs = new Array(on);
  for (let i = 0; i < on; i++) {
    const a = rand(0, TAU);
    const d = Math.sqrt(Math.random()) * r * 0.6;
    orgs[i] = {
      x: Math.cos(a) * d,
      y: Math.sin(a) * d,
      vx: rand(-12, 12),
      vy: rand(-12, 12),
      r: rand(1, 2.6),
      grp: Math.random() < 0.6 ? 0 : 1
    };
  }
  c.orgs = orgs;

  c.nucX = 0;
  c.nucY = 0;
  c.scale = 0;
  c.spawnT = 0;
  c.digestPulse = 0;
  c.engulfedList = opts.isPhago ? [] : null;

  buildPalette(c);
  s.cells.push(c);
  return c;
}

/* ---- 强制让一个细胞进入凋亡（多处复用） ---- */
function apoptosisCell(c) {
  if (!c || c.dead || c.state === 'apoptosis') return;
  c.canDivide = false;
  c.inCluster = false;
  c.captured = false;
  c.state = 'apoptosis';
  c.apo = 0;
  for (let i = 0; i < c.orgs.length; i++) {
    const o = c.orgs[i];
    const a = Math.atan2(o.y, o.x) + rand(-0.6, 0.6);
    const s = rand(30, 100);
    o.vx = Math.cos(a) * s;
    o.vy = Math.sin(a) * s;
  }
}

/* ============================================================
   空间网格（碰撞检测）
   ============================================================ */
function gridKey(gx, gy) { return gx * 73856093 ^ gy * 19349663; }

function buildGrid(s) {
  const grid = s.grid;
  const cells = s.cells;
  grid.clear();
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const k = gridKey(Math.floor(c.x / GRID), Math.floor(c.y / GRID));
    let arr = grid.get(k);
    if (!arr) { arr = []; grid.set(k, arr); }
    arr.push(c);
  }
}

function resolveCollisions(s) {
  const cells = s.cells;
  const grid = s.grid;
  const n = cells.length;
  if (n < 2) return;
  for (let i = 0; i < n; i++) {
    const c = cells[i];
    if (c.isPhago || c.state === 'apoptosis' || c.dead) continue;
    const gx = Math.floor(c.x / GRID);
    const gy = Math.floor(c.y / GRID);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const arr = grid.get(gridKey(gx + ox, gy + oy));
        if (!arr) continue;
        for (let j = 0; j < arr.length; j++) {
          const o = arr[j];
          if (o === c || o.dead || o.isPhago) continue;
          if (o.uid <= c.uid) continue;
          if (o.state === 'apoptosis') continue;
          const dx = o.x - c.x;
          const dy = o.y - c.y;
          const rr = c.r + o.r;
          const d2 = dx * dx + dy * dy;
          if (d2 >= rr * rr || d2 < 0.0001) continue;
          const d = Math.sqrt(d2);
          const nx = dx / d;
          const ny = dy / d;
          const overlap = rr - d;
          const push = overlap * 0.25;
          c.x -= nx * push;
          c.y -= ny * push;
          o.x += nx * push;
          o.y += ny * push;
          const rel = (o.vx - c.vx) * nx + (o.vy - c.vy) * ny;
          if (rel < 0) {
            const imp = -rel * 0.3;
            c.vx -= nx * imp;
            c.vy -= ny * imp;
            o.vx += nx * imp;
            o.vy += ny * imp;
          }
        }
      }
    }
  }
}

/* ============================================================
   细胞膜采样与路径
   ============================================================ */
function sampleMembrane(c, time, radius, sx, sy, pinch, s) {
  const bx = s.bx;
  const by = s.by;
  const cosA = Math.cos(c.axis);
  const sinA = Math.sin(c.axis);
  const ctrl = c.memCtrl;
  const cn = ctrl.length;
  const amp = c.wobbleAmp;
  const phase = c.phase;
  const cw = cn / MEM_N;
  const pinchK = pinch > 0 ? 1 / (0.35 * radius + 0.001) : 0;

  for (let i = 0; i < MEM_N; i++) {
    const f = i * cw;
    const i0 = f | 0;
    const i1 = (i0 + 1) % cn;
    const fr = f - i0;
    const sm = fr * fr * (3 - 2 * fr);
    const a0 = ctrl[i0].amp * Math.sin(time * ctrl[i0].freq + ctrl[i0].phase + phase);
    const a1 = ctrl[i1].amp * Math.sin(time * ctrl[i1].freq + ctrl[i1].phase + phase);
    const wob = 1 + (a0 * (1 - sm) + a1 * sm) * amp;

    const lx = MEM_COS[i] * radius * wob * sx;
    let ly = MEM_SIN[i] * radius * wob * sy;

    if (pinchK > 0) {
      const k = lx * pinchK;
      ly *= 1 - pinch * Math.exp(-k * k);
    }

    bx[i] = lx * cosA - ly * sinA;
    by[i] = lx * sinA + ly * cosA;
  }
}

function tracePath(ctx, s) {
  const bx = s.bx;
  const by = s.by;
  ctx.beginPath();
  const mx = (bx[0] + bx[MEM_N - 1]) * 0.5;
  const my = (by[0] + by[MEM_N - 1]) * 0.5;
  ctx.moveTo(mx, my);
  for (let i = 0; i < MEM_N; i++) {
    const j = (i + 1) % MEM_N;
    ctx.quadraticCurveTo(bx[i], by[i], (bx[i] + bx[j]) * 0.5, (by[i] + by[j]) * 0.5);
  }
  ctx.closePath();
}

/* ============================================================
   细胞绘制（膜 / 质 / 核 / 细胞器 四层结构）
   ============================================================ */
function renderCellBody(ctx, s, c, time, radius, sx, sy, pinch, baseAlpha) {
  if (radius < 0.7 || baseAlpha <= 0.02) return;
  const pal = c.s;
  const sc = radius / Math.max(c.r, 0.01);

  sampleMembrane(c, time, radius, sx, sy, pinch, s);

  /* ---- 结构 2：细胞质（缓存径向渐变） ---- */
  tracePath(ctx, s);
  ctx.globalAlpha = baseAlpha;
  ctx.fillStyle = getCytoGrad(ctx, s, c.group, radius);
  ctx.fill();

  /* ---- 细胞质流动纹理 ---- */
  if (radius > 16) {
    ctx.globalAlpha = baseAlpha * 0.16;
    ctx.strokeStyle = pal.mem;
    ctx.lineWidth = 1;
    const ft = time * 0.6 + c.flowPhase;
    ctx.beginPath();
    for (let i = 0; i < c.flowN; i++) {
      const rr = radius * (0.36 + 0.18 * i);
      const a0 = ft + i * 2.1;
      ctx.moveTo(Math.cos(a0) * rr * 0.35, Math.sin(a0 * 1.3) * rr * 0.35);
      ctx.bezierCurveTo(
        Math.cos(a0 + 0.7) * rr * 0.95, Math.sin(a0 + 1.1) * rr * 0.95,
        Math.cos(a0 + 1.6) * rr * 0.95, Math.sin(a0 + 2.0) * rr * 0.95,
        Math.cos(a0 + 2.4) * rr, Math.sin(a0 + 2.9) * rr
      );
    }
    ctx.stroke();
  }

  /* ---- 被吞噬物（吞噬细胞内部） ---- */
  if (c.engulfedList && c.engulfedList.length) {
    const list = c.engulfedList;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const lifeK = clamp(e.life / e.maxLife, 0, 1);
      const a = lifeK * 0.62 * baseAlpha;
      if (a <= 0.02) continue;
      const ex = e.x * radius;
      const ey = e.y * radius;
      const er = Math.max(1.2, e.r * radius);
      ctx.globalAlpha = a;
      ctx.fillStyle = e.color;
      ctx.beginPath();
      ctx.arc(ex, ey, er, 0, TAU);
      ctx.fill();
    }
    if (c.digestPulse > 0.02) {
      const p = 0.5 + 0.5 * Math.sin(time * TAU * 2);
      ctx.globalAlpha = baseAlpha * 0.2 * c.digestPulse * (0.6 + 0.4 * p);
      ctx.fillStyle = PAL.R.digest;
      ctx.beginPath();
      ctx.arc(0, 0, radius * 0.9, 0, TAU);
      ctx.fill();
    }
  }

  /* ---- 结构 3：细胞核（漂移 + 核仁） ---- */
  let nucAlpha = 1;
  if (c.state === 'apoptosis') nucAlpha = clamp(1 - c.apo / 0.5, 0, 1);
  if (nucAlpha > 0.02) {
    const nucR = radius * 0.35;
    let nx = c.nucX * sc;
    let ny = c.nucY * sc;
    if (c.isPhago && c.engulfedList && c.engulfedList.length) {
      const k = Math.min(1, c.engulfedList.length * 0.28);
      nx += radius * 0.34 * k;
      ny += radius * 0.18 * k;
    }
    if (nucR > 0.8) {
      const a = baseAlpha * nucAlpha;
      ctx.globalAlpha = a * 0.85;
      ctx.fillStyle = pal.nuc;
      ctx.beginPath();
      ctx.arc(nx, ny, nucR, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = a * 0.8;
      ctx.strokeStyle = pal.nucLine;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = a;
      ctx.fillStyle = pal.nlo;
      ctx.beginPath();
      ctx.arc(nx + nucR * 0.16, ny - nucR * 0.12, Math.max(0.6, nucR * 0.3), 0, TAU);
      ctx.fill();
    }
  }

  /* ---- 结构 4：细胞器（按色组批量绘制） ---- */
  const orgs = c.orgs;
  const on = orgs.length;
  if (radius > 6) {
    ctx.globalAlpha = baseAlpha * 0.95;
    ctx.fillStyle = pal.orgA;
    ctx.beginPath();
    for (let i = 0; i < on; i++) {
      const o = orgs[i];
      if (o.grp !== 0) continue;
      const ox = o.x * sc;
      const oy = o.y * sc;
      const orr = Math.max(0.5, o.r * sc);
      ctx.moveTo(ox + orr, oy);
      ctx.arc(ox, oy, orr, 0, TAU);
    }
    ctx.fill();
    ctx.fillStyle = pal.orgB;
    ctx.beginPath();
    for (let i = 0; i < on; i++) {
      const o = orgs[i];
      if (o.grp !== 1) continue;
      const ox = o.x * sc;
      const oy = o.y * sc;
      const orr = Math.max(0.5, o.r * sc);
      ctx.moveTo(ox + orr, oy);
      ctx.arc(ox, oy, orr, 0, TAU);
    }
    ctx.fill();
  } else {
    ctx.globalAlpha = baseAlpha * 0.9;
    ctx.fillStyle = pal.orgA;
    ctx.beginPath();
    for (let i = 0; i < on; i++) {
      const o = orgs[i];
      const ox = o.x * sc;
      const oy = o.y * sc;
      const orr = Math.max(0.5, o.r * sc);
      ctx.moveTo(ox + orr, oy);
      ctx.arc(ox, oy, orr, 0, TAU);
    }
    ctx.fill();
  }

  /* ---- 结构 1：细胞膜（双层描边） ---- */
  let memAlpha = 1;
  let lineOuter = 2;
  let lineInner = 1;
  if (c.state === 'apoptosis') {
    const k = clamp(c.apo / CONFIG.cell.apoptosisTime, 0, 1);
    memAlpha = 1 - k;
    lineOuter = 2 * (1 - k * 0.8);
    lineInner = 1 * (1 - k * 0.6);
  }
  if (memAlpha > 0.03) {
    tracePath(ctx, s);
    ctx.strokeStyle = pal.mem;
    ctx.globalAlpha = baseAlpha * memAlpha * 0.42;
    ctx.lineWidth = Math.max(0.4, lineOuter);
    ctx.stroke();
    ctx.globalAlpha = baseAlpha * memAlpha * 0.92;
    ctx.lineWidth = Math.max(0.3, lineInner);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
}

function drawCell(ctx, s, c, time) {
  if (c.dead) return;
  let radius = c.r * c.scale;
  if (c.inCluster) radius *= 1 + 0.05 * Math.sin(time * TAU * 0.8);
  if (radius < 0.7) return;

  const alpha = c.state === 'apoptosis'
    ? clamp(1 - c.apo / CONFIG.cell.apoptosisTime, 0, 1)
    : 1;
  if (alpha <= 0.02) return;

  if (c.state === 'divide') {
    const t = clamp(c.divT / c.divDur, 0, 1);
    if (t < CONFIG.division.stretchEnd) {
      const k = t / CONFIG.division.stretchEnd;
      ctx.save();
      ctx.translate(c.x, c.y);
      renderCellBody(ctx, s, c, time, radius, 1 + 0.32 * k, 1 - 0.22 * k, 0, alpha);
      ctx.restore();
    } else if (t < CONFIG.division.pinchEnd) {
      const k = (t - CONFIG.division.stretchEnd) / (CONFIG.division.pinchEnd - CONFIG.division.stretchEnd);
      ctx.save();
      ctx.translate(c.x, c.y);
      renderCellBody(ctx, s, c, time, radius, 1.32, 0.78, 0.85 * k, alpha);
      ctx.restore();
    } else {
      const k = (t - CONFIG.division.pinchEnd) / (1 - CONFIG.division.pinchEnd);
      const sep = radius * (0.55 + 0.55 * k);
      const cr = radius * 0.72;
      const ax = Math.cos(c.axis);
      const ay = Math.sin(c.axis);
      ctx.save();
      ctx.translate(c.x + ax * sep, c.y + ay * sep);
      renderCellBody(ctx, s, c, time, cr, 1, 1, 0, alpha);
      ctx.restore();
      ctx.save();
      ctx.translate(c.x - ax * sep, c.y - ay * sep);
      renderCellBody(ctx, s, c, time, cr, 1, 1, 0, alpha);
      ctx.restore();
    }
  } else {
    ctx.save();
    ctx.translate(c.x, c.y);
    renderCellBody(ctx, s, c, time, radius, 1, 1, 0, alpha);
    ctx.restore();
  }
}

/* ============================================================
   伪足系统
   ============================================================ */
function drawTaperedPath(ctx, pts, w0, w1, alpha, color) {
  const n = pts.length;
  if (n < 2) return;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const w = lerp(w0, w1, i / (n - 1)) * 0.5;
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    const nx = -dy / l, ny = dx / l;
    const px = pts[i].x + nx * w;
    const py = pts[i].y + ny * w;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  for (let i = n - 1; i >= 0; i--) {
    const w = lerp(w0, w1, i / (n - 1)) * 0.5;
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(n - 1, i + 1)];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    const nx = -dy / l, ny = dx / l;
    ctx.lineTo(pts[i].x - nx * w, pts[i].y - ny * w);
  }
  ctx.closePath();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fill();
}

function drawPseudopod(ctx, p) {
  const ph = p.phago;
  if (!ph || ph.dead) return;
  const tg = p.target;
  const ax = Math.cos(p.ang);
  const ay = Math.sin(p.ang);
  const x0 = ph.x + ax * ph.r * 0.9;
  const y0 = ph.y + ay * ph.r * 0.9;

  const dx = tg.x - ph.x;
  const dy = tg.y - ph.y;
  const dist = Math.hypot(dx, dy) || 1;
  const nx = dx / dist;
  const ny = dy / dist;

  const len = Math.min(p.len, dist + tg.r);
  const ex = ph.x + nx * len;
  const ey = ph.y + ny * len;

  const midX = (x0 + ex) * 0.5;
  const midY = (y0 + ey) * 0.5;
  const px = -ny, py = nx;
  /* 原型用 performance.now() 做摆动的相位源（原第 761 行），保留同一口径 */
  const bow = Math.sin(p.wob + performance.now() * 0.004) * dist * 0.16;
  const cx1 = midX + px * bow;
  const cy1 = midY + py * bow;

  const SEG = 8;
  const pts = [];
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    const mt = 1 - t;
    pts.push({
      x: mt * mt * x0 + 2 * mt * t * cx1 + t * t * ex,
      y: mt * mt * y0 + 2 * mt * t * cy1 + t * t * ey
    });
  }

  const baseW = Math.max(2.5, ph.r * 0.45);
  const memCol = ph.s.mem;

  drawTaperedPath(ctx, pts, baseW * 1.5, baseW * 0.9, 0.3, memCol);
  drawTaperedPath(ctx, pts, baseW * 0.9, baseW * 0.45, 0.78, memCol);

  if (p.phase === 'wrap' || p.phase === 'retract') {
    const k = p.phase === 'wrap' ? clamp(p.t / CONFIG.phagocytosis.wrapDur, 0, 1) : 1;
    const fingers = p.fingers;
    const reach = tg.r * (1.5 + k * 1.1);
    const baseAng = Math.atan2(ey - cy1, ex - cx1);
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = memCol;
    ctx.lineWidth = Math.max(1, baseW * 0.4);
    ctx.beginPath();
    for (let i = 0; i < fingers; i++) {
      const a = baseAng + (i - (fingers - 1) / 2) * 0.55;
      const fx = ex + Math.cos(a) * reach * 0.9;
      const fy = ey + Math.sin(a) * reach * 0.9;
      const mxx = (ex + fx) * 0.5 + Math.cos(a + 1.6) * reach * 0.35;
      const myy = (ey + fy) * 0.5 + Math.sin(a + 1.6) * reach * 0.35;
      ctx.moveTo(ex, ey);
      ctx.quadraticCurveTo(mxx, myy, fx, fy);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

/* ============================================================
   粒子系统
   ============================================================ */
function addDot(s, x, y, vx, vy, r, life, color) {
  if (s.parts.length >= PART_MAX) return;
  s.parts.push({ type: 'dot', x, y, vx, vy, r, life, dur: life, color, drag: 0.06 });
}
function addShard(s, x, y, vx, vy, size, life, color) {
  if (s.parts.length >= PART_MAX) return;
  s.parts.push({
    type: 'shard', x, y, vx, vy, size,
    life, dur: life, color,
    rot: rand(0, TAU), rotSpd: rand(-6, 6),
    sides: randInt(3, 5), drag: 0.5
  });
}
function addRing(s, x, y, r0, r1, life, color, count, dotR) {
  if (s.parts.length >= PART_MAX) return;
  s.parts.push({ type: 'ring', x, y, r0, r1, life, dur: life, color, count, dotR, seed: rand(0, TAU) });
}
function addFlash(s, x, y, size, life, color) {
  if (s.parts.length >= PART_MAX) return;
  s.parts.push({ type: 'flash', x, y, size, life, dur: life, color });
}
function addSpindle(s, x, y, ang, len, life, color) {
  if (s.parts.length >= PART_MAX) return;
  s.parts.push({ type: 'spindle', x, y, ang, len, life, dur: life, color });
}
function addWave(s, x, y, r0, r1, life, color, width, ptsN) {
  if (s.parts.length >= PART_MAX) return;
  s.parts.push({
    type: 'wave', x, y, r0, r1, life, dur: life, color, width,
    pts: ptsN || randInt(16, 24), seed: rand(0, TAU)
  });
}
function addGhost(s, x, y, r, life, color) {
  if (s.parts.length >= PART_MAX) return;
  s.parts.push({ type: 'ghost', x, y, r, life, dur: life, color, pts: randInt(10, 14), seed: rand(0, TAU) });
}

function updateParts(s, dt) {
  const parts = s.parts;
  let w = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    p.life -= dt;
    if (p.life <= 0) continue;
    if (p.vx !== undefined) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const d = Math.pow(p.drag, dt);
      p.vx *= d;
      p.vy *= d;
    }
    if (p.rot !== undefined) p.rot += p.rotSpd * dt;
    parts[w++] = p;
  }
  parts.length = w;
}

function drawParts(ctx, s) {
  const parts = s.parts;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const t = 1 - p.life / p.dur;

    switch (p.type) {
      case 'dot': {
        ctx.globalAlpha = (1 - t) * 0.9;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * (1 - t * 0.4), 0, TAU);
        ctx.fill();
        break;
      }
      case 'shard': {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.beginPath();
        const n = p.sides;
        for (let k = 0; k < n; k++) {
          const ang = k / n * TAU;
          const rr = p.size * (0.55 + ((k * 37) % 10) / 10 * 0.7);
          const xx = Math.cos(ang) * rr;
          const yy = Math.sin(ang) * rr;
          if (k === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
        }
        ctx.closePath();
        ctx.globalAlpha = (1 - t) * 0.5;
        ctx.fillStyle = p.color;
        ctx.fill();
        ctx.globalAlpha = (1 - t);
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
        break;
      }
      case 'ring': {
        const rad = lerp(p.r0, p.r1, easeOut(t));
        ctx.globalAlpha = (1 - t) * 0.9;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        for (let k = 0; k < p.count; k++) {
          const ang = k / p.count * TAU + p.seed;
          const xx = p.x + Math.cos(ang) * rad;
          const yy = p.y + Math.sin(ang) * rad;
          const rr = p.dotR * (1 - t * 0.5);
          ctx.moveTo(xx + rr, yy);
          ctx.arc(xx, yy, rr, 0, TAU);
        }
        ctx.fill();
        break;
      }
      case 'flash': {
        const sz = p.size * (0.45 + t * 0.9);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.globalAlpha = 1 - t;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-sz, 0); ctx.lineTo(sz, 0);
        ctx.moveTo(0, -sz); ctx.lineTo(0, sz);
        ctx.moveTo(-sz * 0.55, -sz * 0.55); ctx.lineTo(sz * 0.55, sz * 0.55);
        ctx.moveTo(-sz * 0.55, sz * 0.55); ctx.lineTo(sz * 0.55, -sz * 0.55);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, 0, sz * 0.28, 0, TAU);
        ctx.globalAlpha = (1 - t) * 0.85;
        ctx.fillStyle = p.color;
        ctx.fill();
        ctx.restore();
        break;
      }
      case 'spindle': {
        const r0 = p.len * t * 0.25;
        const r1 = p.len * t;
        ctx.globalAlpha = (1 - t) * 0.55;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(p.x + Math.cos(p.ang) * r0, p.y + Math.sin(p.ang) * r0);
        ctx.lineTo(p.x + Math.cos(p.ang) * r1, p.y + Math.sin(p.ang) * r1);
        ctx.stroke();
        break;
      }
      case 'wave': {
        const rad = lerp(p.r0, p.r1, easeOut(t));
        const n = p.pts;
        ctx.beginPath();
        for (let k = 0; k <= n; k++) {
          const ang = k / n * TAU;
          const wob = 1
            + Math.sin(ang * 3 + p.seed + t * 6.5) * 0.13
            + Math.sin(ang * 5 - p.seed * 1.7 + t * 9.3) * 0.08;
          const xx = p.x + Math.cos(ang) * rad * wob;
          const yy = p.y + Math.sin(ang) * rad * wob;
          if (k === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
        }
        ctx.closePath();
        ctx.globalAlpha = (1 - t) * 0.9;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = p.width;
        ctx.stroke();
        break;
      }
      case 'ghost': {
        const rad = p.r * (1 + t * 0.55);
        const n = p.pts;
        ctx.beginPath();
        for (let k = 0; k <= n; k++) {
          const ang = k / n * TAU;
          const wob = 1 + Math.sin(ang * 3 + p.seed + t * 3) * 0.12;
          const xx = p.x + Math.cos(ang) * rad * wob;
          const yy = p.y + Math.sin(ang) * rad * wob;
          if (k === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
        }
        ctx.closePath();
        ctx.globalAlpha = (1 - t) * 0.3;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 2;
        ctx.stroke();
        break;
      }
    }
  }
  ctx.globalAlpha = 1;
}

/* ============================================================
   有丝分裂波
   ============================================================ */
function triggerMitosisWave(s, x, y, attract) {
  s.mitosisWaves.push({
    id: ++s.waveIdCounter,
    x, y, t: 0,
    dur: CONFIG.mitosisWave.duration,
    maxR: CONFIG.mitosisWave.radius,
    r: 0,
    attract: !!attract
  });
}

function updateMitosisWaves(s, dt) {
  const waves = s.mitosisWaves;
  const cells = s.cells;
  for (let i = waves.length - 1; i >= 0; i--) {
    const w = waves[i];
    w.t += dt;
    w.r = (w.t / w.dur) * w.maxR;

    for (let j = 0; j < cells.length; j++) {
      const c = cells[j];
      if (c.dead || c.isPhago || c.state === 'apoptosis') continue;
      if (c.lastWave === w.id) continue;
      const dx = c.x - w.x;
      const dy = c.y - w.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > w.r * w.r) continue;
      c.lastWave = w.id;
      const d = Math.sqrt(d2) || 1;

      if (c.r < CONFIG.mitosisWave.minSplitRadius) {
        c.dead = true;
      } else if (c.state !== 'divide') {
        /* 波前扫过：立即分裂（受硬限制保护） */
        if (c.r >= CONFIG.cell.minDivideRadius &&
            c.gen < CONFIG.cell.maxGeneration &&
            cells.length < CONFIG.maxCells - 4) {
          startDivision(c, 0.3);
          c.axis = Math.atan2(dy, dx) + rand(-0.3, 0.3);
        }
      }

      if (w.attract) {
        c.vx += (-dx / d) * 70;
        c.vy += (-dy / d) * 70;
      }
    }

    for (let k = 0; k < 2; k++) {
      const ang = Math.random() * TAU;
      addDot(
        s,
        w.x + Math.cos(ang) * w.r + rand(-3, 3),
        w.y + Math.sin(ang) * w.r + rand(-3, 3),
        rand(-25, 25), rand(-25, 25),
        rand(1.4, 2.8), 0.1,
        PAL.L.nlo
      );
    }

    if (w.t >= w.dur) waves.splice(i, 1);
  }
}

function drawMitosisWaves(ctx, s) {
  const waves = s.mitosisWaves;
  for (let i = 0; i < waves.length; i++) {
    const w = waves[i];
    const t = clamp(w.t / w.dur, 0, 1);
    const n = 20;
    ctx.beginPath();
    for (let k = 0; k <= n; k++) {
      const ang = k / n * TAU;
      const wob = 1 + Math.sin(ang * 3 + t * 7) * 0.06;
      const xx = w.x + Math.cos(ang) * w.r * wob;
      const yy = w.y + Math.sin(ang) * w.r * wob;
      if (k === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
    }
    ctx.closePath();
    ctx.globalAlpha = (1 - t) * 0.85;
    ctx.strokeStyle = PAL.L.mem;
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/* ============================================================
   生长与分裂系统
   ============================================================ */
function startDivision(c, dur) {
  /* 硬限制：太小 / 代数太深 → 直接凋亡，不再进入分裂状态 */
  if (c.r < CONFIG.cell.minDivideRadius || c.gen >= CONFIG.cell.maxGeneration) {
    apoptosisCell(c);
    return;
  }
  c.state = 'divide';
  c.divT = 0;
  c.divDur = dur || CONFIG.division.duration;
  c.axis = rand(0, TAU);
  c.wobbleAmp = 0.13;
  c.captured = true;
}

function completeDivision(s, c) {
  const pr = c.r;
  const childR = Math.min(pr * CONFIG.division.childRatio, CONFIG.cell.maxRadius);
  const nextGen = c.gen + 1;

  /* ---- 终止条件：子细胞太小 / 对象池不足 → 直接凋亡 ---- */
  if (childR < CONFIG.cell.minDivideRadius || s.freeCells.length < 2) {
    apoptosisCell(c);
    return;
  }

  const ax = Math.cos(c.axis);
  const ay = Math.sin(c.axis);
  const spd = c.burst ? c.burstSpd : rand(CONFIG.division.childSpeedMin, CONFIG.division.childSpeedMax);

  /* 子细胞成熟半径：接近父细胞，避免几何级数坍缩 */
  const childRMax = Math.max(c.rMax * 0.94, CONFIG.cell.minDivideRadius * 1.6);

  /* 子细胞是否还能继续分裂：受代数与爆发状态双重限制 */
  const childCanDivide = c.canDivide && !c.burst && nextGen < CONFIG.cell.maxGeneration;

  for (let side = -1; side <= 1; side += 2) {
    if (s.freeCells.length === 0) break;
    let vx = ax * side * spd + c.vx * 0.4;
    let vy = ay * side * spd + c.vy * 0.4;

    if (s.burstCenter) {
      const dx = c.x - s.burstCenter.x;
      const dy = c.y - s.burstCenter.y;
      const d = Math.hypot(dx, dy) || 1;
      vx = (dx / d) * spd + rand(-40, 40);
      vy = (dy / d) * spd + rand(-40, 40);
    }

    const child = spawnCell(
      s,
      c.x + ax * side * pr * 0.45,
      c.y + ay * side * pr * 0.45,
      childR, c.group,
      {
        rMax: childRMax,
        gen: nextGen,
        canDivide: childCanDivide,
        inCluster: c.inCluster,
        life: rand(3, 6),       /* 子细胞寿命有界，不重置为长寿命 */
        growRate: c.growRate,
        phase: c.phase,
        axis: c.axis,
        vx, vy,
        burst: c.burst,
        burstSpd: spd
      }
    );

    if (child && c.burst && Math.random() < CONFIG.fission.shatterChance) {
      shatterCell(s, child);
    }
  }

  c.dead = true;
}

function shatterCell(s, c) {
  const n = randInt(6, 10);
  for (let i = 0; i < n; i++) {
    const a = rand(0, TAU);
    const sp = rand(300, 700);
    addShard(
      s,
      c.x + Math.cos(a) * c.r * 0.5,
      c.y + Math.sin(a) * c.r * 0.5,
      Math.cos(a) * sp, Math.sin(a) * sp,
      rand(2, 5), rand(0.4, 0.8), c.s.memHex
    );
  }
  for (let i = 0; i < 4; i++) {
    const a = rand(0, TAU);
    const sp = rand(250, 600);
    addDot(s, c.x, c.y, Math.cos(a) * sp, Math.sin(a) * sp, rand(1, 2.4), rand(0.4, 0.8),
      i % 2 === 0 ? PAL.L.org : PAL.L.nlo);
  }
  addFlash(s, c.x, c.y, rand(10, 18), 0.12, PAL.L.nlo);
  c.dead = true;
}

/* ============================================================
   吞噬系统
   ============================================================ */
function spawnPrey(s) {
  const M = s.input;
  const a = rand(0, TAU);
  const d = rand(CONFIG.phagocytosis.preySpawnMin, CONFIG.phagocytosis.preySpawnMax);
  const c = spawnCell(
    s,
    M.x + Math.cos(a) * d,
    M.y + Math.sin(a) * d,
    rand(CONFIG.phagocytosis.preyRadiusMin, CONFIG.phagocytosis.preyRadiusMax), 1,
    {
      rMax: rand(7, 13),
      growRate: rand(2, 5),
      life: rand(14, 24),
      vx: rand(-25, 25),
      vy: rand(-25, 25)
    }
  );
  if (c) c.isPrey = true;
}

function countPrey(s) {
  const cells = s.cells;
  let n = 0;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c.isPrey && !c.dead && c.state !== 'apoptosis') n++;
  }
  return n;
}

function absorbPrey(s, ph, prey) {
  const pr = prey.r;
  const newR = Math.sqrt(ph.r * ph.r + pr * pr);
  ph.rMax = Math.min(CONFIG.phagocytosis.phagoMaxRadius, Math.max(ph.rMax, newR));

  if (!ph.engulfedList) ph.engulfedList = [];
  const life = rand(CONFIG.phagocytosis.digestMin, CONFIG.phagocytosis.digestMax);
  ph.engulfedList.push({
    x: (prey.x - ph.x) / Math.max(ph.r, 1) * 0.5,
    y: (prey.y - ph.y) / Math.max(ph.r, 1) * 0.5,
    vx: rand(-18, 18),
    vy: rand(-18, 18),
    r: clamp(pr / Math.max(ph.r, 1), 0.12, 0.55),
    color: prey.s ? prey.s.memHex : CONFIG.colors.right.engulfed,
    life,
    maxLife: life
  });

  ph.digestPulse = 1;
  prey.dead = true;
}

function updatePseudopods(s, dt) {
  const mouse = s.mouse;
  const ph = mouse.phago;
  /* 身份校验见 setup() 里 seedUid / phagoUid 的说明 */
  if (!ph || ph.dead || ph.uid !== s.phagoUid) {
    s.pseudopods.length = 0;
    return;
  }

  const pseudopods = s.pseudopods;
  const cells = s.cells;

  for (let i = pseudopods.length - 1; i >= 0; i--) {
    if (pseudopods[i].done) pseudopods.splice(i, 1);
  }

  if (pseudopods.length < CONFIG.phagocytosis.pseudopodMax) {
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (!c.isPrey || c.captured || c.dead || c.state === 'apoptosis') continue;
      const d = Math.hypot(c.x - ph.x, c.y - ph.y);
      if (d < CONFIG.phagocytosis.pseudopodRange && d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (best) {
      best.captured = true;
      pseudopods.push({
        phago: ph,
        target: best,
        t: 0,
        phase: 'extend',
        ang: Math.atan2(best.y - ph.y, best.x - ph.x),
        len: 0,
        targetDist: bestD,
        fingers: randInt(2, 3),
        wob: rand(0, TAU),
        done: false
      });
    }
  }

  for (let i = 0; i < pseudopods.length; i++) {
    const p = pseudopods[i];
    if (p.done) continue;
    const tg = p.target;
    if (!tg || tg.dead) { p.done = true; continue; }

    p.t += dt;

    if (p.phase === 'extend') {
      const k = clamp(p.t / CONFIG.phagocytosis.extendDur, 0, 1);
      p.len = easeOut(k) * (p.targetDist + tg.r);
      if (k >= 1) { p.phase = 'wrap'; p.t = 0; }
    } else if (p.phase === 'wrap') {
      const k = clamp(p.t / CONFIG.phagocytosis.wrapDur, 0, 1);
      p.len = p.targetDist + tg.r * (1 - k * 0.35);
      if (k >= 1) { p.phase = 'retract'; p.t = 0; }
    } else if (p.phase === 'retract') {
      const k = clamp(p.t / CONFIG.phagocytosis.retractDur, 0, 1);
      const dx = ph.x - tg.x;
      const dy = ph.y - tg.y;
      const d = Math.hypot(dx, dy) || 1;
      const pull = lerp(0, 260, k);
      tg.x += (dx / d) * pull * dt;
      tg.y += (dy / d) * pull * dt;
      p.len = Math.max(tg.r, d - tg.r);
      if (k >= 1) {
        absorbPrey(s, ph, tg);
        p.done = true;
      }
    }
  }
}

function updateEngulfedInCell(c, dt) {
  const list = c.engulfedList;
  if (!list) return;
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    e.life -= dt;
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    const d = Math.pow(0.2, dt);
    e.vx *= d;
    e.vy *= d;
    const lim = 0.6;
    if (e.x > lim) { e.x = lim; e.vx *= -0.5; }
    if (e.x < -lim) { e.x = -lim; e.vx *= -0.5; }
    if (e.y > lim) { e.y = lim; e.vy *= -0.5; }
    if (e.y < -lim) { e.y = -lim; e.vy *= -0.5; }
    if (e.life <= 0) list.splice(i, 1);
  }
  if (list.length > 0) {
    c.digestPulse = Math.min(1, c.digestPulse + dt * 2.5);
  } else {
    c.digestPulse = Math.max(0, c.digestPulse - dt * 2);
  }
}

/* ============================================================
   鼠标输入（位置来自基类 input；左右键与蓄力状态在 state 上）
   ============================================================ */
function clickEffect(s, x, y, group) {
  const memCol = group === 0 ? PAL.L.mem : PAL.R.mem;
  const nloCol = group === 0 ? PAL.L.nlo : PAL.R.nlo;

  /* 中等细胞：不继承分裂能力，寿命有限 */
  const mid = spawnCell(s, x, y, rand(8, 14), group, {
    rMax: rand(14, 22),
    growRate: rand(6, 10),
    life: rand(5, 9),
    vx: 0, vy: 0
  });
  if (mid) mid.wobbleAmp = 0.1;

  const n = randInt(4, 7);
  for (let i = 0; i < n; i++) {
    const a = rand(0, TAU);
    const sp = rand(100, 300);
    spawnCell(s, x, y, rand(3, 6), group, {
      rMax: rand(6, 10),
      growRate: rand(4, 8),
      life: rand(3, 6),
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp
    });
  }

  addWave(s, x, y, 10, 70, 0.5, memCol, 2.5, randInt(16, 22));
  addFlash(s, x, y, rand(14, 22), 0.1, nloCol);
  triggerMitosisWave(s, x, y, false);

  const sn = randInt(8, 12);
  for (let i = 0; i < sn; i++) {
    addSpindle(s, x, y, i / sn * TAU + rand(-0.15, 0.15),
      CONFIG.mitosisWave.radius * rand(0.6, 1), 0.3, PAL.L.nlo);
  }
}

function startCharge(s, mode) {
  const M = s.input;
  const mouse = s.mouse;
  mouse.chargeMode = mode;
  mouse.chargeT = 0;
  const x = M.x;
  const y = M.y;

  if (mode === 1) {
    const seed = spawnCell(s, x, y, CONFIG.fission.seedRadius, 0, {
      rMax: CONFIG.fission.seedMature,
      growRate: CONFIG.fission.seedGrowRate,
      canDivide: true,
      inCluster: true,
      life: 60,
      wobbleAmp: 0.08
    });
    mouse.seed = seed;
    s.seedUid = seed ? seed.uid : 0;
    addFlash(s, x, y, 16, 0.1, PAL.L.nlo);
  } else {
    const ph = spawnCell(s, x, y, CONFIG.phagocytosis.phagoStartRadius, 1, {
      rMax: CONFIG.phagocytosis.phagoMaxRadius,
      growRate: 4,
      isPhago: true,
      life: 90,
      wobbleAmp: 0.1
    });
    mouse.phago = ph;
    s.phagoUid = ph ? ph.uid : 0;
    s.preySpawnAcc = 0;
    addFlash(s, x, y, 14, 0.1, PAL.R.nlo);
    for (let i = 0; i < 5; i++) spawnPrey(s);
  }
}

function endCharge(s) {
  const mouse = s.mouse;
  const mode = mouse.chargeMode;
  const t = mouse.chargeT;
  mouse.chargeMode = 0;

  if (t >= 0.12) {
    if (mode === 1) releaseFission(s, t);
    else if (mode === 2) releasePhago(s, t);
  } else {
    /* ---- 快速点击：不产生持久的繁殖/吞噬主体 ---- */
    if (mode === 1) {
      /* 种子细胞直接凋亡（clickEffect 已生成替代细胞） */
      if (mouse.seed && !mouse.seed.dead && mouse.seed.uid === s.seedUid) apoptosisCell(mouse.seed);
      for (let i = 0; i < s.cells.length; i++) {
        const c = s.cells[i];
        if (c.inCluster) {
          c.inCluster = false;
          c.canDivide = false;
        }
      }
    } else if (mode === 2) {
      /* 小规模爆裂 */
      if (mouse.phago && !mouse.phago.dead) {
        const ph = mouse.phago;
        const px = ph.x, py = ph.y, pr = ph.r;
        for (let i = 0; i < 6; i++) {
          const a = rand(0, TAU);
          const sp = rand(120, 320);
          addShard(s, px + Math.cos(a) * pr * 0.6, py + Math.sin(a) * pr * 0.6,
            Math.cos(a) * sp, Math.sin(a) * sp, rand(3, 6), rand(0.4, 0.8),
            CONFIG.colors.right.membrane);
        }
        for (let i = 0; i < 10; i++) {
          const a = rand(0, TAU);
          const sp = rand(100, 300);
          addDot(s, px, py, Math.cos(a) * sp, Math.sin(a) * sp, rand(1, 2.5), rand(0.4, 0.8), PAL.R.org);
        }
        addGhost(s, px, py, pr * 1.2, 0.6, PAL.R.mem);
        ph.dead = true;
      }
      s.pseudopods.length = 0;
    }
  }

  mouse.seed = null;
  mouse.phago = null;
  mouse.chargeT = 0;
  s.seedUid = 0;
  s.phagoUid = 0;
  s.burstCenter = null;
  s.pseudopods.length = 0;
}

function releaseFission(s, t) {
  const M = s.input;
  const power = Math.pow(clamp(t, 0, CONFIG.fission.chargeMax) / CONFIG.fission.chargeMax, CONFIG.fission.powerExp);
  s.freeze = 0.03;
  s.burstCenter = { x: M.x, y: M.y };
  s.burstCenterTimer = 0.6;

  const cells = s.cells;
  const list = [];
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c.inCluster && c.state !== 'apoptosis' && !c.dead) list.push(c);
  }

  const burstSpd = CONFIG.fission.burstSpeedBase + CONFIG.fission.burstSpeedScale * power;

  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    c.inCluster = false;
    c.burst = true;
    c.burstSpd = burstSpd;
    c.state = 'divide';
    c.divT = 0;
    c.divDur = CONFIG.division.fastDuration;
    c.axis = rand(0, TAU);
    c.wobbleAmp = 0.15;
    /* 关键：限制爆发后子细胞寿命，避免永存 */
    c.canDivide = false;
    c.age = 0;
    c.life = rand(CONFIG.fission.burstLifeMin, CONFIG.fission.burstLifeMax);
  }

  const flashN = randInt(3, 5);
  for (let i = 0; i < flashN; i++) {
    addFlash(
      s,
      M.x + rand(-24, 24),
      M.y + rand(-24, 24),
      rand(20, 42), rand(0.12, 0.18),
      PAL.L.nlo
    );
  }

  const ringMax = CONFIG.fission.ringBase + CONFIG.fission.ringScale * power;
  addRing(s, M.x, M.y, 16, ringMax, 0.6, PAL.L.mem, 36, 3);
  addRing(s, M.x, M.y, 8, ringMax * 0.72, 0.45, PAL.L.nlo, 24, 2);

  triggerMitosisWave(s, M.x, M.y, false);

  const sn = randInt(8, 12);
  for (let i = 0; i < sn; i++) {
    addSpindle(s, M.x, M.y, i / sn * TAU, 160 + 200 * power, 0.35, PAL.L.nlo);
  }
}

function releasePhago(s, t) {
  const power = Math.pow(clamp(t, 0, CONFIG.fission.chargeMax) / CONFIG.fission.chargeMax, CONFIG.fission.powerExp);
  const mouse = s.mouse;
  const ph = mouse.phago;
  s.freeze = 0.03;
  /* 身份校验见 setup() 里 phagoUid 的说明 */
  if (!ph || ph.dead || ph.uid !== s.phagoUid) {
    s.pseudopods.length = 0;
    return;
  }

  const px = ph.x, py = ph.y, pr = ph.r;

  for (let i = 0; i < 14; i++) {
    const a = rand(0, TAU);
    const sp = rand(180, 520);
    addShard(s, px + Math.cos(a) * pr * 0.7, py + Math.sin(a) * pr * 0.7,
      Math.cos(a) * sp, Math.sin(a) * sp, rand(4, 11), rand(0.5, 0.95), CONFIG.colors.right.membrane);
  }

  for (let i = 0; i < 5; i++) {
    const a = rand(0, TAU);
    const sp = rand(220, 480);
    addShard(s, px, py, Math.cos(a) * sp, Math.sin(a) * sp, rand(5, 10), rand(0.5, 0.9), CONFIG.colors.right.nucleus);
  }

  for (let i = 0; i < 22; i++) {
    const a = rand(0, TAU);
    const sp = rand(200, 520);
    addDot(s, px, py, Math.cos(a) * sp, Math.sin(a) * sp, rand(1, 3), rand(0.5, 1.0), PAL.R.org);
  }

  for (let i = 0; i < 18; i++) {
    const a = rand(0, TAU);
    const sp = rand(150, 420);
    addDot(s, px, py, Math.cos(a) * sp, Math.sin(a) * sp, rand(1.5, 3.2), rand(0.6, 1.1), PAL.R.digest);
  }

  if (ph.engulfedList) {
    for (let i = 0; i < ph.engulfedList.length; i++) {
      const e = ph.engulfedList[i];
      const a = rand(0, TAU);
      const sp = rand(300, 600);
      const c = spawnCell(s, px, py, Math.max(4, e.r * pr), 1, {
        rMax: rand(8, 14),
        growRate: rand(3, 6),
        life: rand(3, 7),
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp
      });
      if (c) c.isPrey = true;
    }
  }

  addGhost(s, px, py, pr * 1.35, 0.8, PAL.R.mem);

  addRing(s, px, py, 14, CONFIG.phagocytosis.burstRingBase + CONFIG.phagocytosis.burstRingScale * power,
    0.5, PAL.R.digest, 24, 3);
  addRing(s, px, py, 8, (CONFIG.phagocytosis.burstRingBase + CONFIG.phagocytosis.burstRingScale * power) * 0.7,
    0.4, PAL.R.mem, 18, 2);

  triggerMitosisWave(s, px, py, true);

  for (let i = 0; i < 4; i++) {
    const a = rand(0, TAU);
    const d = rand(20, 90);
    const c = spawnCell(s, px + Math.cos(a) * d, py + Math.sin(a) * d, rand(4, 9), 1, {
      rMax: rand(8, 14),
      growRate: rand(2, 5),
      life: rand(4, 8),
      vx: rand(-30, 30),
      vy: rand(-30, 30)
    });
    if (c) c.isPrey = true;
  }

  ph.dead = true;
  mouse.phago = null;
  s.pseudopods.length = 0;
}

/* ============================================================
   蓄力逻辑
   ============================================================ */
function updateCharge(s, dt) {
  const mouse = s.mouse;
  const M = s.input;
  if (!mouse.chargeMode) return;
  mouse.chargeT += dt;
  const shakeK = mouse.chargeT > CONFIG.fission.chargeMax * 0.55 ? 1 : 0;
  const cells = s.cells;

  if (mouse.chargeMode === 1) {
    const seed = mouse.seed;

    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (!c.inCluster || c.state === 'apoptosis') continue;
      const dx = M.x - c.x;
      const dy = M.y - c.y;
      c.vx += dx * dt * 1.2;
      c.vy += dy * dt * 1.2;
      if (shakeK) {
        c.vx += rand(-1, 1) * 40 * dt;
        c.vy += rand(-1, 1) * 40 * dt;
      }
    }

    let count = 0;
    let csx = 0, csy = 0;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (!c.inCluster || c.state === 'apoptosis') continue;
      count++;
      csx += Math.cos(c.phase);
      csy += Math.sin(c.phase);
    }
    s.clusterCount = count;

    if (count > 1) {
      const avg = Math.atan2(csy, csx);
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        if (!c.inCluster) continue;
        let d = avg - c.phase;
        d = ((d + Math.PI) % TAU + TAU) % TAU - Math.PI;
        c.phase += d * Math.min(1, dt * 1.5);
      }
    }

    const allowDivide = count < CONFIG.fission.maxCount;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (!c.inCluster) continue;
      if (c.state === 'grow') c.canDivide = allowDivide;
      const dx = M.x - c.x;
      const dy = M.y - c.y;
      const d = Math.hypot(dx, dy);
      if (d > CONFIG.fission.clusterRadius) {
        const f = (d - CONFIG.fission.clusterRadius) * 2.2;
        c.vx += (dx / d) * f * dt;
        c.vy += (dy / d) * f * dt;
      }
    }

    /* 身份校验见 setup() 里 seedUid 的说明 */
    if (seed && !seed.dead && seed.uid === s.seedUid && shakeK) {
      seed.x += rand(-1.4, 1.4);
      seed.y += rand(-1.4, 1.4);
    }
  } else if (mouse.chargeMode === 2) {
    const ph = mouse.phago;
    /* 身份校验见 setup() 里 phagoUid 的说明；
       引用已悬空等同于「吞噬体没了」，伪足一并清掉（原型经自噬也会走到 ph.dead 从而清空） */
    if (!ph || ph.dead || ph.uid !== s.phagoUid) {
      s.pseudopods.length = 0;
      return;
    }

    if (shakeK) {
      ph.x += rand(-1.6, 1.6);
      ph.y += rand(-1.6, 1.6);
    }

    const rate = lerp(3, 14, clamp(mouse.chargeT / CONFIG.fission.chargeMax, 0, 1));
    s.preySpawnAcc += dt * rate;
    let guard = 0;
    while (s.preySpawnAcc >= 1 && countPrey(s) < CONFIG.phagocytosis.preyMaxCount && guard < 2) {
      s.preySpawnAcc -= 1;
      guard++;
      spawnPrey(s);
    }

    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (!c.isPrey || c.captured || c.dead || c.state === 'apoptosis') continue;
      const dx = ph.x - c.x;
      const dy = ph.y - c.y;
      const d = Math.hypot(dx, dy) || 1;
      if (d < 280) {
        const k = 1 - d / 280;
        const sp = CONFIG.phagocytosis.preyAttract * (0.4 + 0.6 * k);
        c.vx = lerp(c.vx, (dx / d) * sp, Math.min(1, dt * 2));
        c.vy = lerp(c.vy, (dy / d) * sp, Math.min(1, dt * 2));
      }
      if (d < ph.r * 0.7) {
        absorbPrey(s, ph, c);
      }
    }

    updatePseudopods(s, dt);
  }
}

/* ============================================================
   细胞更新
   ============================================================ */
function updateCell(s, c, dt) {
  if (c.spawnT < 1) {
    c.spawnT += dt / 0.2;
    if (c.spawnT > 1) c.spawnT = 1;
  }
  const sp = c.spawnT;
  c.scale = sp >= 1 ? 1 : (1 + 2.70158 * Math.pow(sp - 1, 3) + 1.70158 * Math.pow(sp - 1, 2));

  if (c.state === 'divide') {
    c.divT += dt;
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    const damp = Math.pow(0.25, dt);
    c.vx *= damp;
    c.vy *= damp;
    c.wobbleAmp = Math.min(0.15, c.wobbleAmp + dt * 0.3);
    if (c.divT >= c.divDur) completeDivision(s, c);
    return;
  }

  if (c.state === 'apoptosis') {
    c.apo += dt;
    c.x += c.vx * dt;
    c.y += c.vy * dt;
    const damp = Math.pow(0.25, dt);
    c.vx *= damp;
    c.vy *= damp;
    for (let i = 0; i < c.orgs.length; i++) {
      const o = c.orgs[i];
      o.x += o.vx * dt;
      o.y += o.vy * dt;
      const od = Math.pow(0.5, dt);
      o.vx *= od;
      o.vy *= od;
    }
    c.r *= Math.pow(0.75, dt);
    if (c.apo >= CONFIG.cell.apoptosisTime) c.dead = true;
    return;
  }

  /* 蓄力集群中细胞冻结年龄，避免长时间蓄力被寿命清空 */
  if (!c.inCluster) c.age += dt;

  if (c.r < c.rMax) {
    const k = c.r / c.rMax;
    const speed = c.growRate * (1 - 0.6 * k * k);
    c.r = Math.min(c.rMax, c.r + speed * dt);
  }

  c.dirT -= dt;
  if (c.dirT <= 0) {
    c.dirT = rand(1, 2);
    const a = rand(0, TAU);
    const sp2 = rand(20, 60);
    c.dirX = Math.cos(a) * sp2;
    c.dirY = Math.sin(a) * sp2;
  }
  const spd = Math.hypot(c.vx, c.vy);
  const dampRate = spd > 130 ? 0.5 : 2.4;
  const k2 = Math.min(1, dt * dampRate);
  c.vx = lerp(c.vx, c.dirX, k2);
  c.vy = lerp(c.vy, c.dirY, k2);
  c.x += c.vx * dt;
  c.y += c.vy * dt;

  if (c.x < c.r) { c.x = c.r; c.vx = Math.abs(c.vx) * 0.4; }
  if (c.x > s.W - c.r) { c.x = s.W - c.r; c.vx = -Math.abs(c.vx) * 0.4; }
  if (c.y < c.r) { c.y = c.r; c.vy = Math.abs(c.vy) * 0.4; }
  if (c.y > s.H - c.r) { c.y = s.H - c.r; c.vy = -Math.abs(c.vy) * 0.4; }

  c.nucPhase += dt * 0.6;
  const nl = c.r * 0.2;
  c.nucX = Math.cos(c.nucPhase) * nl * 0.7 + Math.cos(c.nucPhase * 2.3) * nl * 0.3;
  c.nucY = Math.sin(c.nucPhase * 0.85) * nl * 0.7 + Math.sin(c.nucPhase * 1.9) * nl * 0.3;

  const lim = c.r * 0.7;
  for (let i = 0; i < c.orgs.length; i++) {
    const o = c.orgs[i];
    o.vx += rand(-1, 1) * dt * 42;
    o.vy += rand(-1, 1) * dt * 42;
    const od = Math.pow(0.35, dt);
    o.vx *= od;
    o.vy *= od;
    o.x += o.vx * dt;
    o.y += o.vy * dt;
    const d = Math.hypot(o.x, o.y);
    if (d > lim) {
      o.x = o.x / d * lim;
      o.y = o.y / d * lim;
      o.vx *= -0.5;
      o.vy *= -0.5;
    }
  }

  if (c.engulfedList) updateEngulfedInCell(c, dt);

  /* 分裂判定：加入半径/代数/池容量三重保护 */
  if (c.canDivide &&
      c.r >= c.rMax - 0.5 &&
      c.r >= CONFIG.cell.minDivideRadius &&
      c.gen < CONFIG.cell.maxGeneration &&
      s.cells.length < CONFIG.maxCells - 4) {
    const limitOK = c.inCluster ? (s.clusterCount < CONFIG.fission.maxCount) : true;
    if (limitOK) startDivision(c, c.burst ? CONFIG.division.fastDuration : CONFIG.division.duration);
  }

  if (c.age > c.life) {
    apoptosisCell(c);
  }
}

/* ============================================================
   主更新 / 渲染
   ============================================================ */
function updateFrame(s, dt) {
  updateCharge(s, dt);
  updateMitosisWaves(s, dt);

  buildGrid(s);
  const cells = s.cells;
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i].dead) updateCell(s, cells[i], dt);
  }

  resolveCollisions(s);
  updateParts(s, dt);

  if (s.mouse.chargeMode !== 2 && s.pseudopods.length) s.pseudopods.length = 0;

  if (s.burstCenterTimer > 0) {
    s.burstCenterTimer -= dt;
    if (s.burstCenterTimer <= 0) s.burstCenter = null;
  }

  /* 回收死亡细胞 */
  let w = 0;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c.dead) {
      c.engulfedList = null;
      s.freeCells.push(c);
    } else {
      cells[w++] = c;
    }
  }
  cells.length = w;
}

function renderFrame(ctx, s) {
  /* 原型第 1963 行就是 clearRect：没有任何整屏铺底，画布保持透明 */
  ctx.clearRect(0, 0, s.W, s.H);

  const pseudopods = s.pseudopods;
  for (let i = 0; i < pseudopods.length; i++) {
    if (!pseudopods[i].done) drawPseudopod(ctx, pseudopods[i]);
  }

  const cells = s.cells;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (!c.dead) drawCell(ctx, s, c, s.time);
  }

  drawMitosisWaves(ctx, s);
  drawParts(ctx, s);
}

export class CursorCell extends CursorEffectElement {
  // 原型用的是 mousemove / mousedown / mouseup（不是 pointer 事件族），
  // 不声明这一行，基类会去监听 pointermove，动效将完全收不到鼠标输入。
  inputFamily = 'mouse';

  /* ============================================================
     初始化
     ============================================================ */
  // 只建池与状态，不注册任何监听（主画布、DPR 缩放、rAF 全归基类）
  setup({ ctx, width, height, input }) {
    // 与原型一致：初始光标位置取视口中心（原第 1346~1347 行）。
    // 基类的 input 从 (0, 0) 起算，若不在这里对齐，首帧的位移会按「从左上角跳过来」计算，
    // 拖尾生成量会和原型不同。
    input.x = input.lx = width * 0.5;
    input.y = input.ly = height * 0.5;

    // 细胞对象池：预分配 maxCells 个空槽（原第 242~247 行）
    const freeCells = [];
    for (let i = 0; i < CONFIG.maxCells; i++) {
      freeCells.push({ dead: true, uid: 0 });
    }

    return {
      // 本实例的画布上下文（已按 DPR 缩放过，统一使用 CSS 像素坐标）
      ctx,

      // 画布尺寸（CSS 像素），由基类 onResize 同步
      W: width,
      H: height,

      input,

      // 动效自己的时钟：原型 time / freeze（freeze 期间 dt 归零、不累加 time）
      time: 0,
      freeze: 0,

      // 细胞池
      freeCells,
      cells: [],
      uidCounter: 0,

      // 伪足
      pseudopods: [],

      // 粒子
      parts: [],

      // 有丝分裂波
      mitosisWaves: [],
      waveIdCounter: 0,

      // 碰撞空间网格
      grid: new Map(),

      // 爆发中心 / 集群计数
      burstCenter: null,
      burstCenterTimer: 0,
      clusterCount: 0,

      // 吞噬：猎物生成累加器
      preySpawnAcc: 0,

      // 种子 / 吞噬体的身份 uid。
      // 原型把对象引用长期挂在输入状态上，而细胞池会回收死亡对象：
      // 蓄力超过种子寿命（60s）或吞噬体寿命（90s）后，引用会指向被复用的别的细胞
      // （原第 1756/1772/1245/1583 行会作用到无辜细胞上）。用 spawn 时分配的 uid
      // 做身份校验，正常路径下判定结果与原文件完全一致。
      seedUid: 0,
      phagoUid: 0,

      // 拖尾生成累加器（原型 trailAccum）
      trailAccum: 0,

      // 细胞膜采样临时缓冲（原型模块级 _bx / _by）
      bx: new Float32Array(MEM_N),
      by: new Float32Array(MEM_N),

      // 细胞质径向渐变缓存（原型模块级 _gradCache，持有 ctx 对象故挂到 state）
      gradCache: [Object.create(null), Object.create(null)],

      // 原型自己的鼠标状态（位置用基类的 input.x / input.y）
      mouse: {
        left: false,
        right: false,
        chargeMode: 0,
        chargeT: 0,
        seed: null,
        phago: null
      }
    };
  }

  /* ============================================================
     拖尾 —— 原型在 mousemove 回调里生成（原第 1387~1403 行）
     ============================================================ */
  _emitTrail(s) {
    const M = s.input;
    // 原型在事件处理器内推进锚点（原第 1388~1391 行：input.mx = e.clientX），
    // 属于「事件级」位移，因此用基类的 lx / ly（最后一段位移的起点）。
    const dx = M.x - M.lx;
    const dy = M.y - M.ly;

    const d = Math.hypot(dx, dy);
    if (d > 0.5) {
      s.trailAccum += d;
      let guard = 0;
      while (s.trailAccum > CONFIG.trail.spacing && guard < 4) {
        s.trailAccum -= CONFIG.trail.spacing;
        guard++;
        this._spawnTrailCell(s, M.x, M.y, dx, dy);
      }
    }
  }

  _spawnTrailCell(s, x, y, dx, dy) {
    if (s.freeCells.length < 40) return;
    if (s.cells.length > CONFIG.maxCells * 0.82) return;
    const r = rand(CONFIG.trail.radiusMin, CONFIG.trail.radiusMax);
    const mouse = s.mouse;
    const group = (mouse.chargeMode === 2 || mouse.right) ? 1 : 0;
    const movLen = Math.hypot(dx, dy);
    const spd = Math.min(movLen * 2.2, 110);
    const ang = Math.atan2(dy, dx) + rand(-0.7, 0.7);

    const c = spawnCell(
      s,
      x + rand(-10, 10),
      y + rand(-10, 10),
      r, group,
      {
        rMax: rand(CONFIG.trail.matureMin, CONFIG.trail.matureMax),
        growRate: CONFIG.trail.growRate,
        life: rand(CONFIG.trail.lifeMin, CONFIG.trail.lifeMax),
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd
      }
    );
    if (c && mouse.chargeMode === 1) {
      c.inCluster = true;
    }
    if (c && mouse.chargeMode === 2) {
      c.isPrey = true;
    }
  }

  /* ============================================================
     输入（按键）—— 原型的 mousedown / mouseup / blur
     ============================================================ */
  onPointerDown(e) {
    const s = this.state;
    if (!s) return;
    const mouse = s.mouse;

    if (e.button === 0) {
      mouse.left = true;
      if (!mouse.chargeMode) {
        startCharge(s, 1);
        clickEffect(s, e.clientX, e.clientY, 0);
      }
    } else if (e.button === 2) {
      mouse.right = true;
      if (!mouse.chargeMode) {
        startCharge(s, 2);
        clickEffect(s, e.clientX, e.clientY, 1);
      }
    }
  }

  onPointerUp(e) {
    const s = this.state;
    if (!s) return;
    const mouse = s.mouse;

    if (e.button === 0) {
      mouse.left = false;
      if (mouse.chargeMode === 1) endCharge(s);
    } else if (e.button === 2) {
      mouse.right = false;
      if (mouse.chargeMode === 2) endCharge(s);
    }
  }

  // 失焦时彻底清理蓄力状态，避免残留永存细胞（原型 window blur 的行为）
  onBlur() {
    const s = this.state;
    if (!s) return;
    const mouse = s.mouse;

    if (mouse.seed && !mouse.seed.dead) apoptosisCell(mouse.seed);
    if (mouse.phago && !mouse.phago.dead) mouse.phago.dead = true;
    for (let i = 0; i < s.cells.length; i++) {
      const c = s.cells[i];
      if (c.inCluster) {
        c.inCluster = false;
        c.canDivide = false;
      }
    }
    mouse.left = false;
    mouse.right = false;
    mouse.chargeMode = 0;
    mouse.chargeT = 0;
    mouse.seed = null;
    mouse.phago = null;
    s.seedUid = 0;
    s.phagoUid = 0;
    s.pseudopods.length = 0;
    s.burstCenter = null;
  }

  /* ============================================================
     尺寸 —— 只同步动效自己的 W / H，画布尺寸与 DPR 由基类维护
     ============================================================ */
  onResize(width, height) {
    const s = this.state;
    if (!s) return;
    s.W = width;
    s.H = height;
  }

  /* ============================================================
     更新 / 渲染
     ============================================================ */
  update(dt, s) {
    if (!s) return;

    // 拖尾：原型写在 mousemove 回调里，与主循环的 freeze 无关，故放在冻结判定之前
    this._emitTrail(s);

    // 冻结帧：原型 loop 里 freeze > 0 时把 dt 归零（仍照常跑 update / render）
    if (s.freeze > 0) {
      s.freeze -= dt;
      dt = 0;
    }
    if (dt > 0) s.time += dt;

    updateFrame(s, dt);
  }

  render(s) {
    if (!s) return;
    renderFrame(s.ctx, s);
  }
}

if (!customElements.get('cursor-cell')) {
  customElements.define('cursor-cell', CursorCell);
}

export default CursorCell;
