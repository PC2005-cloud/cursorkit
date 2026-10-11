/**
 * cursor-pixel —— 鼠标光标像素块动效。
 *
 * 由 html/像素.html 原型移植：算法流程、数值、视觉表现与原文件一一对应。
 * 作为光标层组件，原型页面自身的行为已剔除：
 *   - 不携带深色页面底色（基类保证 canvas 透明，绘制中也没有整屏填底）；
 *   - 不拦截 contextmenu，宿主页面的右键菜单不受影响；
 *   - 画布创建、DPR 适配、监听注册、rAF 循环均由基类负责。
 *
 * 原型用 mousemove / mousedown / mouseup，因此声明 inputFamily = 'mouse'。
 * 所有运行状态都放在 setup() 返回的 state 上，多实例互不干扰。
 */

import { CursorEffectElement } from '../core/base.js';
import { rand, randInt } from '../core/utils.js';

/* ==================================================================
   CONFIG —— 集中所有可调参数
   ================================================================== */
const CONFIG = {
  // 粒子池上限
  MAX_PARTICLES: 2600,
  // 基础网格尺寸（px）—— 铁律一
  CELL: 4,
  // 步进更新间隔（秒）—— 铁律三，0.05s ≈ 20fps 的更新率
  STEP: 0.05,
  // 蓄力上限时长（秒）
  CHARGE_MAX: 2.5,
  // 蓄力不足判定阈值（秒）
  CLICK_THRESHOLD: 0.12,

  // 左键像素化：网格半径范围（px）
  GRID_R_MIN: 20,
  GRID_R_MAX: 220,
  // 左键像素化：单元格尺寸范围（px）
  CELL_MIN: 2,
  CELL_MAX: 12,

  // 拖尾寿命范围（秒）
  TRAIL_LIFE_MIN: 0.6,
  TRAIL_LIFE_MAX: 1.5,
  // 拖尾颜色跳变间隔（秒）
  TRAIL_HUE_STEP: 0.25,
  // 拖尾闪烁概率
  TRAIL_FLICKER_CHANCE: 0.03,

  // 像素化脉冲：波前最大切比雪夫半径（px）
  PULSE_R: 200,
  // 像素化脉冲：扩散时长（秒）
  PULSE_TIME: 0.25,

  // 爆裂力度基准
  BURST_SPEED_MIN: 200,
  BURST_SPEED_MAX: 500,

  // 右键：扫描线数量范围
  SCAN_MIN: 3,
  SCAN_MAX: 20,
  // 右键：扫描线长度范围
  SCAN_LEN_MIN: 60,
  SCAN_LEN_MAX: 240,
  // 右键：通道分离最大水平偏移（px）
  SPLIT_MAX: 12,

  // 左键（像素化，冷色 8-bit）
  PALETTE_PIXEL: [
    '#0A0A1E', '#1E1E4B', '#2B4A9C', '#2B7BFF',
    '#4FE3FF', '#9B5CFF', '#FFFFFF', '#FF4FD8'
  ],
  // 右键（故障，RGB 分离色）
  PALETTE_GLITCH: [
    '#000000', '#FF0040', '#3DFF7A', '#4060FF',
    '#00FFFF', '#FF00FF', '#FFFF00', '#FFFFFF'
  ]
};

const PAL_PIXEL = CONFIG.PALETTE_PIXEL;
const PAL_GLITCH = CONFIG.PALETTE_GLITCH;

const MAXP = CONFIG.MAX_PARTICLES;

const K_BLOCK = 0, K_CLUSTER = 1, K_SCAN = 2, K_RING = 3;

/* ==================================================================
   工具函数
   ================================================================== */
// 网格吸附（乘法取整，避免 Math.round 调用）
function snap(v, c) { return ((v / c) | 0) * c; }

// 确定性散列，用于 dithering / 抖动
function hash2(x, y, z) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (z | 0) * 1442695040;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return ((h >>> 0) % 100000) / 100000;
}

// 8 个切比雪夫主方向
const D8 = [];
for (let i = 0; i < 8; i++) {
  const a = i * Math.PI / 4;
  D8.push({ x: Math.cos(a), y: Math.sin(a) });
}

// 把任意方向对齐到最近的 45° 倍数
function chebDir(dx, dy) {
  const a = Math.atan2(dy, dx);
  const s = Math.PI / 4;
  let idx = Math.round(a / s);
  idx = ((idx % 8) + 8) % 8;
  return D8[idx];
}

// 网格量化：单元格数取整，至少 1 格
function quantSize(v, c) {
  let n = Math.round(v / c);
  if (n < 1) n = 1;
  return n * c;
}

// 调色板（铁律二：只取固定值，绝不插值）
function paletteOf(pal) { return pal === 0 ? PAL_PIXEL : PAL_GLITCH; }

/* ==================================================================
   粒子池 —— 定长数组 + 循环游标，超出回收最老
   ================================================================== */
function makeParticle() {
  return {
    alive: false,
    kind: K_BLOCK,
    x: 0, y: 0, vx: 0, vy: 0,
    size: 4,
    ci: 0,
    pal: 0,
    life: 1, maxLife: 1,
    acc: 0,
    hueTimer: 0, hueStep: 0,
    dark: false,
    flicker: 0, flickerTimer: 0, flickerOn: true,
    split: 0,
    cells: null,
    len: 0, thick: 2,
    delay: 0,
    drag: 0,
    ringSize: 0, ringSpeed: 0,
    cell: 0,
    pixelated: false,
    homeX: 0, homeY: 0, returnTimer: 0
  };
}

function allocParticle(s) {
  const p = s.pool[s.poolIdx];
  s.poolIdx++;
  if (s.poolIdx >= MAXP) s.poolIdx = 0;

  p.alive = true;
  p.kind = K_BLOCK;
  p.vx = 0; p.vy = 0;
  p.size = CONFIG.CELL;
  p.ci = 0;
  p.pal = 0;
  p.life = 1; p.maxLife = 1;
  p.acc = 0;
  p.hueTimer = 0; p.hueStep = 0;
  p.dark = false;
  p.flicker = 0; p.flickerTimer = 0; p.flickerOn = true;
  p.split = 0;
  p.cells = null;
  p.len = 0; p.thick = 2;
  p.delay = 0;
  p.drag = 0;
  p.ringSize = 0; p.ringSpeed = 0;
  p.cell = 0;
  p.pixelated = false;
  p.homeX = 0; p.homeY = 0; p.returnTimer = 0;
  return p;
}

/* ==================================================================
   拖尾系统
   ================================================================== */
function spawnTrailBlock(s, x, y) {
  const p = allocParticle(s);
  p.kind = K_BLOCK;
  p.x = x;
  p.y = y;
  p.vx = rand(-10, 10);
  p.vy = rand(-10, 10);
  p.size = CONFIG.CELL * (Math.random() < 0.75 ? 1 : 2);
  p.pal = 0;
  p.ci = (Math.random() * 8) | 0;
  p.maxLife = rand(CONFIG.TRAIL_LIFE_MIN, CONFIG.TRAIL_LIFE_MAX);
  p.life = p.maxLife;
  p.hueTimer = CONFIG.TRAIL_HUE_STEP;
  p.hueStep = CONFIG.TRAIL_HUE_STEP;
  p.drag = 1.2;
  if (Math.random() < CONFIG.TRAIL_FLICKER_CHANCE) {
    p.flicker = randInt(2, 3);
    p.flickerTimer = 0.05;
  }
}

function doTrailSample(s) {
  const gc = s.gridCell;
  const cx = snap(s.input.x, gc);
  const cy = snap(s.input.y, gc);

  if (s.samplePX === null) {
    s.samplePX = cx;
    s.samplePY = cy;
    return;
  }
  if (cx === s.samplePX && cy === s.samplePY) return;

  const dx = cx - s.samplePX;
  const dy = cy - s.samplePY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  let n = Math.ceil(dist / gc);
  if (n < 1) n = 1;
  if (n > 12) n = 12;

  for (let i = 1; i <= n; i++) {
    const t = i / n;
    spawnTrailBlock(
      s,
      snap(s.samplePX + dx * t, gc),
      snap(s.samplePY + dy * t, gc)
    );
  }
  s.samplePX = cx;
  s.samplePY = cy;
}

function updateTrailSampling(s, dt) {
  const inp = s.input;
  if (!inp.inside) return;

  // 原型的 mouseInside 只会被 mousemove / mousedown 置 true；
  // 基类的 inside 还会被 mouseenter 置 true，而那一刻 x/y 可能仍是上一次的旧值。
  // 若此时就采样，会把旧位置写进 samplePX，紧接着的真实移动会从旧位置拉出一串拖尾。
  // 因此必须等到坐标真的变过一次，才认为收到了新的鼠标事件。
  if (s.pending) {
    if (inp.x === s.seenX && inp.y === s.seenY) return;
    s.pending = false;
  }

  s.trailAcc += dt;
  const step = CONFIG.STEP;
  let guard = 0;
  while (s.trailAcc >= step && guard < 4) {
    s.trailAcc -= step;
    guard++;
    doTrailSample(s);
  }
  if (s.trailAcc > 0.4) s.trailAcc = 0;
}

/* ==================================================================
   像素化脉冲（点击时对拖尾的冲击）
   ================================================================== */
function pixelateParticle(p) {
  const c = 8;
  p.cell = c;
  p.x = snap(p.x, c);
  p.y = snap(p.y, c);
  p.kind = K_BLOCK;
  p.size = c * (Math.random() < 0.6 ? 1 : 2);
  p.dark = true;
  p.pal = 0;
  p.ci = (Math.random() * 8) | 0;
  // 速度方向对齐到 8 个切比雪夫方向
  let sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
  if (sp < 1) sp = 24;
  const d = chebDir(p.vx, p.vy);
  p.vx = d.x * sp;
  p.vy = d.y * sp;
  p.pixelated = true;
  p.hueStep = 0.2;
  p.hueTimer = 0.2;
}

function triggerPulse(s, x, y) {
  const pu = s.pulse;
  pu.active = true;
  pu.x = x;
  pu.y = y;
  pu.r = 0;
  pu.maxR = CONFIG.PULSE_R;
  pu.t = 0;
  pu.dur = CONFIG.PULSE_TIME;
  pu.fxTimer = 0;

  // 从光标向外飞出 20~30 个像素块
  const n = randInt(20, 30);
  for (let i = 0; i < n; i++) {
    const d = D8[(Math.random() * 8) | 0];
    const spd = rand(CONFIG.BURST_SPEED_MIN, CONFIG.BURST_SPEED_MAX);
    const p = allocParticle(s);
    p.kind = K_BLOCK;
    p.x = x;
    p.y = y;
    p.vx = d.x * spd + rand(-40, 40);
    p.vy = d.y * spd + rand(-40, 40);
    p.size = rand(3, 8);
    p.pal = 0;
    p.ci = (Math.random() * 8) | 0;
    p.maxLife = rand(0.35, 0.7);
    p.life = p.maxLife;
    p.hueStep = 0.2;
    p.hueTimer = 0.2;
    p.dark = true;
    p.cell = 8;
  }
}

function spawnWaveFrontBlock(s, cx, cy, r) {
  const side = (Math.random() * 4) | 0;
  const o = (Math.random() * 2 - 1) * r;
  let x, y;
  if (side === 0) { x = cx + o; y = cy - r; }
  else if (side === 1) { x = cx + o; y = cy + r; }
  else if (side === 2) { x = cx - r; y = cy + o; }
  else { x = cx + r; y = cy + o; }

  const p = allocParticle(s);
  p.kind = K_BLOCK;
  p.x = x;
  p.y = y;
  p.size = 8;
  p.pal = 0;
  p.ci = randInt(3, 6);
  p.maxLife = 0.08;
  p.life = 0.08;
  p.cell = 8;
  p.dark = true;
}

function updatePulse(s, dt) {
  const pu = s.pulse;
  if (!pu.active) return;
  pu.t += dt;
  pu.r = (pu.t / pu.dur) * pu.maxR;
  if (pu.t >= pu.dur) {
    pu.active = false;
    // 波前扩散到最大后，光标处短暂出现 16x16 网格线框
    s.gridFx.life = 0.2;
    s.gridFx.maxLife = 0.2;
    s.gridFx.x = snap(pu.x, 8);
    s.gridFx.y = snap(pu.y, 8);
    s.gridFx.size = 128;
    s.gridFx.cell = 8;
    return;
  }

  pu.fxTimer -= dt;
  if (pu.fxTimer <= 0) {
    pu.fxTimer = 0.03;
    for (let k = 0; k < 4; k++) spawnWaveFrontBlock(s, pu.x, pu.y, pu.r);
  }

  for (let i = 0; i < MAXP; i++) {
    const p = s.pool[i];
    if (!p.alive || p.pixelated) continue;
    const d = Math.max(Math.abs(p.x - pu.x), Math.abs(p.y - pu.y));
    if (d <= pu.r) pixelateParticle(p);
  }
}

/* ==================================================================
   单击（左键按下瞬间）
   ================================================================== */
function leftClick(s) {
  const gc = s.gridCell;
  const cx = snap(s.input.x, gc);
  const cy = snap(s.input.y, gc);

  // ---- 微型方块群 3x3 ~ 4x4 ----
  const n = randInt(3, 4);
  let cells = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (Math.random() < 0.75) {
        cells.push({ dx: i - (n >> 1), dy: j - (n >> 1), ci: (Math.random() * 8) | 0 });
      }
    }
  }
  if (cells.length < 9) {
    cells = [];
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        cells.push({ dx: a - (n >> 1), dy: b - (n >> 1), ci: (Math.random() * 8) | 0 });
      }
    }
  }

  // 每块先亮一下（0.04s），再沿切比雪夫方向爆破
  for (let c = 0; c < cells.length; c++) {
    const cc = cells[c];
    const px = cx + cc.dx * gc;
    const py = cy + cc.dy * gc;
    const dir = chebDir(cc.dx, cc.dy === 0 && cc.dx === 0 ? 1 : cc.dy);
    const spd = rand(CONFIG.BURST_SPEED_MIN, CONFIG.BURST_SPEED_MAX);
    const p = allocParticle(s);
    p.kind = K_BLOCK;
    p.x = px;
    p.y = py;
    p.vx = dir.x * spd;
    p.vy = dir.y * spd;
    p.size = gc * 1;
    p.pal = 0;
    p.ci = cc.ci;
    p.maxLife = rand(0.45, 0.75);
    p.life = p.maxLife;
    p.hueStep = 0.08;
    p.hueTimer = 0.08;
    p.dark = true;
    p.delay = 0.04;
    p.drag = 1.6;
  }

  // ---- 向外散射 12~18 个独立像素块 ----
  const sc = randInt(12, 18);
  for (let sIdx = 0; sIdx < sc; sIdx++) {
    const d2 = D8[(Math.random() * 8) | 0];
    const sp2 = rand(CONFIG.BURST_SPEED_MIN, CONFIG.BURST_SPEED_MAX);
    const p2 = allocParticle(s);
    p2.kind = K_BLOCK;
    p2.x = cx;
    p2.y = cy;
    p2.vx = d2.x * sp2 + rand(-60, 60);
    p2.vy = d2.y * sp2 + rand(-60, 60);
    p2.size = rand(2, 6);
    p2.pal = 0;
    p2.ci = (Math.random() * 8) | 0;
    p2.maxLife = rand(0.35, 0.7);
    p2.life = p2.maxLife;
    p2.hueStep = 0.15;
    p2.hueTimer = 0.15;
    p2.dark = true;
    p2.drag = 2;
  }

  // ---- 正方形线框环：边长 12 → 80，线宽 3 → 1，0.3s ----
  const ring = allocParticle(s);
  ring.kind = K_RING;
  ring.x = cx;
  ring.y = cy;
  ring.ringSize = 6;
  ring.ringSpeed = (40 - 6) / 0.3;
  ring.thick = 3;
  ring.pal = 0;
  ring.ci = 4;
  ring.maxLife = 0.3;
  ring.life = 0.3;
  ring.dark = false;

  // ---- 中心 8x8 实心亮块：白 → 冰青 → 消失，0.1s ----
  const flash = allocParticle(s);
  flash.kind = K_BLOCK;
  flash.x = cx - 4;
  flash.y = cy - 4;
  flash.size = 8;
  flash.pal = 0;
  flash.ci = 6;
  flash.maxLife = 0.1;
  flash.life = 0.1;
  flash.hueStep = 0.05;
  flash.hueTimer = 0.05;

  // ---- 像素化脉冲（对拖尾的冲击）----
  triggerPulse(s, cx, cy);
}

/* ==================================================================
   左键 —— 像素化 / 降采样
   ================================================================== */
function spawnGridFrag(s, cx, cy, R, k) {
  const cell = s.gridCell;
  const gx = snap(cx + rand(-R, R), cell);
  const gy = snap(cy + rand(-R, R), cell);
  const n = randInt(2, 4);
  const cells = [];
  let dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    cells.push({ dx: dx, dy: dy, ci: randInt(3, 7) });
    if (Math.random() < 0.5) dx += Math.random() < 0.5 ? 1 : -1;
    else dy += Math.random() < 0.5 ? 1 : -1;
  }
  const p = allocParticle(s);
  p.kind = K_CLUSTER;
  p.x = gx;
  p.y = gy;
  p.cells = cells;
  p.cell = cell;
  p.pal = 0;
  p.maxLife = 0.15;
  p.life = 0.15;
}

function spawnOverflow(s, cx, cy, k) {
  const cell = s.gridCell;
  const a = (Math.random() * 4) | 0;
  let ox = 0, oy = 0;
  if (a === 0) { ox = rand(-3, 3) * cell; oy = -2 * cell; }
  else if (a === 1) { ox = rand(-3, 3) * cell; oy = 2 * cell; }
  else if (a === 2) { ox = -2 * cell; oy = rand(-3, 3) * cell; }
  else { ox = 2 * cell; oy = rand(-3, 3) * cell; }

  const p = allocParticle(s);
  p.kind = K_BLOCK;
  p.x = snap(cx + ox, cell);
  p.y = snap(cy + oy, cell);
  p.size = cell;
  p.pal = 0;
  p.ci = 6;
  p.maxLife = 0.12;
  p.life = 0.12;
  p.cell = cell;
}

function updateChargeFx(s, dt, k) {
  const ch = s.charge;
  if (ch.button === 0) {
    // 核心方块颜色跳变
    ch.coreTimer -= dt;
    if (ch.coreTimer <= 0) {
      ch.coreTimer = 0.15;
      ch.coreCi = (Math.random() * 8) | 0;
    }
    // 数据碎片
    ch.fragTimer -= dt;
    if (ch.fragTimer <= 0) {
      ch.fragTimer = Math.max(0.04, 0.2 - 0.16 * k);
      spawnGridFrag(s, ch.x, ch.y, ch.radius, k);
    }
    // 蓄满时数据溢出
    if (k > 0.8 && Math.random() < 0.18) {
      spawnOverflow(s, ch.x, ch.y, k);
    }
  } else {
    // 扫描线外发
    ch.emitTimer -= dt;
    if (ch.emitTimer <= 0) {
      ch.emitTimer = Math.max(0.12, 0.42 - 0.28 * k);
      const y = snap(ch.y + rand(-ch.vRange * 0.5, ch.vRange * 0.5), s.gridCell);
      const p = allocParticle(s);
      p.kind = K_SCAN;
      p.x = ch.x - 100;
      p.y = y;
      p.vx = (Math.random() < 0.5 ? -1 : 1) * rand(200, 420);
      p.vy = 0;
      p.len = 200;
      p.thick = 2;
      p.pal = 1;
      p.ci = (Math.random() * 8) | 0;
      p.maxLife = 0.35;
      p.life = 0.35;
      p.cell = 2;
    }
    // 数据碎片
    ch.fragTimer -= dt;
    if (ch.fragTimer <= 0) {
      ch.fragTimer = Math.max(0.06, 0.26 - 0.2 * k);
      const cell = 4;
      const gx = snap(ch.x + rand(-120, 120), cell);
      const gy = snap(ch.y + rand(-ch.vRange * 0.5, ch.vRange * 0.5), cell);
      const n = randInt(2, 4);
      const cells = [];
      let ddx = 0, ddy = 0;
      for (let i = 0; i < n; i++) {
        cells.push({ dx: ddx, dy: ddy, ci: randInt(1, 6) });
        if (Math.random() < 0.5) ddx += Math.random() < 0.5 ? 1 : -1;
        else ddy += Math.random() < 0.5 ? 1 : -1;
      }
      const fp = allocParticle(s);
      fp.kind = K_CLUSTER;
      fp.x = gx;
      fp.y = gy;
      fp.cells = cells;
      fp.cell = cell;
      fp.pal = 1;
      fp.maxLife = 0.1;
      fp.life = 0.1;
    }
  }
}

function leftBurst(s, power) {
  const gc = s.gridCell;
  const cx = snap(s.input.x, gc);
  const cy = snap(s.input.y, gc);

  // ---- 核心碎裂：64 个小方块（8x8）----
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      const px = cx - 32 + i * 8 + 4;
      const py = cy - 32 + j * 8 + 4;
      const dir = chebDir(px - cx, py - cy);
      const spd = rand(200, 600) * (0.6 + power);
      const p = allocParticle(s);
      p.kind = K_BLOCK;
      p.x = px;
      p.y = py;
      p.vx = dir.x * spd;
      p.vy = dir.y * spd;
      p.size = 8;
      p.pal = 0;
      p.ci = 6;
      p.maxLife = rand(0.5, 0.9);
      p.life = p.maxLife;
      p.hueStep = 0.2;
      p.hueTimer = 0.2;
      p.dark = true;
      p.delay = 0.05;
      p.drag = 1.1;
      p.cell = 8;
    }
  }

  // ---- 方形冲击波（正方形扩散轮廓）----
  const ring = allocParticle(s);
  ring.kind = K_RING;
  ring.x = cx;
  ring.y = cy;
  ring.ringSize = 20;
  ring.ringSpeed = (200 + 400 * power) / 0.35;
  ring.thick = 4;
  ring.pal = 0;
  ring.ci = 6;
  ring.maxLife = 0.35;
  ring.life = 0.35;

  // ---- 网格碎裂纹波（按切比雪夫距离由内向外依次爆开）----
  const gcStep = 16;
  const range = 200;
  for (let gx2 = -range; gx2 <= range; gx2 += gcStep) {
    for (let gy2 = -range; gy2 <= range; gy2 += gcStep) {
      const dist = Math.max(Math.abs(gx2), Math.abs(gy2));
      if (Math.random() > 0.22) continue;
      const delay = (dist / range) * 0.35;
      const ddx = gx2 / range;
      const ddy = gy2 / range;
      const mag = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
      const dir2 = chebDir(ddx, ddy);
      const spd2 = rand(120, 380) * (0.6 + power);
      const pp = allocParticle(s);
      pp.kind = K_BLOCK;
      pp.x = cx + gx2;
      pp.y = cy + gy2;
      pp.vx = dir2.x * spd2;
      pp.vy = dir2.y * spd2;
      pp.size = 8;
      pp.pal = 0;
      pp.ci = randInt(1, 6);
      pp.maxLife = rand(0.35, 0.6);
      pp.life = pp.maxLife;
      pp.hueStep = 0.2;
      pp.hueTimer = 0.2;
      pp.dark = true;
      pp.delay = delay;
      pp.drag = 1.4;
      pp.cell = 8;
      if (mag < 0.001) { pp.vx = rand(-40, 40); pp.vy = rand(-40, 40); }
    }
  }

  // ---- 像素碎片风暴 ----
  const count = Math.floor(120 + 350 * power);
  for (let sIdx = 0; sIdx < count; sIdx++) {
    const d3 = D8[(Math.random() * 8) | 0];
    const spd3 = rand(200, 200 + 800 * power);
    const p3 = allocParticle(s);
    p3.kind = K_BLOCK;
    p3.x = cx + rand(-20, 20);
    p3.y = cy + rand(-20, 20);
    p3.vx = d3.x * spd3 + rand(-70, 70);
    p3.vy = d3.y * spd3 + rand(-70, 70);
    p3.size = rand(2, 10);
    p3.pal = 0;
    p3.ci = (Math.random() * 8) | 0;
    p3.maxLife = rand(0.5, 1.1);
    p3.life = p3.maxLife;
    p3.hueStep = 0.2;
    p3.hueTimer = 0.2;
    p3.dark = true;
    p3.drag = 0.9;
    p3.cell = 8;
  }

  // ---- 拖尾全面像素化 ----
  for (let q = 0; q < MAXP; q++) {
    const pq = s.pool[q];
    if (!pq.alive) continue;
    if (!pq.pixelated) pixelateParticle(pq);
  }

  // ---- 方形残迹 ----
  s.gridFx.life = 0.6;
  s.gridFx.maxLife = 0.6;
  s.gridFx.x = cx;
  s.gridFx.y = cy;
  s.gridFx.size = Math.max(160, s.charge.radius * 1.6);
  s.gridFx.cell = 16;

  // ---- 余韵 ----
  s.afterglow.timer = 1.0;
  s.afterglow.spawn = 0;
  s.afterglow.x = cx;
  s.afterglow.y = cy;
  s.afterglow.mode = 0;
}

/* ==================================================================
   右键 —— 扫描线故障
   ================================================================== */
function rightClick(s) {
  const gc = 4;
  const cx = snap(s.input.x, gc);
  const cy = snap(s.input.y, gc);

  // 小的扫描线扩散
  for (let i = 0; i < 10; i++) {
    const p = allocParticle(s);
    p.kind = K_SCAN;
    p.x = cx - 40;
    p.y = snap(cy + rand(-30, 30), 4);
    p.vx = (Math.random() < 0.5 ? -1 : 1) * rand(150, 320);
    p.vy = 0;
    p.len = rand(60, 140);
    p.thick = 2;
    p.pal = 1;
    p.ci = (Math.random() * 8) | 0;
    p.maxLife = 0.3;
    p.life = 0.3;
    p.cell = 2;
  }

  // 少量通道分离
  for (let q = 0; q < MAXP; q++) {
    const pq = s.pool[q];
    if (!pq.alive) continue;
    const dd = Math.abs(pq.y - cy);
    if (dd < 60) pq.split = 6;
  }

  // 一个数据块闪烁
  const flash = allocParticle(s);
  flash.kind = K_BLOCK;
  flash.x = cx - 4;
  flash.y = cy - 4;
  flash.size = 8;
  flash.pal = 1;
  flash.ci = 6;
  flash.maxLife = 0.1;
  flash.life = 0.1;
  flash.hueStep = 0.05;
  flash.hueTimer = 0.05;
}

function rightBurst(s, power) {
  const gc = 4;
  const cx = snap(s.input.x, gc);
  const cy = snap(s.input.y, gc);

  // ---- 数据核心碎裂成 8x8 的数据碎片 ----
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      const px = cx - 32 + i * 8;
      const py = cy - 32 + j * 8;
      const n = randInt(2, 4);
      const cells = [];
      let ddx = 0, ddy = 0;
      for (let c = 0; c < n; c++) {
        cells.push({ dx: ddx, dy: ddy, ci: randInt(1, 6) });
        if (Math.random() < 0.5) ddx += Math.random() < 0.5 ? 1 : -1;
        else ddy += Math.random() < 0.5 ? 1 : -1;
      }
      const dir = chebDir(px - cx, py - cy);
      const spd = rand(300, 800);
      const p = allocParticle(s);
      p.kind = K_CLUSTER;
      p.x = px;
      p.y = py;
      p.cells = cells;
      p.cell = 4;
      p.vx = dir.x * spd + rand(-60, 60);
      p.vy = dir.y * spd + rand(-60, 60);
      p.pal = 1;
      p.maxLife = rand(0.5, 0.9);
      p.life = p.maxLife;
      p.hueStep = 0.15;
      p.hueTimer = 0.15;
      p.drag = 1.0;
    }
  }

  // ---- 全屏扫描（上下两个方向同时发射）----
  const upCount = Math.floor(10 + 30 * power);
  const downCount = Math.floor(10 + 30 * power);
  let k2;
  for (k2 = 0; k2 < upCount; k2++) {
    const pUp = allocParticle(s);
    pUp.kind = K_SCAN;
    pUp.x = cx - rand(100, 200);
    pUp.y = snap(cy + rand(-30, 30), 4);
    pUp.vx = 0;
    pUp.vy = -(400 + 1200 * power);
    pUp.len = rand(200, 400);
    pUp.thick = rand(2, 4) | 0;
    pUp.pal = 1;
    pUp.ci = randInt(1, 6);
    pUp.maxLife = rand(0.6, 1.2);
    pUp.life = pUp.maxLife;
    pUp.cell = 2;
  }
  for (k2 = 0; k2 < downCount; k2++) {
    const pDn = allocParticle(s);
    pDn.kind = K_SCAN;
    pDn.x = cx - rand(100, 200);
    pDn.y = snap(cy + rand(-30, 30), 4);
    pDn.vx = 0;
    pDn.vy = (400 + 1200 * power);
    pDn.len = rand(200, 400);
    pDn.thick = rand(2, 4) | 0;
    pDn.pal = 1;
    pDn.ci = randInt(1, 6);
    pDn.maxLife = rand(0.6, 1.2);
    pDn.life = pDn.maxLife;
    pDn.cell = 2;
  }

  // ---- 水平撕裂：随机水平带内的粒子水平偏移 ----
  const bandCount = Math.floor(10 + 20 * power);
  const bands = [];
  for (let b = 0; b < bandCount; b++) {
    bands.push({
      y: Math.random() * s.H,
      h: rand(4, 20)
    });
  }
  const shift = (30 + 90 * power);

  // ---- 拖尾水平错位 + 全场通道分离 ----
  for (let q = 0; q < MAXP; q++) {
    const pq = s.pool[q];
    if (!pq.alive) continue;

    // 水平错位
    const off = rand(20, 80) * (Math.random() < 0.5 ? -1 : 1);
    pq.homeX = pq.x;
    pq.homeY = pq.y;
    pq.x += off;
    pq.returnTimer = 0.3;

    // 通道分离
    pq.split = (8 + Math.random() * 16) * Math.max(0.4, power);

    // 水平撕裂
    for (let bi = 0; bi < bands.length; bi++) {
      if (pq.y >= bands[bi].y && pq.y <= bands[bi].y + bands[bi].h) {
        pq.x += (Math.random() < 0.5 ? -1 : 1) * rand(30, 120) * Math.max(0.4, power);
        break;
      }
    }
  }

  // 让撕裂偏移也回归
  for (let q2 = 0; q2 < MAXP; q2++) {
    const pq2 = s.pool[q2];
    if (pq2.alive) pq2.returnTimer = Math.max(pq2.returnTimer, 0.15);
  }
  // 撕裂立即恢复（0.15s），错位较慢（0.3s）
  for (let q3 = 0; q3 < MAXP; q3++) {
    const pq3 = s.pool[q3];
    if (pq3.alive) pq3.returnTimer = 0.15;
  }

  // ---- 扫描线残迹 ----
  for (let r = 0; r < 5; r++) {
    const up = allocParticle(s);
    up.kind = K_SCAN;
    up.x = cx - rand(20, 60);
    up.y = snap(cy + rand(-40, 40), 2);
    up.vx = 0;
    up.vy = -rand(200, 400);
    up.len = rand(20, 60);
    up.thick = 2;
    up.pal = 1;
    up.ci = randInt(1, 6);
    up.maxLife = 0.8;
    up.life = 0.8;
    up.cell = 2;

    const dn = allocParticle(s);
    dn.kind = K_SCAN;
    dn.x = cx - rand(20, 60);
    dn.y = snap(cy + rand(-40, 40), 2);
    dn.vx = 0;
    dn.vy = rand(200, 400);
    dn.len = rand(20, 60);
    dn.thick = 2;
    dn.pal = 1;
    dn.ci = randInt(1, 6);
    dn.maxLife = 0.8;
    dn.life = 0.8;
    dn.cell = 2;
  }

  // ---- 余韵 ----
  s.afterglow.timer = 1.0;
  s.afterglow.spawn = 0;
  s.afterglow.x = cx;
  s.afterglow.y = cy;
  s.afterglow.mode = 1;
}

/* ==================================================================
   粒子更新
   ================================================================== */
function updateParticles(s, dt) {
  const step = CONFIG.STEP;

  for (let i = 0; i < MAXP; i++) {
    const p = s.pool[i];
    if (!p.alive) continue;

    // 延迟（用于碎裂波纹）
    if (p.delay > 0) {
      p.delay -= dt;
      continue;
    }

    // 寿命
    p.life -= dt;
    if (p.life <= 0) {
      p.alive = false;
      continue;
    }

    // 闪烁
    if (p.flicker > 0) {
      p.flickerTimer -= dt;
      if (p.flickerTimer <= 0) {
        p.flickerTimer = 0.05;
        p.flickerOn = !p.flickerOn;
        p.flicker--;
      }
    }

    // 通道分离收敛
    if (p.split > 0) {
      p.split -= dt * 60;
      if (p.split < 0) p.split = 0;
    }

    // 水平错位回归
    if (p.returnTimer > 0) {
      p.returnTimer -= dt;
      const f = Math.min(dt * 6, 1);
      p.x += (p.homeX - p.x) * f;
      p.y += (p.homeY - p.y) * f;
      if (p.returnTimer <= 0) p.returnTimer = 0;
      continue;
    }

    // 阻尼
    if (p.drag > 0) {
      let damp = 1 - p.drag * dt;
      if (damp < 0) damp = 0;
      p.vx *= damp;
      p.vy *= damp;
    }

    // ---- 步进更新（铁律三）----
    p.acc += dt;
    let guard = 0;
    while (p.acc >= step && guard < 6) {
      p.acc -= step;
      guard++;

      p.x += p.vx * step;
      p.y += p.vy * step;

      // 颜色跳变到调色板中的另一色（绝不插值）
      if (p.hueStep > 0) {
        p.hueTimer -= step;
        if (p.hueTimer <= 0) {
          p.hueTimer = p.hueStep;
          p.ci = (Math.random() * 8) | 0;
        }
      }

      // 方形环扩散
      if (p.kind === K_RING) {
        p.ringSize += p.ringSpeed * step;
      }
    }
  }
}

/* ==================================================================
   抖动（跳格抖动，吸附网格）
   ================================================================== */
function updateJitter(s, dt) {
  const inp = s.input;
  const gc = s.gridCell;

  if (!s.charge.active) {
    s.jitterX = 0;
    s.jitterY = 0;
    s.charge.x = snap(inp.x, gc);
    s.charge.y = snap(inp.y, gc);
    return;
  }

  const k = s.charge.time / CONFIG.CHARGE_MAX;
  s.jitterTimer -= dt;
  if (s.jitterTimer <= 0) {
    s.jitterTimer = CONFIG.STEP;
    if (k > 0.55) {
      const amp = 1 + ((k - 0.55) / 0.45) * 2;
      if (s.charge.button === 0) {
        s.jitterX = (Math.random() * 2 - 1) * amp * gc;
        s.jitterY = (Math.random() * 2 - 1) * amp * gc;
      } else {
        s.jitterX = (Math.random() * 2 - 1) * amp * gc;
        s.jitterY = (Math.random() * 2 - 1) * amp * gc * 0.4;
      }
      s.jitterX = Math.round(s.jitterX / gc) * gc;
      s.jitterY = Math.round(s.jitterY / gc) * gc;
    } else {
      s.jitterX = 0;
      s.jitterY = 0;
    }
  }

  s.charge.x = snap(inp.x + s.jitterX, gc);
  s.charge.y = snap(inp.y + s.jitterY, gc);
}

/* ==================================================================
   蓄力更新
   ================================================================== */
function updateCharge(s, dt) {
  const ch = s.charge;
  if (ch.active) {
    ch.time += dt;
    const t = Math.min(ch.time, CONFIG.CHARGE_MAX);
    const k = t / CONFIG.CHARGE_MAX;
    ch.power = Math.pow(k, 1.6);
    ch.radius = CONFIG.GRID_R_MIN + (CONFIG.GRID_R_MAX - CONFIG.GRID_R_MIN) * k;
    ch.cell = Math.round(CONFIG.CELL_MIN + (CONFIG.CELL_MAX - CONFIG.CELL_MIN) * k);
    s.gridCell = ch.cell;
  } else {
    s.gridCell = CONFIG.CELL;
  }
}

/* ==================================================================
   余韵
   ================================================================== */
function updateAfterglow(s, dt) {
  const ag = s.afterglow;
  if (ag.timer <= 0) return;
  ag.timer -= dt;
  ag.spawn -= dt;
  if (ag.spawn > 0) return;
  ag.spawn = 0.06;

  const p = allocParticle(s);
  if (ag.mode === 0) {
    // 左键：小像素块以步进方式缓慢向上飘动
    p.kind = K_BLOCK;
    p.x = snap(ag.x + rand(-40, 40), 4);
    p.y = snap(ag.y + rand(-40, 40), 4);
    p.vx = 0;
    p.vy = -30;
    p.size = rand(2, 4);
    p.pal = 0;
    p.ci = (Math.random() * 8) | 0;
    p.maxLife = 0.7;
    p.life = 0.7;
    p.hueStep = 0.2;
    p.hueTimer = 0.2;
    p.cell = 4;
  } else {
    // 右键：小的水平扫描线缓慢向外扩散
    p.kind = K_SCAN;
    p.x = ag.x - 30;
    p.y = snap(ag.y + rand(-30, 30), 2);
    p.vx = (Math.random() < 0.5 ? -1 : 1) * rand(60, 140);
    p.vy = 0;
    p.len = rand(20, 60);
    p.thick = 2;
    p.pal = 1;
    p.ci = randInt(1, 6);
    p.maxLife = 0.6;
    p.life = 0.6;
    p.cell = 2;
  }
}

/* ==================================================================
   扫描线系统更新（右键蓄力期间的拖尾水平错位由绘制时处理）
   ================================================================== */
function applyScanDisplacement(s, dt) {
  if (!s.charge.active || s.charge.button !== 2) return;
  const k = Math.min(s.charge.time / CONFIG.CHARGE_MAX, 1);
  if (k < 0.1) return;
  if (Math.random() > 0.06 * (0.3 + k)) return;

  for (let i = 0; i < MAXP; i++) {
    const p = s.pool[i];
    if (!p.alive) continue;
    const d = Math.abs(p.y - s.charge.y);
    if (d < s.charge.vRange * 0.5) {
      p.x += (Math.random() < 0.5 ? -1 : 1) * rand(10, 40) * k;
    }
  }
}

/* ==================================================================
   渲染 —— 粒子
   ================================================================== */
function drawParticle(ctx, s, p) {
  const gc = p.cell || s.gridCell;
  const gx = snap(p.x, gc);
  const gy = snap(p.y, gc);
  const pal = paletteOf(p.pal);

  // 量化透明度（跳变，不插值）
  const lr = p.life / p.maxLife;
  let a = lr > 0.75 ? 1 : (lr > 0.45 ? 0.8 : (lr > 0.2 ? 0.6 : 0.4));
  if (p.flicker > 0 && !p.flickerOn) a = 0.25;

  // 生命末期跳到最暗色
  let ci = p.ci;
  if (lr < 0.15) ci = 0;
  if (ci < 0 || ci > 7) ci = 0;

  ctx.globalAlpha = a;

  if (p.kind === K_BLOCK) {
    const sz = quantSize(p.size, gc);
    if (p.split > 0.5) {
      const sp = p.split;
      ctx.fillStyle = PAL_GLITCH[1];
      ctx.fillRect(gx - sp, gy, sz, sz);
      ctx.fillStyle = PAL_GLITCH[2];
      ctx.fillRect(gx, gy, sz, sz);
      ctx.fillStyle = PAL_GLITCH[3];
      ctx.fillRect(gx + sp, gy, sz, sz);
    } else {
      if (p.dark) {
        ctx.fillStyle = pal[0];
        ctx.fillRect(gx + 1, gy + 1, sz, sz);
      }
      ctx.fillStyle = pal[ci];
      ctx.fillRect(gx, gy, sz, sz);
    }
  } else if (p.kind === K_CLUSTER) {
    const cells = p.cells;
    if (cells) {
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        let cci = c.ci;
        if (cci < 0 || cci > 7) cci = 0;
        ctx.fillStyle = pal[cci];
        ctx.fillRect(gx + c.dx * gc, gy + c.dy * gc, gc, gc);
      }
    }
  } else if (p.kind === K_SCAN) {
    if (p.split > 0.5) {
      const sp2 = p.split;
      ctx.fillStyle = PAL_GLITCH[1];
      ctx.fillRect(gx - sp2, gy, p.len, p.thick);
      ctx.fillStyle = PAL_GLITCH[2];
      ctx.fillRect(gx, gy, p.len, p.thick);
      ctx.fillStyle = PAL_GLITCH[3];
      ctx.fillRect(gx + sp2, gy, p.len, p.thick);
    } else {
      ctx.fillStyle = pal[ci];
      ctx.fillRect(gx, gy, p.len, p.thick);
    }
  } else if (p.kind === K_RING) {
    const rs = p.ringSize | 0;
    const th = Math.max(1, p.thick | 0);
    const prog = 1 - p.life / p.maxLife;
    const rci = prog < 0.33 ? 6 : (prog < 0.66 ? 3 : 1);
    ctx.fillStyle = pal[rci];
    ctx.fillRect(gx - rs, gy - rs, rs * 2, th);
    ctx.fillRect(gx - rs, gy + rs - th, rs * 2, th);
    ctx.fillRect(gx - rs, gy - rs, th, rs * 2);
    ctx.fillRect(gx + rs - th, gy - rs, th, rs * 2);
  }

  ctx.globalAlpha = 1;
}

/* ==================================================================
   渲染 —— 左键蓄力（像素网格 + 核心数据块）
   ================================================================== */
function drawLeftCharge(ctx, s) {
  const ch = s.charge;
  const cx = ch.x;
  const cy = ch.y;
  const R = ch.radius;
  const cell = s.gridCell;
  const k = Math.min(ch.time / CONFIG.CHARGE_MAX, 1);

  const x0 = Math.floor((cx - R) / cell) * cell;
  const x1 = cx + R;
  const y0 = Math.floor((cy - R) / cell) * cell;
  const y1 = cy + R;

  // ---- 网格线 ----
  ctx.globalAlpha = 0.55 + 0.35 * k;
  ctx.strokeStyle = PAL_PIXEL[2];
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = x0; x <= x1; x += cell) {
    const xx = (x | 0) + 0.5;
    ctx.moveTo(xx, (y0 | 0) + 0.5);
    ctx.lineTo(xx, (y1 | 0) + 0.5);
  }
  for (let y = y0; y <= y1; y += cell) {
    const yy = (y | 0) + 0.5;
    ctx.moveTo((x0 | 0) + 0.5, yy);
    ctx.lineTo((x1 | 0) + 0.5, yy);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // ---- 边缘 dithering（棋盘格交错）----
  const edgeCells = 2;
  const tk = Math.floor(ch.time * (14 + 24 * k));
  const threshold = 0.78 - 0.42 * k;
  const ringW = edgeCells * cell;
  for (let ex = x0; ex <= x1; ex += cell) {
    for (let ey = y0; ey <= y1; ey += cell) {
      const inEdge =
        (ex <= x0 + ringW) || (ex >= x1 - ringW - cell) ||
        (ey <= y0 + ringW) || (ey >= y1 - ringW - cell);
      if (!inEdge) continue;
      const ix = (ex / cell) | 0;
      const iy = (ey / cell) | 0;
      if (hash2(ix, iy, tk) < threshold) continue;
      ctx.fillStyle = (((ix + iy) & 1) ? PAL_PIXEL[4] : PAL_PIXEL[3]);
      ctx.fillRect(ex, ey, cell, cell);
    }
  }

  // ---- 核心实心数据块 ----
  const coreBase = 4 + 44 * ch.power;
  const puls = 0.9 + 0.2 * Math.sin(ch.time * (5 + 26 * ch.power));
  let coreSize = coreBase * puls;
  coreSize = quantSize(coreSize, cell);
  const half = coreSize * 0.5;
  const coreX = snap(cx - half, s.gridCell);
  const coreY = snap(cy - half, s.gridCell);

  ctx.fillStyle = PAL_PIXEL[0];
  ctx.fillRect(coreX + 1, coreY + 1, coreSize, coreSize);
  ctx.fillStyle = PAL_PIXEL[ch.coreCi];
  ctx.fillRect(coreX, coreY, coreSize, coreSize);

  // 蓄满时核心再叠一层闪烁白块
  if (ch.power > 0.86 && Math.random() < 0.35) {
    ctx.fillStyle = PAL_PIXEL[6];
    const fw = Math.max(cell, coreSize * 0.3);
    const fx = snap(cx - fw * 0.5, s.gridCell);
    const fy = snap(cy - fw * 0.5, s.gridCell);
    ctx.fillRect(fx, fy, fw, fw);
  }
}

/* ==================================================================
   渲染 —— 右键蓄力（水平扫描线 + 通道分离数据核心）
   ================================================================== */
function drawRightCharge(ctx, s) {
  const ch = s.charge;
  const cx = ch.x;
  const cy = ch.y;
  const k = Math.min(ch.time / CONFIG.CHARGE_MAX, 1);

  const count = Math.round(3 + 17 * k);
  const len = 60 + 180 * k;
  const vRange = 40 + 160 * k;
  const jitterAmp = 2 + 6 * k;

  // 这里写回蓄力状态：下一帧的 updateChargeFx / applyScanDisplacement 依赖这两个值
  ch.vRange = vRange;
  ch.split = 2 + 10 * k;

  const tk = Math.floor(ch.time * (16 + 30 * k));

  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0.5;
    const baseY = cy - vRange * 0.5 + t * vRange;
    const jy = (hash2(i, 1, tk) * 2 - 1) * jitterAmp;
    const glitch = hash2(i, 2, tk) > 0.82 ? (hash2(i, 3, tk) * 2 - 1) * 30 * k : 0;
    const y = snap(baseY + jy, s.gridCell);
    const x = cx - len * 0.5 + glitch;

    let ci = (hash2(i, 4, tk) * 8) | 0;
    if (ci < 0 || ci > 7) ci = 0;
    const th = 2 + ((hash2(i, 5, tk) * 2) | 0);

    ctx.fillStyle = PAL_GLITCH[ci];
    ctx.fillRect(x | 0, y | 0, len, th);

    // 通道分离色边
    if (k > 0.15) {
      const sp = ch.split;
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = PAL_GLITCH[1];
      ctx.fillRect((x - sp) | 0, y | 0, len, th);
      ctx.fillStyle = PAL_GLITCH[3];
      ctx.fillRect((x + sp) | 0, y | 0, len, th);
      ctx.globalAlpha = 1;
    }
  }

  // ---- 数据核心：dithering 棋盘格填充 ----
  const coreSize = quantSize(24 + 40 * k, s.gridCell);
  const ox = snap(cx - coreSize * 0.5, s.gridCell);
  const oy = snap(cy - coreSize * 0.5, s.gridCell);
  const chIdx = Math.floor(ch.time / 0.1) % 3;
  const chanCol = [PAL_GLITCH[1], PAL_GLITCH[2], PAL_GLITCH[3]];
  ctx.fillStyle = chanCol[chIdx];

  const gstep = s.gridCell;
  for (let yy = 0; yy < coreSize; yy += gstep) {
    for (let xx = 0; xx < coreSize; xx += gstep) {
      if (((((xx / gstep) | 0) + ((yy / gstep) | 0)) & 1) === 0) {
        ctx.fillRect(ox + xx, oy + yy, gstep, gstep);
      }
    }
  }
}

/* ==================================================================
   渲染 —— 像素化脉冲波前
   ================================================================== */
function drawPulse(ctx, s) {
  const pu = s.pulse;
  const r = pu.r | 0;
  const t = pu.t / pu.dur;
  const th = Math.max(1, (4 - 3 * t) | 0);
  const ci = t < 0.4 ? 6 : (t < 0.75 ? 3 : 1);

  ctx.globalAlpha = 1 - t * 0.6;
  ctx.fillStyle = PAL_PIXEL[ci];
  const cx = pu.x | 0;
  const cy = pu.y | 0;

  // 用离散像素块拼出方形边框
  const stepPx = 8;
  for (let x = -r; x <= r; x += stepPx) {
    ctx.fillRect(cx + x, cy - r, stepPx, th);
    ctx.fillRect(cx + x, cy + r - th, stepPx, th);
  }
  for (let y = -r; y <= r; y += stepPx) {
    ctx.fillRect(cx - r, cy + y, th, stepPx);
    ctx.fillRect(cx + r - th, cy + y, th, stepPx);
  }
  ctx.globalAlpha = 1;
}

/* ==================================================================
   渲染 —— 方形残迹（空网格，逐格淡出）
   ================================================================== */
function drawGridFx(ctx, s) {
  const g = s.gridFx;
  if (g.life <= 0) return;
  const p = g.life / g.maxLife;
  const half = g.size * 0.5;
  const cell = g.cell;
  const cx = snap(g.x - half, cell);
  const cy = snap(g.y - half, cell);

  ctx.strokeStyle = PAL_PIXEL[4];
  ctx.globalAlpha = p;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const n = Math.round(g.size / cell);
  for (let i = 0; i <= n; i++) {
    const x = cx + i * cell;
    const y = cy + i * cell;
    ctx.moveTo(x + 0.5, cy + 0.5);
    ctx.lineTo(x + 0.5, cy + g.size + 0.5);
    ctx.moveTo(cx + 0.5, y + 0.5);
    ctx.lineTo(cx + g.size + 0.5, y + 0.5);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

export class CursorPixel extends CursorEffectElement {
  /** 主题光标：霓虹青描边 + 电弧装饰 */
  cursorTheme() {
    return {
      edge: '#5ef2e8',
      fill: 'rgba(10, 32, 34, .88)',
      glow: '#5ef2e8',
      deco: { color: [94, 242, 232], style: 'arc', rate: 18, speedGain: 0.28 }
    };
  }

  // 原型用 mousemove / mousedown / mouseup，不是 pointer 事件族
  inputFamily = 'mouse';

  // ==== 初始化 ====
  // 只建池与状态，不注册任何监听（监听归基类）
  setup({ ctx, width, height, input }) {
    // 与原型一致：光标初始在窗口外（原型 mx/my = -9999 且 mouseInside = false）。
    // 若不置 false，首帧就会按 (0,0) 采一次样，首次移动会从左上角拉出一串拖尾。
    input.inside = false;

    const pool = new Array(MAXP);
    for (let i = 0; i < MAXP; i++) pool[i] = makeParticle();

    // 与原型 resize() 一致：像素块需要关闭图像平滑
    ctx.imageSmoothingEnabled = false;
    ctx.lineWidth = 1;

    return {
      // 本实例的画布上下文（已按 DPR 缩放过，统一使用 CSS 像素坐标）
      ctx,

      // 画布尺寸（CSS 像素），由基类 onResize 同步
      W: width,
      H: height,

      input,

      // 当前生效网格尺寸（左键蓄力时会动态变化）
      gridCell: CONFIG.CELL,

      // 抖动偏移（跳格抖动）
      jitterX: 0, jitterY: 0, jitterTimer: 0,

      // 拖尾采样
      trailAcc: 0,
      samplePX: null, samplePY: null,
      // 是否仍在等待「坐标真的变化过一次」（见 updateTrailSampling）
      pending: true, seenX: 0, seenY: 0,

      // 粒子池 —— 定长数组 + 循环游标，超出回收最老
      pool,
      poolIdx: 0,

      // 蓄力状态
      charge: {
        active: false,
        button: 0,
        time: 0,
        power: 0,
        radius: 0,
        cell: CONFIG.CELL,
        x: 0, y: 0,
        coreCi: 6,
        coreTimer: 0,
        fragTimer: 0,
        emitTimer: 0,
        split: 0,
        vRange: 0
      },

      // 像素化脉冲
      pulse: { active: false, x: 0, y: 0, r: 0, maxR: 0, t: 0, dur: 0.25, fxTimer: 0 },

      // 方形残迹（左键爆发后）
      gridFx: { life: 0, maxLife: 0.6, x: 0, y: 0, size: 0, cell: 8 },

      // 余韵发射器
      afterglow: { timer: 0, spawn: 0, x: 0, y: 0, mode: 0 }
    };
  }

  // ==== 输入（按键）====
  // 原型在 mousedown 里同步光标位置，并以按键时刻的位置作为爆发原点
  onPointerDown(e) {
    const s = this.state;
    if (!s) return;
    if (e.button !== 0 && e.button !== 2) return;

    const inp = this.input;
    inp.x = e.clientX;
    inp.y = e.clientY;
    inp.inside = true;

    const ch = s.charge;
    ch.active = true;
    ch.button = e.button;
    ch.time = 0;
    ch.power = 0;
    ch.radius = CONFIG.GRID_R_MIN;
    ch.cell = CONFIG.CELL_MIN;
    ch.coreCi = 6;
    ch.coreTimer = 0;
    ch.fragTimer = 0;
    ch.emitTimer = 0;
    ch.split = 0;
    ch.vRange = 0;
    s.jitterX = 0; s.jitterY = 0; s.jitterTimer = 0;
  }

  onPointerUp(e) {
    const s = this.state;
    if (!s) return;

    const ch = s.charge;
    if (!ch.active) return;
    if (e.button !== ch.button) return;

    const t = ch.time;
    const power = ch.power;
    const btn = ch.button;

    ch.active = false;
    s.jitterX = 0; s.jitterY = 0;
    s.gridCell = CONFIG.CELL;

    if (t < CONFIG.CLICK_THRESHOLD) {
      if (btn === 0) leftClick(s);
      else rightClick(s);
    } else {
      if (btn === 0) leftBurst(s, power);
      else rightBurst(s, power);
    }
  }

  // 失焦时按键状态已丢失（原型 window blur 行为）
  onBlur() {
    const s = this.state;
    if (!s) return;
    s.charge.active = false;
    s.jitterX = 0; s.jitterY = 0;
    s.gridCell = CONFIG.CELL;
    s.input.inside = false;
    s.samplePX = null;
    s.samplePY = null;
    // 重新获得输入前，先等坐标真的变化过一次
    s.pending = true;
    s.seenX = s.input.x;
    s.seenY = s.input.y;
  }

  // 光标移出窗口：原型在 document 的 mouseleave 里只清采样点（inside 由基类置位）
  onPointerLeave() {
    const s = this.state;
    if (!s) return;
    s.samplePX = null;
    s.samplePY = null;
    s.pending = true;
    s.seenX = s.input.x;
    s.seenY = s.input.y;
  }

  // ==== 尺寸 ====
  onResize(width, height) {
    const s = this.state;
    if (!s) return;
    s.W = width;
    s.H = height;
    // 重设画布缓冲会重置上下文状态，这里补回原型的绘制设置
    s.ctx.imageSmoothingEnabled = false;
  }

  // ==== 更新 ====
  update(dt, s) {
    if (!s) return;

    // 蓄力
    updateCharge(s, dt);

    // 抖动
    updateJitter(s, dt);

    // 蓄力特效
    if (s.charge.active) {
      const k = Math.min(s.charge.time / CONFIG.CHARGE_MAX, 1);
      updateChargeFx(s, dt, k);
    }

    // 拖尾采样
    updateTrailSampling(s, dt);

    // 扫描线错位
    applyScanDisplacement(s, dt);

    // 像素化脉冲
    updatePulse(s, dt);

    // 方形残迹寿命
    if (s.gridFx.life > 0) {
      s.gridFx.life -= dt;
      if (s.gridFx.life < 0) s.gridFx.life = 0;
    }

    // 余韵
    updateAfterglow(s, dt);

    // 粒子
    updateParticles(s, dt);
  }

  // ==== 渲染 ====
  render(s) {
    if (!s) return;
    const ctx = s.ctx;

    // 画布缓冲与 DPR 缩放由基类维护，这里统一使用 CSS 像素坐标。
    // 只清屏、不填底色：光标层必须保持透明
    ctx.clearRect(0, 0, s.W, s.H);

    // 粒子
    for (let i = 0; i < MAXP; i++) {
      const p = s.pool[i];
      if (p.alive) drawParticle(ctx, s, p);
    }

    // 蓄力可视化
    if (s.charge.active) {
      if (s.charge.button === 0) drawLeftCharge(ctx, s);
      else drawRightCharge(ctx, s);
    }

    // 像素化波前
    if (s.pulse.active) drawPulse(ctx, s);

    // 方形残迹
    if (s.gridFx.life > 0) drawGridFx(ctx, s);
  }
}

if (!customElements.get('cursor-pixel')) {
  customElements.define('cursor-pixel', CursorPixel);
}

export default CursorPixel;
