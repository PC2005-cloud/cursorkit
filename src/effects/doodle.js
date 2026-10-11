/**
 * cursor-doodle —— 鼠标光标涂鸦动效（左键喷漆 / 右键滴落）。
 *
 * 由 html/涂鸦.html 原型移植：算法流程、数值、视觉表现与原文件一一对应。
 * 作为光标层组件，原型页面自身的行为已剔除：
 *   - 原型的深色底 #0b0b0e 写在 CSS 的 html,body 上，不是画布填充；
 *     render() 本来就是 clearRect(0, 0, W, H)，没有整屏铺底可去，
 *     移植后同样只清除上一帧内容，绝不覆盖宿主页面
 *     （水洼、颜料团、雾点、光晕等有明确形状的填充全部保留）；
 *   - 不拦截 contextmenu（原型在 mousedown 里 preventDefault、并在 contextmenu 上再拦一次），
 *     统一交给基类处理；
 *   - 画布创建、DPR 适配（封顶 2）、尺寸同步、监听注册、rAF 循环全部由基类负责；
 *   - 鼠标速度口径：原型全程**不使用速度**——既没有 mouse.vx = dx / dt 这类原始逐帧速度，
 *     也没有速度阈值，它只用「逐帧位移距离 d」（原型 1126 行）和一个按
 *     k = min(1, dt * 10) 平滑的「方向单位向量」input.dirX / input.dirY（原型 1128~1136 行，
 *     在 651 / 676 / 720 行供喷射方向使用）。
 *     因此这里既不复算原始速度、也不取基类的平滑速度，
 *     而是照原型口径用 input.lx → input.x 的逐帧位移与 state 里的方向平滑值。
 *     注意位移距离 d 是「每帧像素数」，不除以 dt。
 *
 * 原型监听 mousemove / mousedown / mouseup，因此声明 inputFamily = 'mouse'。
 * 所有运行状态（颜料池、空间网格、水洼、特效列表、蓄力计时、离屏贴图）
 * 都放在 setup() 返回的 state 上，多实例互不干扰。
 */

import { CursorEffectElement } from '../core/base.js';
import { clamp, rand, randInt } from '../core/utils.js';

/* ================================================================
   CONFIG —— 集中配置
   ================================================================ */
const CONFIG = {
  MAX_PAINTS: 1600,                       // 颜料对象池上限

  /* 两组配色 */
  NEON_COLORS: ['#FF2E9E', '#FF6B1A', '#FFE800', '#3DFF7A', '#00E5FF', '#8A2BE2', '#FFFFFF'], // 左键·荧光
  WET_COLORS:  ['#C41E3A', '#1E3AC4', '#1E8A3A', '#7A3AC4', '#1A1A1A', '#F0F0F0'],          // 右键·湿漆

  /* 颜料尺寸 */
  PAINT_SIZE_MIN: 3,
  PAINT_SIZE_MAX: 30,

  /* 左键·喷漆 */
  SPRAY_CHARGE: 2.5,                      // 蓄力时长（秒）
  SPRAY_CONE_MIN: 15 * Math.PI / 180,     // 初始锥角
  SPRAY_CONE_MAX: 40 * Math.PI / 180,     // 蓄满锥角
  SPRAY_SPAWN_MIN: 0.020,                 // 每批喷出间隔
  SPRAY_SPAWN_MAX: 0.040,
  SPRAY_SPEED_MIN: 200,                   // 颗粒初速度
  SPRAY_SPEED_MAX: 600,
  SPRAY_DRAG: 2000,                       // 空气阻力 px/s²
  SPRAY_MIST_MIN: 5,                      // 雾化范围（小）
  SPRAY_MIST_MAX: 25,                     // 雾化范围（大）
  SPRAY_MIST_GRAVITY: 30,                 // 雾化颗粒重力

  /* 右键·滴落 */
  DRIP_CHARGE: 2.5,
  DRIP_SPAWN_MIN: 0.05,
  DRIP_SPAWN_MAX: 0.10,
  DRIP_SPEED_MIN: 20,
  DRIP_SPEED_MAX: 80,
  DRIP_VISCOSITY: 1.6,                    // 黏滞系数（速度越快阻力越大）
  DRIP_GRAVITY: 130,                      // 流淌重力
  DRIP_GROUND_DIST: 300,                  // 虚拟地面距光标的距离

  /* 未按键拖尾 */
  TRAIL_GRAVITY: 50,
  TRAIL_LIFE_MIN: 0.8,
  TRAIL_LIFE_MAX: 1.5,

  /* 覆盖 / 污染 */
  SPLATTER_RADIUS: 250,                   // 泼溅污染半径
  POLLUTE_IN: 0.30,                       // 被染色过渡
  POLLUTE_HOLD: 1.00,                     // 保持被污染
  POLLUTE_OUT: 0.50,                      // 恢复原本颜色

  /* 点击判定 */
  CLICK_MIN_CHARGE: 0.12
};

/* ================================================================
   工具
   ================================================================ */
function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
const NEON_RGB = CONFIG.NEON_COLORS.map(hexToRgb);
const WET_RGB = CONFIG.WET_COLORS.map(hexToRgb);

const pick = (arr) => arr[(Math.random() * arr.length) | 0];

/* ================================================================
   离屏纹理预渲染（软光斑，用于雾云 / 闪光 / 蒸发）
   原型用全局 document 创建这张离屏画布；移植后改用元素自身的
   ownerDocument（s.doc），既不触碰任何全局对象，也绝不挂进 DOM。
   这里的 width / height / getContext 都只作用于离屏贴图画布，与主画布无关。
   ================================================================ */
function makeSoftTex(doc) {
  const s = 128;
  const c = doc.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.45)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  return c;
}

function drawSoft(ctx, x, y, r, col, alpha) {
  if (r <= 0 || alpha <= 0.005) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, 'rgba(' + col.r + ',' + col.g + ',' + col.b + ',' + alpha + ')');
  g.addColorStop(0.5, 'rgba(' + col.r + ',' + col.g + ',' + col.b + ',' + (alpha * 0.4) + ')');
  g.addColorStop(1, 'rgba(' + col.r + ',' + col.g + ',' + col.b + ',0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/* ================================================================
   颜料形状系统
   ================================================================ */
function makeShape() {
  const n = 6 + ((Math.random() * 7) | 0);       // 6~12 顶点
  const seed = Math.random() * Math.PI * 2;
  const pts = [];
  for (let i = 0; i < n; i++) {
    pts.push({
      a: seed + (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.26,
      r: 0.7 + Math.random() * 0.6                 // 半径 0.7~1.3 扰动
    });
  }
  return pts;
}

function buildPath(o) {
  const p = new Path2D();
  const pts = o.pts;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i].a, r = pts[i].r * o.size;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) p.moveTo(x, y); else p.lineTo(x, y);
  }
  p.closePath();
  o.path = p;
  o.hlR = Math.max(0.8, o.size * (0.15 + Math.random() * 0.10));
}

/* ================================================================
   颜料池
   ================================================================ */
function makePaint() {
  return {
    alive: false, seq: 0,
    x: 0, y: 0, bx: 0, vx: 0, vy: 0,
    size: 5, sx: 1, sy: 1, rot: 0,
    baseCol: { r: 255, g: 255, b: 255 },
    pollCol: null, pollT: 0, pollPhase: null, pollTimer: 0,
    pts: null, path: null, mist: null,
    state: 'fly', mode: 'spray', kind: 'paint',
    wet: 1, dry: 0, dryTarget: 0, alpha: 1,
    life: 0, maxLife: 0, age: 0,
    hasMist: true, hlR: 2, hlA: 0.5,
    distAcc: 0, wobA: 1, wobF: 3, satT: 0,
    pulse: 1, _gk: null
  };
}

/* ---- 空间网格（用于颜料融合） ---- */
const CELL = 40;

function gridAdd(s, o) {
  const k = ((o.x / CELL) | 0) + ':' + ((o.y / CELL) | 0);
  let a = s.grid.get(k);
  if (!a) { a = []; s.grid.set(k, a); }
  a.push(o);
  o._gk = k;
}
function gridRemove(s, o) {
  if (!o._gk) return;
  const a = s.grid.get(o._gk);
  if (a) {
    const i = a.indexOf(o);
    if (i >= 0) a.splice(i, 1);
    if (!a.length) s.grid.delete(o._gk);
  }
  o._gk = null;
}

function killPaint(s, o) {
  if (!o.alive) return;
  o.alive = false;
  gridRemove(s, o);
  o.mist = null;
  o.pollPhase = null;
  o.pollCol = null;
}

function acquire(s) {
  const pool = s.pool;
  for (let i = 0; i < CONFIG.MAX_PAINTS; i++) {
    const o = pool[s.poolCursor];
    s.poolCursor = (s.poolCursor + 1) % CONFIG.MAX_PAINTS;
    if (!o.alive) return o;
  }
  // 池满：回收最老
  let oldest = pool[0];
  for (let i = 1; i < pool.length; i++) {
    if (pool[i].seq < oldest.seq) oldest = pool[i];
  }
  killPaint(s, oldest);
  return oldest;
}

function spawnPaint(s, cfg) {
  const o = acquire(s);
  o.alive = true;
  o.seq = ++s.seqCounter;
  o.x = cfg.x; o.y = cfg.y;
  o.bx = cfg.x;
  o.vx = cfg.vx || 0; o.vy = cfg.vy || 0;
  o.size = cfg.size !== undefined ? cfg.size : 5;
  o.sx = cfg.sx !== undefined ? cfg.sx : 1;
  o.sy = cfg.sy !== undefined ? cfg.sy : 1;
  o.rot = cfg.rot || 0;
  o.baseCol = cfg.color;
  o.pollCol = null; o.pollT = 0; o.pollPhase = null; o.pollTimer = 0;
  o.state = cfg.state || 'fly';
  o.mode = cfg.mode || 'spray';
  o.kind = cfg.kind || 'paint';
  o.wet = cfg.wet !== undefined ? cfg.wet : 1;
  o.dry = 0;
  o.dryTarget = cfg.dryTarget || 0;
  o.alpha = cfg.alpha !== undefined ? cfg.alpha : 1;
  o.maxLife = cfg.maxLife || 0;
  o.life = 0;
  o.age = 0;
  o.distAcc = 0;
  o.satT = 0;
  o.pulse = 1;
  o._gk = null;
  o.mist = null;
  o.hasMist = (cfg.hasMist !== false) && (o.mode === 'spray');
  o.hlA = 0.4 + Math.random() * 0.2;
  o.pts = makeShape();
  buildPath(o);
  return o;
}

/* ================================================================
   雾化系统（喷漆专用）
   ================================================================ */
function genMist(o, extraRange) {
  const n = 5 + ((Math.random() * 6) | 0);        // 5~10 个雾点
  const reach = extraRange !== undefined ? extraRange : rand(3, 8);
  const arr = [];
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = o.size * 0.9 + rand(1, reach);
    arr.push({
      x: Math.cos(a) * d,
      y: Math.sin(a) * d,
      r: rand(0.5, 1.5),
      a: rand(0.2, 0.5)
    });
  }
  o.mist = arr;
}

/* ================================================================
   覆盖系统 —— 融合 / 附着
   ================================================================ */
function tryMerge(s, o) {
  const cx = (o.x / CELL) | 0, cy = (o.y / CELL) | 0;
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      const a = s.grid.get((cx + i) + ':' + (cy + j));
      if (!a) continue;
      for (let k = a.length - 1; k >= 0; k--) {
        const n = a[k];
        if (n === o || !n.alive || n.state !== 'stuck') continue;
        if (n.kind === 'trace') continue;
        const dx = n.x - o.x, dy = n.y - o.y;
        const rr = (o.size + n.size) * 1.15;
        if (dx * dx + dy * dy < rr * rr) {
          const area = o.size * o.size + n.size * n.size;
          if (area > CONFIG.PAINT_SIZE_MAX * CONFIG.PAINT_SIZE_MAX) continue;
          const w1 = (o.size * o.size) / area;
          const w2 = (n.size * n.size) / area;
          o.x = o.x * w1 + n.x * w2;
          o.y = o.y * w1 + n.y * w2;
          o.size = Math.sqrt(area);
          o.mist = null;
          o.pts = makeShape();
          buildPath(o);
          if (o.hasMist && o.size > 3) genMist(o);
          killPaint(s, n);
        }
      }
    }
  }
}

/* 附着到墙面 */
function stickPaint(s, o) {
  o.state = 'stuck';
  o.vx = 0; o.vy = 0;
  o.size = Math.min(o.size * 1.2, CONFIG.PAINT_SIZE_MAX);
  o.sx = 1; o.sy = 1; o.rot = 0;
  o.pts = makeShape();
  buildPath(o);
  o.wet = 1;

  // 溅点
  if (o.kind === 'paint' || o.kind === 'drip') {
    const n = randInt(2, 4);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = rand(3, 8);
      spawnPaint(s, {
        x: o.x + Math.cos(a) * d,
        y: o.y + Math.sin(a) * d,
        vx: Math.cos(a) * rand(30, 90),
        vy: Math.sin(a) * rand(30, 90),
        size: rand(0.8, 2.0),
        color: o.baseCol,
        mode: 'spray',
        kind: 'splash',
        hasMist: false,
        wet: o.wet
      });
    }
  }

  // 雾化边缘（喷漆独有）
  if (o.hasMist && o.size > 3) genMist(o);

  if (o.kind !== 'trace' && o.kind !== 'splash') {
    gridAdd(s, o);
    tryMerge(s, o);
  }
}

/* ================================================================
   墙面系统 —— 虚拟地面与水洼
   ================================================================ */
function addToPuddle(s, x, amount, col) {
  const gy = s.groundY || (s.H - 40);
  if (!s.puddle) {
    s.puddle = { x: x, y: gy, w: 24, color: col, alpha: 0, fadeT: 0 };
  }
  s.puddle.w = Math.min(s.puddle.w + amount * 0.7, 130);
  s.puddle.alpha = Math.min(1, s.puddle.alpha + 0.16);
  s.puddle.fadeT = 0;
  s.puddle.x += (x - s.puddle.x) * 0.12;
  s.puddle.y = gy;
}

/* ================================================================
   喷嘴定位（含蓄力微震）
   ================================================================ */
function nozzlePos(s) {
  const M = s.input;
  let jx = 0, jy = 0;
  if (s.left) {
    const t = s.leftT / CONFIG.SPRAY_CHARGE;
    if (t > 0.55) {
      const amt = ((t - 0.55) / 0.45) * 3;
      jx = (Math.random() - 0.5) * amt;
      jy = (Math.random() - 0.5) * amt;
    }
  } else if (s.right) {
    const t = s.rightT / CONFIG.DRIP_CHARGE;
    if (t > 0.55) {
      const amt = ((t - 0.55) / 0.45) * 3;
      jx = (Math.random() - 0.5) * amt * 0.5;
      jy = (Math.random() - 0.5) * amt;
    }
  }
  return { x: M.x + jx, y: M.y + jy };
}

/* ================================================================
   拖尾（未按键时的小色点）
   ================================================================ */
function spawnTrailDot(s, x, y) {
  const col = pick(NEON_RGB);
  const o = spawnPaint(s, {
    x: x, y: y,
    vx: rand(-18, 18),
    vy: rand(-18, 18),
    size: rand(1.0, 2.0),
    color: col,
    mode: 'trail',
    kind: 'trail',
    hasMist: false,
    maxLife: rand(CONFIG.TRAIL_LIFE_MIN, CONFIG.TRAIL_LIFE_MAX)
  });
  o.state = 'fly';
  return o;
}

function spawnTrace(s, x, y, r, col, life) {
  const o = spawnPaint(s, {
    x: x, y: y,
    size: Math.max(0.6, r),
    color: col,
    mode: 'trace',
    kind: 'trace',
    hasMist: false,
    alpha: 0.6,
    maxLife: life || 1.2
  });
  o.state = 'stuck';
  return o;
}

/* ================================================================
   单击 —— 点喷 + 喷漆闪光
   ================================================================ */
function doPointSpray(s, x, y, col) {
  // 闪光
  s.flashes.push({ x: x, y: y, r: 15, color: col, life: 0.1, maxLife: 0.1 });
  // 短促颜料团
  const n = randInt(8, 14);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = rand(150, 400);
    spawnPaint(s, {
      x: x, y: y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      size: rand(1.5, 4),
      color: col,
      mode: 'spray',
      kind: 'paint'
    });
  }
  // 溅点
  const m = randInt(3, 5);
  for (let i = 0; i < m; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = rand(200, 400);
    spawnPaint(s, {
      x: x, y: y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      size: rand(0.8, 2),
      color: col,
      mode: 'spray',
      kind: 'splash',
      hasMist: false
    });
  }
}

/* ================================================================
   泼溅 / Splatter + 污染机制
   ================================================================ */
function doSplatter(s, x, y, col) {
  // 1. 主体大色块
  const ang = Math.random() * Math.PI * 2;
  const sp = rand(300, 600);
  const main = spawnPaint(s, {
    x: x, y: y,
    vx: Math.cos(ang) * sp,
    vy: Math.sin(ang) * sp,
    size: rand(20, 30),
    color: col,
    mode: 'spray',
    kind: 'paint'
  });
  main.hlA = 0.5;

  // 2. 卫星溅点
  const satN = randInt(20, 40);
  for (let i = 0; i < satN; i++) {
    const a = Math.random() * Math.PI * 2;
    const s2 = rand(200, 800);
    const o = spawnPaint(s, {
      x: x, y: y,
      vx: Math.cos(a) * s2,
      vy: Math.sin(a) * s2,
      size: rand(2, 8),
      color: col,
      mode: 'sat',
      kind: 'paint',
      hasMist: false
    });
    o.satT = 0;
  }

  // 3. 污染周围拖尾颜料
  const r2 = CONFIG.SPLATTER_RADIUS * CONFIG.SPLATTER_RADIUS;
  const polluted = [];
  for (let i = 0; i < s.pool.length; i++) {
    const o = s.pool[i];
    if (!o.alive) continue;
    if (o.kind !== 'trail' && o.kind !== 'splash' && o.size > 10) continue;
    if (o.kind === 'paint' || o.kind === 'drip') continue;
    const dx = o.x - x, dy = o.y - y;
    if (dx * dx + dy * dy > r2) continue;

    o.pollCol = col;
    o.pollT = 0;
    o.pollPhase = 'in';
    o.pollTimer = 0;

    // 边缘打散：增加 3~5 个随机凸起
    const add = randInt(3, 5);
    for (let k = 0; k < add; k++) {
      o.pts.push({ a: Math.random() * Math.PI * 2, r: rand(0.9, 1.4) });
    }
    o.pts.sort(function (a, b) { return a.a - b.a; });
    buildPath(o);
    o.hlA = 0.4 + Math.random() * 0.2;

    polluted.push(o);
  }

  // 4. 颜料飞溅线
  const lineN = Math.min(polluted.length, randInt(6, 10));
  for (let i = 0; i < lineN; i++) {
    const o = polluted[(Math.random() * polluted.length) | 0];
    s.splatLines.push({
      x1: x, y1: y, x2: o.x, y2: o.y,
      color: col, life: 0.3, maxLife: 0.3
    });
  }
}

/* ================================================================
   左键喷漆 —— 蓄力中的持续喷射
   ================================================================ */
function updateSpray(s, dt) {
  if (!s.left) return;
  s.leftT += dt;
  const t = Math.min(s.leftT / CONFIG.SPRAY_CHARGE, 1);
  const sp = nozzlePos(s);

  // 颜料颗粒喷射
  s.sprayTimer -= dt;
  if (s.sprayTimer <= 0) {
    s.sprayTimer = rand(CONFIG.SPRAY_SPAWN_MIN, CONFIG.SPRAY_SPAWN_MAX);
    const cone = CONFIG.SPRAY_CONE_MIN + (CONFIG.SPRAY_CONE_MAX - CONFIG.SPRAY_CONE_MIN) * t;
    const baseAng = Math.atan2(s.dirY, s.dirX);
    const batch = randInt(3, 8);
    for (let i = 0; i < batch; i++) {
      const a = baseAng + (Math.random() - 0.5) * 2 * cone;
      const speed = rand(CONFIG.SPRAY_SPEED_MIN, CONFIG.SPRAY_SPEED_MAX);
      const size = rand(1.5, 3.0) * (1 + t * 0.9);
      spawnPaint(s, {
        x: sp.x + Math.cos(a) * 8,
        y: sp.y + Math.sin(a) * 8,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        size: size,
        color: s.sprayCol,
        mode: 'spray',
        kind: 'paint',
        wet: 1 - 0.4 * t
      });
    }
  }

  // 边缘雾化飘散
  s.mistTimer -= dt;
  if (s.mistTimer <= 0) {
    s.mistTimer = 0.035;
    const range = CONFIG.SPRAY_MIST_MIN + (CONFIG.SPRAY_MIST_MAX - CONFIG.SPRAY_MIST_MIN) * t;
    const baseAng = Math.atan2(s.dirY, s.dirX);
    for (let i = 0; i < 3; i++) {
      const a = baseAng + (Math.random() - 0.5) * 2.4;
      const d = range * rand(0.4, 1.0);
      spawnPaint(s, {
        x: sp.x + Math.cos(a) * d,
        y: sp.y + Math.sin(a) * d,
        vx: Math.cos(a) * rand(5, 30),
        vy: Math.sin(a) * rand(5, 30) + rand(2, 12),
        size: rand(0.5, 1.5),
        color: s.sprayCol,
        mode: 'mist',
        kind: 'mist',
        alpha: rand(0.2, 0.4),
        hasMist: false,
        maxLife: rand(0.6, 1.4)
      });
    }
  }

  // 污染拖尾：把附近拖尾小点染成喷漆主色
  if (Math.random() < 0.5) {
    const R2 = 90 * 90;
    for (let i = 0; i < s.pool.length; i += 3) {
      const o = s.pool[i];
      if (!o.alive || o.kind !== 'trail') continue;
      const dx = o.x - sp.x, dy = o.y - sp.y;
      if (dx * dx + dy * dy > R2) continue;
      o.baseCol = s.sprayCol;
    }
  }
}

/* ================================================================
   左键松开 —— 猛烈喷发
   ================================================================ */
function sprayRelease(s, x, y, col, power) {
  // 静止一帧（凝固 0.03s）—— 以延迟实现视觉上的短暂停顿
  s.burstDelay.push({ t: 0.03, fn: function () { sprayBurst(s, x, y, col, power); } });
  // 喷嘴过曝
  s.flashes.push({ x: x, y: y, r: 20, color: { r: 255, g: 255, b: 255 }, life: 0.05, maxLife: 0.05 });
}

function sprayBurst(s, x, y, col, power) {
  const baseAng = Math.atan2(s.dirY, s.dirX);
  const cone = CONFIG.SPRAY_CONE_MAX;

  // 猛烈喷发
  const count = 200 + Math.floor(500 * power);
  for (let i = 0; i < count; i++) {
    const a = baseAng + (Math.random() - 0.5) * 2 * cone;
    const sp = (400 + 1200 * power) * rand(0.5, 1.35);
    spawnPaint(s, {
      x: x, y: y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      size: rand(4, 12),
      color: col,
      mode: 'spray',
      kind: 'paint',
      wet: 1
    });
  }

  // 喷漆波：由密集小颜料点组成的圆环
  s.waves.push({
    x: x, y: y, r: 10,
    maxR: 200 + 500 * power,
    color: col, life: 0.5, maxLife: 0.5,
    n: 72, seed: Math.random() * 6.28,
    dotSize: 4, type: 'spray'
  });

  // 颜料雾云
  s.clouds.push({
    x: x, y: y, r: 20, maxR: 100,
    color: col, life: 0.8, maxLife: 0.8
  });

  // 爆发后 0.3s —— 颜料滴落
  s.burstDelay.push({
    t: 0.30,
    fn: function () {
      const n = randInt(5, 10);
      for (let i = 0; i < n; i++) {
        const px = x + rand(-120, 120);
        const py = y + rand(-60, 60);
        const o = spawnPaint(s, {
          x: px, y: py,
          vx: 0,
          vy: rand(15, 45),
          size: rand(2.5, 4.5),
          color: col,
          mode: 'drip',
          kind: 'drip',
          hasMist: false
        });
        o.sy = rand(2.0, 3.5);
        o.bx = o.x;
        o.wobA = rand(0.5, 1.5);
        o.wobF = rand(2, 4);
        o.wet = 1;
      }
    }
  });

  // 拖尾被污染
  polluteRadius(s, x, y, col);

  // 余韵：颜料逐渐干涸
  for (let i = 0; i < s.pool.length; i++) {
    const o = s.pool[i];
    if (!o.alive) continue;
    const dx = o.x - x, dy = o.y - y;
    if (dx * dx + dy * dy < 400 * 400) {
      o.dryTarget = Math.random() * 0.8;
    }
  }
}

/* 对全场拖尾颜料做一次污染（半径内） */
function polluteRadius(s, x, y, col) {
  const r2 = CONFIG.SPLATTER_RADIUS * CONFIG.SPLATTER_RADIUS;
  const hit = [];
  for (let i = 0; i < s.pool.length; i++) {
    const o = s.pool[i];
    if (!o.alive) continue;
    if (o.kind === 'paint' || o.kind === 'drip' || o.kind === 'trace' || o.kind === 'mist') continue;
    const dx = o.x - x, dy = o.y - y;
    if (dx * dx + dy * dy > r2) continue;
    o.pollCol = col;
    o.pollT = 0;
    o.pollPhase = 'in';
    o.pollTimer = 0;
    const add = randInt(3, 5);
    for (let k = 0; k < add; k++) {
      o.pts.push({ a: Math.random() * Math.PI * 2, r: rand(0.9, 1.4) });
    }
    o.pts.sort(function (a, b) { return a.a - b.a; });
    buildPath(o);
    o.hlA = 0.4 + Math.random() * 0.2;
    hit.push(o);
  }
  const n = Math.min(hit.length, randInt(6, 10));
  for (let i = 0; i < n; i++) {
    const o = hit[(Math.random() * hit.length) | 0];
    s.splatLines.push({
      x1: x, y1: y, x2: o.x, y2: o.y,
      color: col, life: 0.3, maxLife: 0.3
    });
  }
}

/* ================================================================
   右键滴落 —— 蓄力中的流淌
   ================================================================ */
function spawnDripParticle(s, x, y, col, powerT) {
  const o = spawnPaint(s, {
    x: x, y: y,
    vx: 0,
    vy: rand(CONFIG.DRIP_SPEED_MIN, CONFIG.DRIP_SPEED_MAX) * (1 + powerT * 0.6),
    size: rand(2.5, 5),
    color: col,
    mode: 'drip',
    kind: 'drip',
    hasMist: false
  });
  o.sy = rand(1.6, 2.8);
  o.bx = o.x;
  o.wobA = rand(1, 3);
  o.wobF = rand(2, 5);
  o.distAcc = 0;
  o.wet = 1;
  return o;
}

function updateDrip(s, dt) {
  if (!s.right) return;
  s.rightT += dt;
  const t = Math.min(s.rightT / CONFIG.DRIP_CHARGE, 1);
  const sp = nozzlePos(s);

  s.dripTimer -= dt;
  if (s.dripTimer <= 0) {
    s.dripTimer = rand(CONFIG.DRIP_SPAWN_MIN, CONFIG.DRIP_SPAWN_MAX);
    const batch = randInt(2, 5);
    for (let i = 0; i < batch; i++) {
      spawnDripParticle(s, sp.x + rand(-10, 10), sp.y + rand(-4, 4), s.dripCol, t);
    }
  }

  // 偶发加速滴落
  if (Math.random() < dt * (0.6 + t * 2.4)) {
    const o = spawnDripParticle(s, sp.x + rand(-6, 6), sp.y, s.dripCol, 1.4);
    o.vy = rand(90, 160);
  }

  // 污染拖尾
  if (Math.random() < 0.4) {
    const R2 = 70 * 70;
    for (let i = 0; i < s.pool.length; i += 3) {
      const o = s.pool[i];
      if (!o.alive || o.kind !== 'trail') continue;
      const dx = o.x - sp.x, dy = o.y - sp.y;
      if (dx * dx + dy * dy > R2) continue;
      o.baseCol = s.dripCol;
    }
  }
}

/* ================================================================
   右键松开 —— 猛烈倾泻
   ================================================================ */
function dripRelease(s, x, y, col, power) {
  s.burstDelay.push({ t: 0.03, fn: function () { dripBurst(s, x, y, col, power); } });
}

function dripBurst(s, x, y, col, power) {
  const count = 100 + Math.floor(300 * power);

  for (let i = 0; i < count; i++) {
    // 多方向，但偏向下
    const a = Math.PI * 0.5 + (Math.random() - 0.5) * Math.PI * 1.6;
    const sp = (400 + 1000 * power) * rand(0.45, 1.2);
    const o = spawnPaint(s, {
      x: x, y: y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      size: rand(8, 25),
      color: col,
      mode: 'sat',
      kind: 'paint',
      hasMist: false,
      wet: 1
    });
    o.sy = rand(1.0, 1.8);
    o.satT = 0;
  }

  // 颜料流淌波
  s.waves.push({
    x: x, y: y, r: 10,
    maxR: 150 + 400 * power,
    color: col, life: 0.6, maxLife: 0.6,
    n: 54, seed: Math.random() * 6.28,
    dotSize: 5, type: 'drip'
  });

  // 滴痕爆发（延迟 0.3s）
  s.burstDelay.push({
    t: 0.30,
    fn: function () {
      const n = randInt(15, 30);
      for (let i = 0; i < n; i++) {
        const px = x + rand(-180, 180);
        const py = y + rand(-100, 100);
        const o = spawnPaint(s, {
          x: px, y: py,
          vx: 0,
          vy: rand(40, 110),
          size: rand(3, 6),
          color: col,
          mode: 'drip',
          kind: 'drip',
          hasMist: false
        });
        o.sy = rand(2.5, 5);
        o.bx = o.x;
        o.wobA = rand(0.6, 2);
        o.wobF = rand(2, 5);
      }
    }
  });

  // 水洼爆发
  s.burstDelay.push({
    t: 0.05,
    fn: function () {
      const gy = s.groundY || (s.H - 40);
      if (!s.puddle) {
        s.puddle = { x: x, y: gy, w: 120, color: col, alpha: 0.9, fadeT: 0 };
      }
      s.puddle.w = Math.min(s.puddle.w + 180, 300);
      s.puddle.alpha = 1;
      s.puddle.color = col;
      s.puddle.fadeT = 0;
      s.puddle.x = x;
    }
  });

  // 颜料蒸发（约 30%）
  for (let i = 0; i < s.pool.length; i++) {
    const o = s.pool[i];
    if (!o.alive) continue;
    const dx = o.x - x, dy = o.y - y;
    if (dx * dx + dy * dy > 320 * 320) continue;
    if (Math.random() < 0.30) {
      o.mode = 'mist';
      o.maxLife = rand(0.9, 1.8);
      o.life = 0;
      o.alpha = 0.6;
      o.vy = rand(-6, 6);
      o.vx = rand(-6, 6);
      o.state = 'fly';
      o.dryTarget = 1;
    } else {
      o.dryTarget = Math.random() * 0.8;
    }
  }

  // 拖尾污染
  polluteRadius(s, x, y, col);
}

/* ================================================================
   颜料物理更新
   ================================================================ */
function updatePaints(s, dt) {
  const gy = s.groundY;

  for (let i = 0; i < s.pool.length; i++) {
    const o = s.pool[i];
    if (!o.alive) continue;
    o.age += dt;

    /* ---- 污染状态机 ---- */
    if (o.pollPhase) {
      o.pollTimer += dt;
      if (o.pollPhase === 'in') {
        o.pollT = Math.min(1, o.pollTimer / CONFIG.POLLUTE_IN);
        if (o.pollTimer >= CONFIG.POLLUTE_IN) { o.pollPhase = 'hold'; o.pollTimer = 0; }
      } else if (o.pollPhase === 'hold') {
        if (o.pollTimer >= CONFIG.POLLUTE_HOLD) { o.pollPhase = 'out'; o.pollTimer = 0; }
      } else {
        o.pollT = Math.max(0, 1 - o.pollTimer / CONFIG.POLLUTE_OUT);
        if (o.pollTimer >= CONFIG.POLLUTE_OUT) { o.pollPhase = null; o.pollCol = null; o.pollT = 0; }
      }
    }

    /* ---- 干涸 ---- */
    if (o.dry < o.dryTarget) {
      o.dry = Math.min(o.dryTarget, o.dry + dt * 0.45);
    }

    /* ---- 呼吸脉动 ---- */
    if (o.kind === 'paint' || o.kind === 'drip') {
      if (o.age < 2.5) {
        o.pulse = 0.92 + 0.08 * Math.sin(o.age * Math.PI * 4);
      } else {
        o.pulse = 1;
      }
    }

    /* ---- 按模式更新 ---- */
    const m = o.mode;

    if (m === 'spray' || m === 'sat') {
      if (o.state !== 'fly') continue;

      const sp = Math.sqrt(o.vx * o.vx + o.vy * o.vy);
      if (sp > 0.0001) {
        const ns = Math.max(0, sp - CONFIG.SPRAY_DRAG * dt);
        const f = ns / sp;
        o.vx *= f; o.vy *= f;
      }
      o.x += o.vx * dt;
      o.y += o.vy * dt;

      // 卫星溅点留下溅迹
      if (m === 'sat') {
        o.satT += dt;
        if (o.satT > 0.045) {
          o.satT = 0;
          spawnTrace(s, o.x, o.y, rand(0.5, 1.2), o.baseCol, 0.7);
        }
      }

      if (sp < 10) {
        stickPaint(s, o);
      } else if (o.x < -300 || o.x > s.W + 300 || o.y < -300 || o.y > s.H + 300) {
        killPaint(s, o);
      }

    } else if (m === 'drip') {
      if (o.state !== 'fly') continue;

      // 黏滞阻力：速度越快阻力越大
      o.vy += (CONFIG.DRIP_GRAVITY - CONFIG.DRIP_VISCOSITY * o.vy) * dt;
      // 横向摆动
      o.x = o.bx + Math.sin(o.age * o.wobF) * o.wobA;
      o.y += o.vy * dt;

      // 留下滴痕
      o.distAcc += o.vy * dt;
      if (o.distAcc > 6) {
        o.distAcc = 0;
        spawnTrace(s, o.x, o.y, o.size * 0.5, o.baseCol, 2.5);
      }

      // 到达地面 → 水洼
      if (o.y >= gy) {
        addToPuddle(s, o.x, o.size * 2, o.baseCol);
        killPaint(s, o);
      } else if (o.y > s.H + 60) {
        killPaint(s, o);
      }

    } else if (m === 'trail') {
      o.life += dt;
      if (o.life >= o.maxLife) { killPaint(s, o); continue; }
      o.vy += CONFIG.TRAIL_GRAVITY * dt;
      o.x += o.vx * dt;
      o.y += o.vy * dt;
      const k = 1 - o.life / o.maxLife;
      o.alpha = k;
      o.sx = o.sy = 0.3 + 0.7 * k;

    } else if (m === 'mist') {
      o.life += dt;
      if (o.life >= o.maxLife) { killPaint(s, o); continue; }
      // 原型此处硬编码 30，与 CONFIG.SPRAY_MIST_GRAVITY 同值，改引用常量避免配置悬空
      o.vy += CONFIG.SPRAY_MIST_GRAVITY * dt;
      o.x += o.vx * dt;
      o.y += o.vy * dt;
      const k = 1 - o.life / o.maxLife;
      o.alpha = (o.kind === 'mist' ? 0.3 : 0.6) * k;
      o.sx = o.sy = 0.5 + 0.8 * k;

    } else if (m === 'trace') {
      o.life += dt;
      if (o.life >= o.maxLife) { killPaint(s, o); continue; }
      o.alpha = 0.6 * (1 - o.life / o.maxLife);
    }
  }

  /* ---- 水洼衰减 ---- */
  if (s.puddle && !s.right) {
    s.puddle.fadeT += dt;
    if (s.puddle.fadeT > 2.5) {
      s.puddle.alpha -= dt * 0.45;
      if (s.puddle.alpha <= 0) s.puddle = null;
    }
  }
}

/* ================================================================
   鼠标移动逻辑（拖尾生成 / 喷漆方向）
   原型在这里用的是「上一帧位置 → 本帧位置」的位移：
   基类的 input.lx / ly 即上一帧锚点，input.x / y 为当前位置。
   ================================================================ */
function updateMouse(s, dt) {
  const M = s.input;
  const dx = M.x - M.lx;
  const dy = M.y - M.ly;
  const d = Math.sqrt(dx * dx + dy * dy);

  if (d > 0.5) {
    const inv = 1 / d;
    const nx = dx * inv, ny = dy * inv;
    const k = Math.min(1, dt * 10);
    s.dirX += (nx - s.dirX) * k;
    s.dirY += (ny - s.dirY) * k;
    const dl = Math.sqrt(s.dirX * s.dirX + s.dirY * s.dirY) || 1;
    s.dirX /= dl; s.dirY /= dl;
  }

  // 未按键：喷雾残迹小径
  if (!s.left && !s.right && d > 2) {
    const spacing = 13;
    const acc = s.trailAcc + d;
    let steps = Math.floor(acc / spacing);
    if (steps > 6) steps = 6;
    for (let i = 0; i < steps; i++) {
      const t = (i + 1) / (steps + 0.0001);
      spawnTrailDot(s, M.lx + dx * t, M.ly + dy * t);
    }
    s.trailAcc = acc - steps * spacing;
    if (s.trailAcc > spacing) s.trailAcc = 0;
  } else {
    s.trailAcc = 0;
  }
}

/* ================================================================
   特效更新
   ================================================================ */
function updateEffects(s, dt) {
  // 延迟任务
  for (let i = s.burstDelay.length - 1; i >= 0; i--) {
    const b = s.burstDelay[i];
    b.t -= dt;
    if (b.t <= 0) {
      s.burstDelay.splice(i, 1);
      b.fn();
    }
  }

  // 闪光
  for (let i = s.flashes.length - 1; i >= 0; i--) {
    const f = s.flashes[i];
    f.life -= dt;
    if (f.life <= 0) s.flashes.splice(i, 1);
  }

  // 飞溅线
  for (let i = s.splatLines.length - 1; i >= 0; i--) {
    const l = s.splatLines[i];
    l.life -= dt;
    if (l.life <= 0) s.splatLines.splice(i, 1);
  }

  // 波
  for (let i = s.waves.length - 1; i >= 0; i--) {
    const w = s.waves[i];
    w.life -= dt;
    const k = 1 - w.life / w.maxLife;
    w.r = 10 + (w.maxR - 10) * (1 - Math.pow(1 - k, 2.2));
    if (w.life <= 0) s.waves.splice(i, 1);
  }

  // 雾云
  for (let i = s.clouds.length - 1; i >= 0; i--) {
    const c = s.clouds[i];
    c.life -= dt;
    if (c.life <= 0) s.clouds.splice(i, 1);
  }
}

/* ================================================================
   渲染
   ================================================================ */
function drawPaint(ctx, o) {
  let cr = o.baseCol.r, cg = o.baseCol.g, cb = o.baseCol.b;
  if (o.pollCol && o.pollT > 0) {
    const t = o.pollT;
    cr = cr + (o.pollCol.r - cr) * t;
    cg = cg + (o.pollCol.g - cg) * t;
    cb = cb + (o.pollCol.b - cb) * t;
  }
  if (o.dry > 0) {
    const dk = 1 - o.dry * 0.25;
    cr *= dk; cg *= dk; cb *= dk;
  }
  cr = cr | 0; cg = cg | 0; cb = cb | 0;

  const a = o.alpha * o.pulse;
  if (a <= 0.01) return;

  // 雾化（画在主体之前 / 之外）
  if (o.mist) {
    for (let i = 0; i < o.mist.length; i++) {
      const mp = o.mist[i];
      ctx.fillStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',' + (mp.a * a) + ')';
      ctx.fillRect(o.x + mp.x, o.y + mp.y, mp.r * 2, mp.r * 2);
    }
  }

  ctx.save();
  ctx.translate(o.x, o.y);
  if (o.rot) ctx.rotate(o.rot);
  if (o.sx !== 1 || o.sy !== 1) ctx.scale(o.sx, o.sy);

  // 厚度阴影
  if (o.size > 6) {
    ctx.save();
    ctx.translate(2, 2.5);
    ctx.fillStyle = 'rgba(' + ((cr * 0.5) | 0) + ',' + ((cg * 0.5) | 0) + ',' + ((cb * 0.5) | 0) + ',' + (0.2 * a) + ')';
    ctx.fill(o.path);
    ctx.restore();
  }

  // 主体
  ctx.fillStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',' + a + ')';
  ctx.fill(o.path);

  // 边缘深色描边（厚度感）
  if (o.size > 5) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(' + ((cr * 0.6) | 0) + ',' + ((cg * 0.6) | 0) + ',' + ((cb * 0.6) | 0) + ',' + a + ')';
    ctx.stroke(o.path);
  }

  // 湿润高光
  if (o.size > 5 && o.wet > 0.05) {
    ctx.beginPath();
    ctx.ellipse(-o.size * 0.30, -o.size * 0.32, o.hlR, o.hlR * 0.65, -0.6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,' + (o.hlA * o.wet * a) + ')';
    ctx.fill();
  }

  ctx.restore();
}

function drawPuddle(ctx, p) {
  const rx = p.w / 2;
  const ry = Math.max(4, p.w * 0.15);
  ctx.save();
  ctx.globalAlpha = clamp(p.alpha, 0, 1);
  ctx.fillStyle = 'rgb(' + p.color.r + ',' + p.color.g + ',' + p.color.b + ')';
  ctx.beginPath();
  ctx.ellipse(p.x, p.y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  // 湿润高光带
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.beginPath();
  ctx.ellipse(p.x - rx * 0.12, p.y - ry * 0.34, rx * 0.45, Math.max(1.5, ry * 0.22), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawWave(ctx, w) {
  const k = w.life / w.maxLife;
  const alpha = k * 0.9;
  if (alpha <= 0.01) return;
  ctx.fillStyle = 'rgba(' + w.color.r + ',' + w.color.g + ',' + w.color.b + ',' + alpha + ')';
  const n = w.n;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + w.seed;
    const jr = w.r + Math.sin(i * 3.7) * 7;
    const x = w.x + Math.cos(a) * jr;
    const y = w.y + Math.sin(a) * jr;
    const s = w.dotSize * (0.6 + (i % 3) * 0.35);
    if (w.type === 'drip') {
      ctx.fillRect(x - 1, y, 2, s * 4);
    } else {
      ctx.fillRect(x, y, s, s);
    }
  }
}

export class CursorDoodle extends CursorEffectElement {
  /** 主题光标：彩调描边 + 墨点装饰 */
  cursorTheme() {
    return {
      edge: '#ffd166',
      fill: 'rgba(34, 26, 12, .88)',
      glow: '#ff8a5c',
      deco: { color: [255, 209, 102], style: 'ink', rate: 12, speedGain: 0.18 }
    };
  }

  // 原型用的是 mousemove / mousedown / mouseup（不是 pointer 事件族），
  // 不声明这一行，基类会去监听 pointermove，动效将完全收不到鼠标输入。
  inputFamily = 'mouse';

  /* ================================================================
     初始化
     ================================================================ */
  // 只建池与状态，不注册任何监听（监听、DPR 缩放、rAF 全归基类）
  setup({ canvas, ctx, width, height, input }) {
    // 与原型一致：初始光标位置取视口中心（原型 381 行）。
    // 基类的 input 从 (0, 0) 起算，若不在这里对齐，首帧的位移会按「从左上角跳过来」计算，
    // 拖尾生成量与喷漆方向会和原型不同。
    input.x = input.lx = width * 0.5;
    input.y = input.ly = height * 0.5;

    const pool = [];
    for (let i = 0; i < CONFIG.MAX_PAINTS; i++) pool.push(makePaint());

    return {
      // 本实例的画布上下文（已按 DPR 缩放过，统一使用 CSS 像素坐标）
      ctx,

      // 画布尺寸（CSS 像素），由基类 onResize 同步
      W: width,
      H: height,

      input,

      // 离屏贴图的创建者：用元素自身的 ownerDocument，不碰全局对象，也绝不挂进 DOM
      doc: canvas.ownerDocument,

      // 颜料对象池与环形游标
      pool,
      poolCursor: 0,
      // 递增序号：既用于池满时挑最老对象，也用于渲染排序（原型 234 / 225 / 1318 行）
      seqCounter: 0,

      // 空间网格（用于颜料融合）
      grid: new Map(),

      // 虚拟地面水洼
      puddle: null,

      // 特效列表
      flashes: [],
      splatLines: [],
      waves: [],
      clouds: [],
      renderList: [],

      // 原型 input 对象里的动效状态（光标位置/速度仍取自基类的 input）
      left: false, right: false,
      leftT: 0, rightT: 0,
      dirX: 1, dirY: 0,
      sprayCol: NEON_RGB[0], dripCol: WET_RGB[0],
      sprayTimer: 0, dripTimer: 0, mistTimer: 0,
      trailAcc: 0,
      groundY: height - 40,
      burstDelay: [],

      // 原型第 106 行的离屏软光斑贴图。
      // 注意：原型建好后全程没有再引用它（drawSoft 每次自建径向渐变），
      // 属于死代码；这里按原样保留以维持逐行对应。
      softTex: makeSoftTex(canvas.ownerDocument)
    };
  }

  /* ================================================================
     输入（按键）—— 鼠标位移由基类写入 this.input，这里只处理左右键交互
     ================================================================ */
  onPointerDown(e) {
    const s = this.state;
    if (!s) return;
    const M = s.input;

    if (e.button === 0) {
      s.left = true;
      s.leftT = 0;
      s.sprayTimer = 0;
      s.mistTimer = 0;
      s.sprayCol = pick(NEON_RGB);

      // —— 交互二：点喷（短促颜料团 + 喷漆闪光）
      doPointSpray(s, M.x, M.y, s.sprayCol);

      // —— 交互三：泼溅 + 污染
      doSplatter(s, M.x, M.y, s.sprayCol);

    } else if (e.button === 2) {
      s.right = true;
      s.rightT = 0;
      s.dripTimer = 0;
      s.dripCol = pick(WET_RGB);
      s.groundY = Math.min(M.y + CONFIG.DRIP_GROUND_DIST, s.H - 20);
      // 小规模流淌
      for (let i = 0; i < 6; i++) {
        const sp = nozzlePos(s);
        spawnDripParticle(s, sp.x + rand(-8, 8), sp.y + rand(-4, 4), s.dripCol, 0.2);
      }
    }
    // 原型的 e.preventDefault() 与 contextmenu 拦截统一交给基类
  }

  onPointerUp(e) {
    const s = this.state;
    if (!s) return;
    const M = s.input;

    if (e.button === 0 && s.left) {
      const t = s.leftT;
      s.left = false;
      if (t >= CONFIG.CLICK_MIN_CHARGE) {
        const power = Math.pow(Math.min(t, CONFIG.SPRAY_CHARGE) / CONFIG.SPRAY_CHARGE, 1.6);
        sprayRelease(s, M.x, M.y, s.sprayCol, power);
      }
    } else if (e.button === 2 && s.right) {
      const t = s.rightT;
      s.right = false;
      if (t >= CONFIG.CLICK_MIN_CHARGE) {
        const power = Math.pow(Math.min(t, CONFIG.DRIP_CHARGE) / CONFIG.DRIP_CHARGE, 1.6);
        dripRelease(s, M.x, M.y, s.dripCol, power);
      } else {
        // 小滴落
        for (let i = 0; i < 10; i++) {
          spawnDripParticle(s, M.x + rand(-10, 10), M.y + rand(-6, 6), s.dripCol, 0.5);
        }
      }
    }
  }

  // 失焦清理蓄力状态：原型 window blur 的行为
  onBlur() {
    const s = this.state;
    if (!s) return;
    s.left = false;
    s.right = false;
    s.leftT = 0;
    s.rightT = 0;
    s.burstDelay.length = 0;
  }

  /* ================================================================
     尺寸 —— 只同步动效自己的 W / H，画布尺寸与 DPR 由基类维护
     ================================================================ */
  onResize(width, height) {
    const s = this.state;
    if (!s) return;
    s.W = width;
    s.H = height;
  }

  /* ================================================================
     更新
     ================================================================ */
  update(dt, s) {
    if (!s) return;
    updateMouse(s, dt);
    updateSpray(s, dt);
    updateDrip(s, dt);
    updatePaints(s, dt);
    updateEffects(s, dt);
  }

  /* ================================================================
     渲染
     ================================================================ */
  render(s) {
    if (!s) return;
    const ctx = s.ctx;
    const M = s.input;

    // 清屏：原型本来就是 clearRect，没有整屏铺底；移植后同样只清除上一帧内容，
    // 绝不覆盖宿主页面。
    ctx.clearRect(0, 0, s.W, s.H);

    // 水洼
    if (s.puddle && s.puddle.alpha > 0.01) drawPuddle(ctx, s.puddle);

    // 收集 + 按层级排序（新的在上）
    const renderList = s.renderList;
    renderList.length = 0;
    for (let i = 0; i < s.pool.length; i++) {
      if (s.pool[i].alive) renderList.push(s.pool[i]);
    }
    renderList.sort(function (a, b) { return a.seq - b.seq; });

    for (let i = 0; i < renderList.length; i++) drawPaint(ctx, renderList[i]);

    // 颜料飞溅线
    for (let i = 0; i < s.splatLines.length; i++) {
      const l = s.splatLines[i];
      const k = l.life / l.maxLife;
      ctx.strokeStyle = 'rgba(' + l.color.r + ',' + l.color.g + ',' + l.color.b + ',' + (0.6 * k) + ')';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(l.x1, l.y1);
      ctx.lineTo(l.x2, l.y2);
      ctx.stroke();
    }

    // 波
    for (let i = 0; i < s.waves.length; i++) drawWave(ctx, s.waves[i]);

    // 雾云
    for (let i = 0; i < s.clouds.length; i++) {
      const c = s.clouds[i];
      const k = c.life / c.maxLife;
      const r = c.r + (c.maxR - c.r) * (1 - k);
      drawSoft(ctx, c.x, c.y, r, c.color, 0.3 * k);
    }

    // 闪光
    for (let i = 0; i < s.flashes.length; i++) {
      const f = s.flashes[i];
      const k = f.life / f.maxLife;
      drawSoft(ctx, f.x, f.y, f.r * (1 + (1 - k) * 0.6), f.color, 0.45 * k);
    }

    // 喷嘴闪光（左键蓄力中）
    if (s.left) {
      const t = s.leftT / CONFIG.SPRAY_CHARGE;
      const pulse = 0.5 + 0.5 * Math.sin(s.leftT * Math.PI * 4);
      drawSoft(ctx, M.x, M.y, 8 + t * 6, s.sprayCol, 0.35 + 0.35 * pulse);
    }
  }
}

if (!customElements.get('cursor-doodle')) {
  customElements.define('cursor-doodle', CursorDoodle);
}

export default CursorDoodle;
