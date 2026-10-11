/**
 * cursor-ink —— 鼠标光标水墨动效（左键水中墨 / 右键纸上墨）。
 *
 * 由 html/水墨.html 原型移植：算法流程、数值、视觉表现与原文件一一对应。
 * 作为光标层组件，原型页面自身的行为已剔除：
 *   - 原型的纸色底 #F2EDE4 写在 CSS 的 html,body 上，不是画布填充；
 *     绘制中本来就没有整屏铺底，render() 只做 clearRect，绝不覆盖宿主页面；
 *   - 不拦截 contextmenu（基类统一处理，并保留 Shift/Ctrl 右键的逃生出口）；
 *   - 画布创建、DPR 适配（封顶 2，对应 CONFIG.DPR_CAP）、尺寸同步、监听注册、
 *     rAF 循环全部由基类负责，render() 里原型的 setTransform 已移除。
 *
 * 原型监听 mousemove / mousedown / mouseup，因此声明 inputFamily = 'mouse'。
 * 原型用 var 声明的全局量全部改成 setup() 返回的 state 字段，多实例互不干扰。
 *
 * 与原型的差异（详见交付回报）：
 *   1. 原型的 updateMouse() 用「原始逐帧位移」算 mouse.vx / mouse.vy，
 *      与基类 input.vx/vy（1-exp(-25dt) 平滑）语义不同，这里在 update() 里
 *      自己复现原始速度（state.rawVx / rawVy），连原型的 6000 钳制与
 *      每帧 0.4 系数的速度 EMA（state.speed）一并保留；
 *   2. 原型 mouse.has 门（第一次 mousemove 前不生成拖尾、且首次移动时把
 *      参考点对齐到当前位置）用 state.has 复现；
 *   3. 原型 981 行 burstPaper 里「颜色侵入」用了上一轮循环的 d.R（应为 dd.R），
 *      已修正；
 *   4. 原型的死代码 trailTick、fuseGrid 未移植（详见回报）。
 */

import { CursorEffectElement } from '../core/base.js';
import { TAU, clamp, lerp, rand, randInt } from '../core/utils.js';

/* ============================================================
   1. CONFIG —— 全部可调参数集中在此
   ============================================================ */
const CONFIG = {
  /* -------- 全局 -------- */
  MAX_INK: 1400,          // 墨粒对象池上限
  DPR_CAP: 2,             // devicePixelRatio 上限（基类同样封顶 2）
  GRID: 80,               // 空间网格单元尺寸（墨滴融合用；原型未使用）

  /* -------- 两组配色 -------- */
  PALETTE: [
    [10, 10, 10],       // 0 浓墨 / 墨黑
    [26, 26, 26],       // 1 墨黑
    [26, 42, 58],       // 2 深墨蓝（墨中带水色）
    [74, 74, 74],       // 3 墨灰
    [138, 138, 138],    // 4 淡墨
    [196, 30, 58],      // 5 朱砂
    [42, 58, 74],       // 6 青墨
    [138, 90, 58],      // 7 赭石
    [212, 168, 74],     // 8 淡金
    [216, 232, 240]     // 9 清水（仅作环境参考）
  ],
  WATER_CORE: 0,          // 水中墨：核心色
  WATER_DIFF: 1,          // 水中墨：浓度扩散层色
  WATER_FIL: [2, 3],      // 水中墨：丝缕色候选
  WATER_CAP: 4,           // 水中墨：毛细色
  PAPER_BLUE: 6,          // 纸上墨：青墨
  PAPER_RED: 5,           // 纸上墨：朱砂

  /* -------- 离屏纹理半径档位 -------- */
  TEX_RADII: [2, 4, 8, 16, 32, 64],

  /* -------- 墨滴四层结构参数 -------- */
  CORE_ALPHA: [0.70, 0.95],      // 核心墨核 alpha
  DIFFUSE_N: [5, 15],            // 浓度扩散层墨粒数
  DIFFUSE_RING: [0.5, 1.5],      // 扩散层分布环带（× 核心半径）
  DIFFUSE_R: [0.40, 0.80],       // 扩散层墨粒半径（× 核心半径）
  DIFFUSE_ALPHA: [0.30, 0.60],   // 扩散层 alpha

  FIL_N: [3, 8],                 // 丝缕条数
  FIL_PTS: [4, 10],              // 每条丝缕墨粒数
  FIL_R: [0.15, 0.30],           // 丝缕墨粒半径（× 核心半径）
  FIL_LEN: [1.5, 4.0],           // 丝缕长度（水中墨）
  FIL_LEN_PAPER: [1.0, 2.2],     // 丝缕长度（纸上墨）
  FORK_CHANCE: 0.30,             // 丝缕分叉概率
  FORK_MAX_DEPTH: 2,             // 分叉递归深度上限
  FORK_LEN: [0.5, 0.7],          // 子丝缕长度比例

  CAP_N: [8, 20],                // 毛细边缘墨粒数
  CAP_RING: [1.5, 3.0],          // 毛细边缘分布环带
  CAP_R: [0.08, 0.20],           // 毛细边缘墨粒半径
  CAP_ALPHA: [0.05, 0.20],       // 毛细边缘 alpha
  CAP_CRAWL: [15, 45],           // 毛细爬行速度 px/s

  /* -------- 物理 -------- */
  DRAG: 1.5,                     // 速度阻尼
  WATER_SINK: [30, 80],          // 水中墨下沉速度 px/s
  FLOW_AMP: 16,                  // 水平流场振幅
  FLOW_FREQ: 0.35,               // 流场频率
  FUSE_FACTOR: 0.8,              // 融合判定距离系数

  /* -------- 蓄力 -------- */
  CHARGE_MAX: 2.5,               // 蓄力时长阈值（秒）
  CLICK_MIN: 0.12,               // 低于此时长视为普通单击
  CLOUD_R: 38,                   // 水中墨云基础核心半径
  CLOUD_SINK_DEPTH: [40, 160],   // 墨云重心下沉范围
  BLOB_R: 42,                    // 纸上墨斑基础核心半径

  /* -------- 拖尾 -------- */
  TRAIL_LIFE: [1.5, 3.0],        // 拖尾墨滴寿命
  TRAIL_SPACING: 14,             // 拖尾生成间距 px
  TRAIL_DETAIL: 0.35,            // 拖尾结构精简度

  /* -------- 爆发 / 扩散场 -------- */
  DIFFUSE_FIELD_R: 200,          // 落墨扩散场半径
  DIFFUSE_FIELD_LIFE: 0.5        // 落墨扩散场持续时长
};

/* 原型工具函数里还有一个 pick()，utils 未导出，这里就地定义 */
function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }

/* ============================================================
   2. 离屏纹理预渲染
   ============================================================ */
// 原型在模块级用全局 document 预渲染一次贴图；移植后改成每个实例在 setup() 里
// 用元素自身的 ownerDocument 建一份、挂在 state.TEX 上，多实例互不干扰。
// TEX[colorIndex][radiusIndex] = canvas
function buildTextures(s) {
  const TEX = s.TEX;
  for (let ci = 0; ci < CONFIG.PALETTE.length; ci++) {
    const c = CONFIG.PALETTE[ci];
    const colStr = c[0] + ',' + c[1] + ',' + c[2];
    const arr = [];
    for (let ri = 0; ri < CONFIG.TEX_RADII.length; ri++) {
      const rad = CONFIG.TEX_RADII[ri];
      const size = rad * 2;
      // 离屏贴图画布：只创建，绝不挂进 DOM
      const cv = s.doc.createElement('canvas');
      cv.width = size; cv.height = size;
      const g = cv.getContext('2d');
      const grd = g.createRadialGradient(rad, rad, 0, rad, rad, rad);
      grd.addColorStop(0, 'rgba(' + colStr + ',1)');
      grd.addColorStop(0.4, 'rgba(' + colStr + ',0.6)');
      grd.addColorStop(1, 'rgba(' + colStr + ',0)');
      g.fillStyle = grd;
      g.beginPath();
      g.arc(rad, rad, rad, 0, TAU);
      g.fill();
      arr.push(cv);
    }
    TEX.push(arr);
  }
}

/* ============================================================
   3. 画布与视口 —— 全部由基类负责
   ============================================================ */
// 原型的 resize()（innerWidth / devicePixelRatio / canvas.width / setTransform）
// 与 W / H / dpr 三个全局量已删除：基类维护画布缓冲、DPR 缩放与尺寸，
// 动效侧只在 onResize 里同步 state.W / state.H。

/* ============================================================
   4. 墨粒对象池
   ============================================================ */
function makeInk(idx) {
  return {
    idx: idx,
    active: false,
    x: 0, y: 0,          // 世界坐标
    ox: 0, oy: 0,        // 相对父墨滴中心的局部偏移
    r: 1,                // 半径
    a: 1, a0: 1, aTo: 1, // 当前 alpha / 基准 alpha / 目标 alpha
    ci: 0,               // 颜色索引
    lvx: 0, lvy: 0,      // 局部速度（丝缕风暴 / 墨云炸散用）
    vx: 0, vy: 0,        // 自由墨粒全局速度
    free: false,         // 是否为自由墨粒
    life: 0, maxLife: 1,
    phase: 0, amp: 0,    // 抖动相位与幅度
    hasTarget: false, fixed: false,
    tx: 0, ty: 0,        // 毛细爬行目标（局部坐标）
    crawlSpeed: 0
  };
}

function allocInk(s) {
  if (s.inkFreeCount === 0) return null;
  const i = s.inkFreeStack[--s.inkFreeCount];
  const p = s.inkPool[i];
  p.active = true;
  p.free = false;
  p.lvx = 0; p.lvy = 0;
  p.vx = 0; p.vy = 0;
  p.life = 0; p.maxLife = 1;
  p.phase = Math.random() * TAU;
  p.amp = 0;
  p.hasTarget = false;
  p.fixed = false;
  return p;
}

function freeInk(s, p) {
  if (!p || !p.active) return;
  p.active = false;
  p.amp = 0;
  s.inkFreeStack[s.inkFreeCount++] = p.idx;
}

/* ============================================================
   5. 墨滴对象 —— 四层结构（核心 / 扩散层 / 丝缕 / 毛细边缘）
   ============================================================ */
function makeDrop(s, kind, x, y, R, opts) {
  opts = opts || {};
  const isWater = (kind === 'water');
  const d = {
    kind: kind,
    x: x, y: y,
    vx: opts.vx || 0,
    vy: opts.vy || 0,
    R: R,
    scale: (opts.scale != null) ? opts.scale : 1,
    targetScale: (opts.targetScale != null) ? opts.targetScale : 1,
    colorIdx: (opts.colorIdx != null) ? opts.colorIdx : (isWater ? CONFIG.WATER_CORE : CONFIG.PAPER_BLUE),
    life: 0,
    maxLife: (opts.maxLife != null) ? opts.maxLife : 2.4,
    fadeIn: 0.12,
    alphaMul: 0,
    manual: false,           // 由外部逻辑控制寿命/透明度
    breathing: !!opts.breathing,
    detail: (opts.detail != null) ? opts.detail : 1,
    sink: (opts.sink != null) ? opts.sink : 0,
    fuseable: !!opts.fuseable,
    growT: 0, growDur: 0,
    inField: false,
    dead: false,
    core: null,
    diffuse: [],
    filaments: [],
    caps: [],
    parts: []
  };
  buildStructure(s, d);
  return d;
}

function buildStructure(s, d) {
  const isWater = (d.kind === 'water');
  const R = d.R;
  const D = d.detail;
  const ci = d.colorIdx;

  /* --- 结构 1：核心墨核 --- */
  const core = allocInk(s);
  if (core) {
    core.ox = 0; core.oy = 0;
    core.r = R;
    const ca = rand(CONFIG.CORE_ALPHA[0], CONFIG.CORE_ALPHA[1]);
    core.a = ca; core.a0 = ca; core.aTo = ca;
    core.ci = isWater ? CONFIG.WATER_CORE : ci;
    d.core = core;
    d.parts.push(core);
  }

  /* --- 结构 2：浓度扩散层 --- */
  const nD = Math.max(2, Math.round(rand(CONFIG.DIFFUSE_N[0], CONFIG.DIFFUSE_N[1]) * D));
  for (let i = 0; i < nD; i++) {
    const p = allocInk(s);
    if (!p) break;
    const ang = Math.random() * TAU;
    const ring = rand(CONFIG.DIFFUSE_RING[0], CONFIG.DIFFUSE_RING[1]) * R;
    p.ox = Math.cos(ang) * ring;
    p.oy = Math.sin(ang) * ring;
    p.r = rand(CONFIG.DIFFUSE_R[0], CONFIG.DIFFUSE_R[1]) * R;
    const tt = (ring / R - CONFIG.DIFFUSE_RING[0]) /
             Math.max(0.001, CONFIG.DIFFUSE_RING[1] - CONFIG.DIFFUSE_RING[0]);
    const da = lerp(CONFIG.DIFFUSE_ALPHA[1], CONFIG.DIFFUSE_ALPHA[0], clamp(tt, 0, 1));
    p.a = da; p.a0 = da; p.aTo = da;
    p.ci = isWater ? CONFIG.WATER_DIFF : ci;
    p.amp = rand(0.2, 0.8);
    d.diffuse.push(p);
    d.parts.push(p);
  }

  /* --- 结构 3：丝缕 --- */
  const nF = Math.max(2, Math.round(rand(CONFIG.FIL_N[0], CONFIG.FIL_N[1]) * D));
  const lenRange = isWater ? CONFIG.FIL_LEN : CONFIG.FIL_LEN_PAPER;
  for (let k = 0; k < nF; k++) {
    const a2 = (k / nF) * TAU + rand(-0.6, 0.6);
    addFilament(s, d, 0, 0, a2, rand(lenRange[0], lenRange[1]), 0);
  }

  /* --- 结构 4：毛细边缘（仅纸上墨） --- */
  if (!isWater) {
    const nC = Math.max(3, Math.round(rand(CONFIG.CAP_N[0], CONFIG.CAP_N[1]) * D));
    for (let j = 0; j < nC; j++) {
      const cp = allocInk(s);
      if (!cp) break;
      const clusterAng = Math.random() * TAU;
      const ca2 = clusterAng + rand(-0.22, 0.22);
      const cring = rand(CONFIG.CAP_RING[0], CONFIG.CAP_RING[1]) * R;
      cp.ox = Math.cos(ca2) * cring;
      cp.oy = Math.sin(ca2) * cring;
      cp.r = rand(CONFIG.CAP_R[0], CONFIG.CAP_R[1]) * R;
      const cAlpha = rand(CONFIG.CAP_ALPHA[0], CONFIG.CAP_ALPHA[1]);
      cp.a = cAlpha; cp.a0 = cAlpha; cp.aTo = cAlpha;
      cp.ci = isWater ? CONFIG.WATER_CAP : ci;
      cp.amp = rand(0.2, 0.7);
      // 毛细爬行目标
      const len0 = Math.hypot(cp.ox, cp.oy) || 1;
      const tgtLen = len0 * rand(1.10, 1.55);
      cp.tx = cp.ox / len0 * tgtLen;
      cp.ty = cp.oy / len0 * tgtLen;
      cp.hasTarget = true;
      cp.crawlSpeed = rand(CONFIG.CAP_CRAWL[0], CONFIG.CAP_CRAWL[1]);
      d.caps.push(cp);
      d.parts.push(cp);
    }
  }
}

/* 丝缕：二次贝塞尔曲线 + 分叉系统 */
function addFilament(s, d, sx, sy, ang, lenMul, depth) {
  const isWater = (d.kind === 'water');
  const R = d.R;
  const len = R * lenMul;
  const count = Math.max(3, Math.round(rand(CONFIG.FIL_PTS[0], CONFIG.FIL_PTS[1]) * d.detail));
  const baseR = R * rand(CONFIG.FIL_R[0], CONFIG.FIL_R[1]);
  const ci = isWater ? pick(CONFIG.WATER_FIL) : d.colorIdx;

  const ex = sx + Math.cos(ang) * len;
  const ey = sy + Math.sin(ang) * len;
  const nx = -Math.sin(ang), ny = Math.cos(ang);
  const bend = rand(-0.45, 0.45) * len;
  const cx = (sx + ex) * 0.5 + nx * bend;
  const cy = (sy + ey) * 0.5 + ny * bend;

  const pts = [];
  for (let i = 0; i < count; i++) {
    const p = allocInk(s);
    if (!p) break;
    const t = (count > 1) ? (i / (count - 1)) : 0;
    const mt = 1 - t;
    p.ox = mt * mt * sx + 2 * mt * t * cx + t * t * ex;
    p.oy = mt * mt * sy + 2 * mt * t * cy + t * t * ey;
    p.r = baseR * (1 - t * 0.55);
    const fa = (1 - t * 0.72) * 0.9;
    p.a = fa; p.a0 = fa; p.aTo = fa;
    p.ci = ci;
    p.phase = Math.random() * TAU;
    p.amp = rand(0.4, 1.5);
    pts.push(p);
    d.parts.push(p);
  }
  d.filaments.push({ pts: pts, vx: 0, vy: 0, depth: depth });

  /* 丝缕分叉（左键主力视觉） */
  if (depth < CONFIG.FORK_MAX_DEPTH) {
    const chance = CONFIG.FORK_CHANCE * (isWater ? 1 : 0.45);
    if (Math.random() < chance) {
      const nFork = (Math.random() < 0.6) ? 1 : 2;
      for (let f = 0; f < nFork; f++) {
        const fa2 = ang + rand(-0.85, 0.85);
        const fl = lenMul * rand(CONFIG.FORK_LEN[0], CONFIG.FORK_LEN[1]);
        addFilament(s, d, ex, ey, fa2, fl, depth + 1);
      }
    }
  }
}

function killDrop(s, d) {
  if (d.dead) return;
  d.dead = true;
  for (let i = 0; i < d.parts.length; i++) freeInk(s, d.parts[i]);
  d.parts.length = 0;
  d.core = null;
  d.diffuse.length = 0;
  d.filaments.length = 0;
  d.caps.length = 0;
}

/* ============================================================
   6. 自由墨粒 / 自由丝缕 / 水中涟漪 / 扩散场
   ============================================================ */
/* 溅射丝缕：不携带核心，只是一条由 4~6 个墨粒组成的曲线 */
function spawnSplashFilament(s, x, y, ang, len, baseR, ci, speed, maxLife, kind) {
  if (s.inkFreeCount < 8) return;
  const count = randInt(4, 6);
  const ex = x + Math.cos(ang) * len;
  const ey = y + Math.sin(ang) * len;
  const nx = -Math.sin(ang), ny = Math.cos(ang);
  const bend = rand(-0.4, 0.4) * len;
  const cx = (x + ex) * 0.5 + nx * bend;
  const cy = (y + ey) * 0.5 + ny * bend;

  const pts = [];
  for (let i = 0; i < count; i++) {
    const p = allocInk(s);
    if (!p) break;
    const t = i / (count - 1);
    const mt = 1 - t;
    p.x = mt * mt * x + 2 * mt * t * cx + t * t * ex;
    p.y = mt * mt * y + 2 * mt * t * cy + t * t * ey;
    p.r = baseR * (1 - t * 0.5);
    const fa = (1 - t * 0.7) * 0.85;
    p.a = fa; p.a0 = fa; p.aTo = fa;
    p.ci = ci;
    p.free = true;
    pts.push(p);
  }
  if (!pts.length) return;
  s.freeFilaments.push({
    pts: pts,
    vx: Math.cos(ang) * speed,
    vy: Math.sin(ang) * speed,
    life: 0,
    maxLife: maxLife,
    sink: (kind === 'water') ? 45 : 0
  });
}

/* 水中涟漪：一圈极淡墨点 */
function spawnRing(s, x, y, maxR, maxLife, alpha0) {
  if (s.inkFreeCount < 20) return;
  const n = randInt(12, 20);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const p = allocInk(s);
    if (!p) break;
    p.free = true;
    p.r = rand(1.5, 3.2);
    p.a = 0; p.a0 = 1; p.aTo = 1;
    p.ci = CONFIG.WATER_CAP;
    p.x = x; p.y = y;
    pts.push(p);
  }
  if (!pts.length) return;
  s.rings.push({ x: x, y: y, maxR: maxR, life: 0, maxLife: maxLife, alpha0: alpha0, pts: pts });
}

/* 纸痕：极淡的不规则墨点残迹 */
function spawnPaperStain(s, x, y, power) {
  const n = randInt(20, 42);
  for (let i = 0; i < n; i++) {
    const p = allocInk(s);
    if (!p) break;
    const a = Math.random() * TAU;
    const rr = Math.pow(Math.random(), 0.6) * (60 + 90 * power);
    p.x = x + Math.cos(a) * rr;
    p.y = y + Math.sin(a) * rr;
    p.free = true;
    p.r = rand(6, 22);
    const sa = rand(0.03, 0.08);
    p.a = sa; p.a0 = sa; p.aTo = sa;
    p.ci = (Math.random() < 0.5) ? CONFIG.PAPER_BLUE : CONFIG.PAPER_RED;
    p.vx = rand(-8, 8);
    p.vy = rand(-8, 8);
    p.maxLife = rand(1.2, 1.8);
    p.life = 0;
    s.freeInks.push(p);
  }
}

/* 落墨扩散场 */
function spawnField(s, x, y, strength) {
  s.fields.push({
    x: x, y: y,
    r: CONFIG.DIFFUSE_FIELD_R,
    life: 0,
    maxLife: CONFIG.DIFFUSE_FIELD_LIFE,
    strength: clamp(strength, 0.4, 1)
  });
}

/* ============================================================
   7. 鼠标输入 —— 按键交互进 onPointerDown / onPointerUp / onBlur
   ============================================================ */
// 原型监听 window 的 mousemove / mousedown / mouseup / blur，
// 坐标与速度由基类写入 this.input（原始逐帧速度见 update() 的说明）。

/* ============================================================
   8. 拖尾
   ============================================================ */
function updateTrail(s, dt) {
  const M = s.input;
  // 对应原型的 mouse.has 门：第一次 mousemove 之前不生成拖尾
  if (!s.has) return;
  if (!s.trailInit) {
    s.trailLastX = M.x; s.trailLastY = M.y;
    s.trailInit = true;
    return;
  }
  const dx = M.x - s.trailLastX;
  const dy = M.y - s.trailLastY;
  const dist = Math.hypot(dx, dy);
  s.trailAcc += dist;
  s.trailLastX = M.x;
  s.trailLastY = M.y;

  if (dist < 0.6) return;
  if (s.trailAcc < CONFIG.TRAIL_SPACING) return;

  const emitCount = Math.min(2, Math.floor(s.trailAcc / CONFIG.TRAIL_SPACING));
  s.trailAcc = 0;

  if (s.inkFreeCount < 120) return;

  const sp = s.speed;
  const R = clamp(3 + sp * 0.012, 3, 8);
  const kind = (s.rightDown && !s.leftDown) ? 'paper' : 'water';
  const colIdx = (kind === 'water') ? CONFIG.WATER_CORE :
               (Math.random() < 0.5 ? CONFIG.PAPER_BLUE : CONFIG.PAPER_RED);

  for (let i = 0; i < emitCount; i++) {
    const d = makeDrop(s, kind, M.x + rand(-4, 4), M.y + rand(-4, 4), R, {
      maxLife: rand(CONFIG.TRAIL_LIFE[0], CONFIG.TRAIL_LIFE[1]),
      detail: CONFIG.TRAIL_DETAIL,
      vx: s.rawVx * 0.3,
      vy: s.rawVy * 0.3,
      sink: (kind === 'water') ? rand(10, 35) : 0,
      colorIdx: colIdx
    });
    d.fuseable = false;
    s.drops.push(d);
  }
}

/* ============================================================
   9. 蓄力状态机
   ============================================================ */
function startCharge(s, kind) {
  const ch = s.charge;
  if (ch.active) return;
  ch.active = true;
  ch.kind = kind;
  ch.t = 0;
  ch.x = s.input.x;
  ch.y = s.input.y;
  ch.dripTimer = 0;
  ch.redDone = false;
  ch.redDrop = null;

  if (kind === 'water') {
    const d = makeDrop(s, 'water', s.input.x, s.input.y + CONFIG.CLOUD_SINK_DEPTH[0], CONFIG.CLOUD_R, {
      maxLife: 999, detail: 1, scale: 0.18, targetScale: 1,
      breathing: true, colorIdx: CONFIG.WATER_CORE
    });
    d.manual = true;
    d.sink = 25;
    ch.cloud = d;
    s.drops.push(d);
  } else {
    const b = makeDrop(s, 'paper', s.input.x, s.input.y, CONFIG.BLOB_R, {
      maxLife: 999, detail: 1, scale: 0.2, targetScale: 1,
      colorIdx: CONFIG.PAPER_BLUE
    });
    b.manual = true;
    ch.cloud = b;
    s.drops.push(b);
  }
}

function emitDrip(s) {
  const ch = s.charge;
  if (!ch.cloud || s.inkFreeCount < 120) return;
  const d = makeDrop(s, 'water',
    s.input.x + rand(-14, 14),
    s.input.y + rand(-8, 8),
    rand(5, 10), {
      maxLife: 999, detail: 0.35,
      sink: rand(90, 180),
      colorIdx: CONFIG.WATER_CORE
    });
  d.manual = true;
  d.targetDrop = ch.cloud;
  s.drops.push(d);
}

function updateCharge(s, dt, t) {
  const ch = s.charge;
  if (!ch.active) return;
  ch.t += dt;
  const p = clamp(ch.t / CONFIG.CHARGE_MAX, 0, 1);

  if (ch.kind === 'water') {
    const c = ch.cloud;
    if (c && !c.dead) {
      c.life = 0;
      const depth = lerp(CONFIG.CLOUD_SINK_DEPTH[0], CONFIG.CLOUD_SINK_DEPTH[1], Math.pow(p, 0.9));
      c.x = lerp(c.x, s.input.x, Math.min(1, dt * 4));
      c.y = lerp(c.y, ch.y + depth, Math.min(1, dt * 3));
      // 微震（蓄力过半后）
      if (p > 0.55) {
        const m = (p - 0.55) / 0.45;
        c.x += Math.sin(t * 47) * 1.6 * m;
        c.y += Math.cos(t * 53) * 1.4 * m;
      }
      c.targetScale = 0.18 + 0.82 * Math.pow(p, 0.85);
      c.sink = 20 + 45 * p;
      if (c.core) c.core.aTo = 0.95;
      // 丝缕逸散（蓄力 1.5s 后）
      if (ch.t > 1.5 && c.filaments.length && Math.random() < 0.03) {
        const f = pick(c.filaments);
        const lp = f.pts[f.pts.length - 1];
        if (lp && !lp.lvx && !lp.lvy) {
          const a = Math.atan2(lp.oy, lp.ox);
          const sp = rand(30, 70);
          for (let i = 0; i < f.pts.length; i++) {
            f.pts[i].lvx = Math.cos(a) * sp * rand(0.8, 1.2);
            f.pts[i].lvy = Math.sin(a) * sp * rand(0.8, 1.2);
          }
        }
      }
    }
    // 连续滴落
    ch.dripTimer -= dt;
    if (ch.dripTimer <= 0) {
      ch.dripTimer = rand(0.15, 0.25);
      emitDrip(s);
    }
  } else {
    /* ---- 纸上墨 ---- */
    const b = ch.cloud;
    if (b && !b.dead) {
      b.life = 0;
      b.x = lerp(b.x, s.input.x, Math.min(1, dt * 5));
      b.y = lerp(b.y, s.input.y, Math.min(1, dt * 5));
      // 微震（径向为主）
      if (p > 0.55) {
        const m2 = (p - 0.55) / 0.45;
        const ra = Math.random() * TAU;
        b.x += Math.cos(ra) * 1.4 * m2;
        b.y += Math.sin(ra) * 1.4 * m2;
      }
      b.targetScale = 0.2 + 0.8 * Math.pow(p, 0.8);
      // 蓄力超过 1.5s：交界辉光（提升毛细墨点 alpha）
      if (ch.t > 1.5) {
        for (let q = 0; q < b.caps.length; q++) {
          const cp = b.caps[q];
          cp.aTo = clamp(cp.a0 + 0.12, 0, 0.9);
        }
      }
    }
    // 0.8s 后落下朱砂
    if (!ch.redDone && ch.t > 0.8) {
      ch.redDone = true;
      const ang = Math.random() * TAU;
      const dist = rand(40, 80);
      const rd = makeDrop(s, 'paper',
        ch.x + Math.cos(ang) * dist,
        ch.y + Math.sin(ang) * dist,
        CONFIG.BLOB_R * 0.72, {
          maxLife: 999, detail: 0.85, scale: 0.2, targetScale: 1,
          colorIdx: CONFIG.PAPER_RED
        });
      rd.manual = true;
      ch.redDrop = rd;
      s.drops.push(rd);
    }
    if (ch.redDrop && !ch.redDrop.dead) {
      ch.redDrop.life = 0;
      const rp = clamp((ch.t - 0.8) / Math.max(0.01, CONFIG.CHARGE_MAX - 0.8), 0, 1);
      ch.redDrop.targetScale = 0.2 + 0.8 * Math.pow(rp, 0.8);
      // 边界扰动
      if (Math.random() < 0.06) {
        const caps = ch.redDrop.caps;
        if (caps.length) {
          const cpk = caps[(Math.random() * caps.length) | 0];
          cpk.ox += rand(-3, 3);
          cpk.oy += rand(-3, 3);
        }
      }
    }
    // 青墨边界扰动
    if (b && b.caps.length && Math.random() < 0.08) {
      const cp2 = b.caps[(Math.random() * b.caps.length) | 0];
      cp2.ox += rand(-3, 3);
      cp2.oy += rand(-3, 3);
    }
  }
}

function abortCharge(s) {
  const ch = s.charge;
  if (!ch.active) return;
  ch.active = false;
  if (ch.cloud) killDrop(s, ch.cloud);
  if (ch.redDrop) killDrop(s, ch.redDrop);
  ch.cloud = null;
  ch.redDrop = null;
}

function endCharge(s, kind) {
  const ch = s.charge;
  if (!ch.active || ch.kind !== kind) return;
  const t = ch.t;
  ch.active = false;
  const c = ch.cloud;
  const rd = ch.redDrop;
  ch.cloud = null;
  ch.redDrop = null;

  if (t < CONFIG.CLICK_MIN) {
    if (c) killDrop(s, c);
    if (rd) killDrop(s, rd);
    doClick(s, kind);
    return;
  }
  const p = clamp(t / CONFIG.CHARGE_MAX, 0, 1);
  const power = Math.pow(p, 1.6);

  if (kind === 'water') burstWater(s, c, power);
  else burstPaper(s, c, rd, power);
}

/* ============================================================
   10. 单击
   ============================================================ */
function doClick(s, kind) {
  const x = s.input.x, y = s.input.y;

  if (kind === 'water') {
    const d = makeDrop(s, 'water', x, y, rand(12, 18), {
      maxLife: 2.6, detail: 0.7, sink: 45, colorIdx: CONFIG.WATER_CORE
    });
    d.scale = 0.05;
    d.targetScale = 1;
    d.growDur = 0.15;
    d.growT = 0;
    s.drops.push(d);

    const n = randInt(8, 14);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const sp = rand(150, 400);
      const sd = makeDrop(s, 'water', x, y, rand(2, 5), {
        maxLife: rand(0.9, 1.7), detail: 0.25,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        sink: rand(30, 70), colorIdx: CONFIG.WATER_CORE
      });
      s.drops.push(sd);
    }
    spawnRing(s, x, y, 80, 0.6, 0.2);
    spawnField(s, x, y, 0.6);
  } else {
    const b = makeDrop(s, 'paper', x, y, rand(10, 15), {
      maxLife: 2.4, detail: 0.6, colorIdx: CONFIG.PAPER_BLUE
    });
    b.scale = 0.05;
    b.targetScale = 1;
    b.growDur = 0.15;
    b.growT = 0;
    s.drops.push(b);

    const n2 = randInt(6, 10);
    for (let j = 0; j < n2; j++) {
      const a2 = Math.random() * TAU;
      const rr = rand(20, 60);
      const cp = allocInk(s);
      if (!cp) break;
      cp.ox = Math.cos(a2) * rr;
      cp.oy = Math.sin(a2) * rr;
      cp.r = rand(1, 3);
      const ca = rand(0.06, 0.18);
      cp.a = ca; cp.a0 = ca; cp.aTo = ca;
      cp.ci = (Math.random() < 0.6) ? CONFIG.PAPER_BLUE : CONFIG.PAPER_RED;
      cp.free = true;
      cp.x = x + cp.ox;
      cp.y = y + cp.oy;
      cp.maxLife = rand(0.8, 1.4);
      cp.vx = Math.cos(a2) * rand(40, 120);
      cp.vy = Math.sin(a2) * rand(40, 120);
      s.freeInks.push(cp);
    }
    spawnField(s, x, y, 0.6);
  }
}

/* ============================================================
   11. 左键松开 —— 水中墨爆发（丝缕风暴）
   ============================================================ */
function burstWater(s, c, power) {
  let cx = s.input.x, cy = s.input.y;
  if (c && !c.dead) {
    cx = c.x; cy = c.y;
    c.targetScale = c.scale; // 冻结缩放
    c.manual = false;
    c.maxLife = Math.max(c.life + 2.2, c.life + 0.01);
    c.fadeIn = 0;

    /* 1. 丝缕风暴：原有丝缕保持形态飞出 */
    const baseSpeed = 200 + 700 * power;
    for (let i = 0; i < c.filaments.length; i++) {
      const f = c.filaments[i];
      const pts = f.pts;
      if (!pts.length) continue;
      const last = pts[pts.length - 1];
      const dirx = last.ox, diry = last.oy;
      const dl = Math.hypot(dirx, diry) || 1;
      const sp = baseSpeed * rand(0.7, 1.2);
      const vx = dirx / dl * sp;
      const vy = diry / dl * sp + 70;
      for (let j = 0; j < pts.length; j++) {
        pts[j].lvx = vx;
        pts[j].lvy = vy;
      }
    }

    /* 2. 墨云炸散：核心变淡，扩散层外飞 */
    if (c.core) c.core.aTo = 0.3;
    for (let k = 0; k < c.diffuse.length; k++) {
      const dp = c.diffuse[k];
      const da = Math.atan2(dp.oy, dp.ox);
      const dsp = rand(100, 300);
      dp.lvx = Math.cos(da) * dsp;
      dp.lvy = Math.sin(da) * dsp;
      dp.aTo = dp.a0 * 0.45;
    }
    // 整体向下猛沉
    c.vy += 120 + 180 * power;
  }

  /* 3. 丝缕雨：从爆发点向外飞出的新丝缕 */
  const nRain = Math.round(20 + 80 * power);
  const rainCols = CONFIG.WATER_FIL;
  for (let m = 0; m < nRain; m++) {
    if (s.inkFreeCount < 20) break;
    const a = Math.random() * TAU;
    const len = rand(40, 120);
    const br = rand(1.2, 3.2);
    const ci = pick(rainCols);
    const sp2 = 250 + 800 * power;
    spawnSplashFilament(s, cx, cy, a, len, br, ci, sp2 * rand(0.7, 1.2), rand(0.5, 0.85), 'water');
  }

  /* 4. 水中涟漪 */
  const nRings = randInt(3, 5);
  for (let r = 0; r < nRings; r++) {
    const maxR = 80 + 300 * power;
    spawnRing(s, cx, cy, maxR * rand(0.4, 1.0), rand(0.6, 0.9), 0.15);
  }

  /* 5. 余韵：持续缓慢下沉的墨迹 */
  for (let y2 = 0; y2 < 6; y2++) {
    if (s.inkFreeCount < 20) break;
    const pp = allocInk(s);
    if (!pp) break;
    pp.free = true;
    pp.x = cx + rand(-60, 60);
    pp.y = cy + rand(-30, 60);
    pp.r = rand(8, 26);
    const pa = rand(0.05, 0.12);
    pp.a = pa; pp.a0 = pa; pp.aTo = pa;
    pp.ci = pick(CONFIG.WATER_FIL);
    pp.vx = rand(-15, 15);
    pp.vy = rand(30, 60);
    pp.maxLife = rand(1.4, 2.0);
    pp.life = 0;
    s.freeInks.push(pp);
  }

  /* 6. 拖尾被挤开 */
  spawnField(s, cx, cy, Math.max(0.7, power));
}

/* ============================================================
   12. 右键松开 —— 纸上墨爆发（毛细风暴 + 分形边界炸裂）
   ============================================================ */
function burstPaper(s, c, red, power) {
  let px = s.input.x, py = s.input.y;
  const list = [];
  if (c && !c.dead) list.push(c);
  if (red && !red.dead) list.push(red);

  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    px = d.x; py = d.y;
    d.targetScale = d.scale;
    d.manual = false;
    d.maxLife = Math.max(d.life + 2.2, d.life + 0.01);
    d.fadeIn = 0;

    /* 1. 毛细风暴：毛细墨点向外飞射 */
    const capSpeed = 150 + 500 * power;
    for (let j = 0; j < d.caps.length; j++) {
      const cp = d.caps[j];
      const a = Math.atan2(cp.oy, cp.ox);
      const sp = capSpeed * rand(0.7, 1.2);
      cp.lvx = Math.cos(a) * sp;
      cp.lvy = Math.sin(a) * sp;
      cp.hasTarget = false;
      cp.aTo = cp.a0 * 0.8;
    }
    /* 2. 墨斑炸散 */
    if (d.core) d.core.aTo = 0.4;
    for (let k = 0; k < d.diffuse.length; k++) {
      const dp = d.diffuse[k];
      const da = Math.atan2(dp.oy, dp.ox);
      const dsp = rand(80, 250);
      dp.lvx = Math.cos(da) * dsp;
      dp.lvy = Math.sin(da) * dsp;
      dp.aTo = dp.a0 * 0.5;
    }
  }

  /* 3. 分形边界炸裂：两色互相侵入 */
  if (c && red && !c.dead && !red.dead) {
    const ang = Math.atan2(red.y - c.y, red.x - c.x);
    const n = randInt(10, 30);
    for (let m = 0; m < n; m++) {
      const t = Math.random();
      const bx = lerp(c.x, red.x, t) + rand(-35, 35);
      const by = lerp(c.y, red.y, t) + rand(-35, 35);
      const dir = (Math.random() < 0.5) ? 1 : -1;
      const a2 = ang + (dir > 0 ? 0 : Math.PI) + rand(-0.55, 0.55);
      const ci = (dir > 0) ? CONFIG.PAPER_BLUE : CONFIG.PAPER_RED;
      spawnSplashFilament(s, bx, by, a2, rand(15, 40), rand(1.5, 3), ci,
        rand(200, 500), 0.4, 'paper');
    }
    /* 4. 颜色侵入：边缘生成少量异色墨粒 */
    for (let q = 0; q < 2; q++) {
      const dd = (q === 0) ? c : red;
      const other = (q === 0) ? CONFIG.PAPER_RED : CONFIG.PAPER_BLUE;
      const cnt = randInt(3, 8);
      for (let z = 0; z < cnt; z++) {
        const ip = allocInk(s);
        if (!ip) break;
        const aa = Math.random() * TAU;
        // 原型此处写作 d.R（d 是上一轮 list 循环的残留变量，恒为最后一颗墨滴），
        // 已按上下文修正为当前处理的墨滴 dd.R
        const rr = dd.R * rand(0.9, 1.5);
        ip.ox = Math.cos(aa) * rr;
        ip.oy = Math.sin(aa) * rr;
        ip.r = rand(2, 5);
        const ia = rand(0.15, 0.35);
        ip.a = ia; ip.a0 = ia; ip.aTo = ia;
        ip.ci = other;
        ip.free = true;
        ip.x = dd.x + ip.ox;
        ip.y = dd.y + ip.oy;
        ip.maxLife = rand(0.8, 1.5);
        ip.vx = Math.cos(aa) * rand(20, 90);
        ip.vy = Math.sin(aa) * rand(20, 90);
        s.freeInks.push(ip);
      }
    }
  }

  /* 5. 纸痕残迹 */
  spawnPaperStain(s, px, py, power);

  /* 6. 拖尾被挤开 */
  spawnField(s, px, py, Math.max(0.7, power));
}

/* ============================================================
   13. 墨滴更新
   ============================================================ */
function updateDrop(s, d, dt, t) {
  /* 生长弹出动画 */
  if (d.growDur > 0) {
    d.growT += dt;
    const gt = clamp(d.growT / d.growDur, 0, 1);
    if (gt < 0.7) d.scale = (gt / 0.7) * 1.1;
    else d.scale = 1.1 - ((gt - 0.7) / 0.3) * 0.1;
    if (gt >= 1) { d.growDur = 0; d.scale = 1; }
  }

  /* 生命周期 */
  if (!d.manual) {
    d.life += dt;
    if (d.life >= d.maxLife) { killDrop(s, d); return; }
  } else {
    d.life += dt;
  }

  /* 透明度 */
  let am = 1;
  if (!d.manual) {
    if (d.life < d.fadeIn) am = d.life / d.fadeIn;
    const pr = d.life / d.maxLife;
    if (pr > 0.6) am *= 1 - (pr - 0.6) / 0.4;
  } else {
    am = Math.min(1, d.alphaMul + dt * 8);
  }
  d.alphaMul = clamp(am, 0, 1);

  /* 位置积分 */
  d.x += d.vx * dt;
  d.y += d.vy * dt;

  const damp = Math.exp(-CONFIG.DRAG * dt);
  d.vx *= damp;
  d.vy *= damp;

  /* 水中墨：下沉 + 水平流场 */
  if (d.kind === 'water') {
    if (d.sink > 0) {
      d.vy += (d.sink - d.vy) * Math.min(1, dt * 2.2);
    }
    const flow =
      Math.sin(d.y * 0.006 + t * CONFIG.FLOW_FREQ) * 0.6 +
      Math.sin(d.x * 0.004 + t * CONFIG.FLOW_FREQ * 0.65) * 0.4;
    d.x += flow * CONFIG.FLOW_AMP * dt;
  }

  /* 落墨扩散场影响 */
  d.inField = false;
  for (let fi = 0; fi < s.fields.length; fi++) {
    const f = s.fields[fi];
    const fdx = d.x - f.x, fdy = d.y - f.y;
    const fdist = Math.hypot(fdx, fdy);
    if (fdist < f.r && fdist > 0.5) {
      d.inField = true;
      const push = 60 * f.strength;
      d.vx = lerp(d.vx, fdx / fdist * push, Math.min(1, dt * 3));
      d.vy = lerp(d.vy, fdy / fdist * push, Math.min(1, dt * 3));
      // 丝缕拉长、浓度变淡
      const partsF = d.parts;
      for (let pfi = 0; pfi < partsF.length; pfi++) {
        const pf = partsF[pfi];
        pf.ox *= 1 + 0.7 * dt;
        pf.oy *= 1 + 0.7 * dt;
        pf.aTo = pf.a0 * 0.75;
      }
    }
  }
  if (!d.inField) {
    for (let ri = 0; ri < d.parts.length; ri++) {
      d.parts[ri].aTo = d.parts[ri].a0;
    }
  }

  /* 缩放过渡 */
  if (d.growDur === 0) {
    d.scale += (d.targetScale - d.scale) * Math.min(1, dt * 5);
  }

  /* 局部速度积分 + alpha 过渡 */
  const parts = d.parts;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.lvx !== 0 || p.lvy !== 0) {
      p.ox += p.lvx * dt;
      p.oy += p.lvy * dt;
      const ld = Math.exp(-1.4 * dt);
      p.lvx *= ld;
      p.lvy *= ld;
      if (Math.abs(p.lvx) < 1) p.lvx = 0;
      if (Math.abs(p.lvy) < 1) p.lvy = 0;
    }
    if (p.a !== p.aTo) {
      p.a += (p.aTo - p.a) * Math.min(1, dt * 6);
    }
  }

  /* 毛细爬行（纸上墨专用） */
  if (d.kind === 'paper') {
    for (let ci2 = 0; ci2 < d.caps.length; ci2++) {
      const cp = d.caps[ci2];
      if (cp.hasTarget && !cp.fixed) {
        const cdx = cp.tx - cp.ox;
        const cdy = cp.ty - cp.oy;
        const cd = Math.hypot(cdx, cdy);
        if (cd < 0.8) {
          cp.fixed = true;
        } else {
          const step = cp.crawlSpeed * dt / Math.max(0.2, d.scale);
          cp.ox += cdx / cd * step;
          cp.oy += cdy / cd * step;
        }
      }
    }
  }

  /* 同步世界坐标 + 丝缕抖动 */
  let sc = d.scale;
  if (d.breathing) {
    sc *= 1 + 0.05 * Math.sin(t * TAU * 0.8 + d.x * 0.01);
  }
  for (let w = 0; w < parts.length; w++) {
    const wp = parts[w];
    wp.x = d.x + wp.ox * sc;
    wp.y = d.y + wp.oy * sc;
    if (wp.amp > 0) {
      wp.x += Math.sin(t * 1.8 + wp.phase) * wp.amp;
      wp.y += Math.cos(t * 1.5 + wp.phase * 1.3) * wp.amp;
    }
  }

  /* 连续滴落的墨滴：向墨云靠拢并融合 */
  if (d.targetDrop && !d.targetDrop.dead) {
    const tc = d.targetDrop;
    const tdx = tc.x - d.x, tdy = tc.y - d.y;
    const td = Math.hypot(tdx, tdy) || 1;
    if (td < tc.R * tc.scale * 1.05) {
      tc.targetScale = Math.min(tc.targetScale * 1.015 + 0.004, 1.18);
      killDrop(s, d);
      return;
    }
    d.vx += tdx / td * 140 * dt;
    d.vy += tdy / td * 140 * dt;
  }
}

/* ============================================================
   14. 自由墨粒 / 自由丝缕 / 涟漪 / 扩散场 更新
   ============================================================ */
function updateFreeStuff(s, dt, t) {
  /* 自由墨粒 */
  for (let i = s.freeInks.length - 1; i >= 0; i--) {
    const p = s.freeInks[i];
    p.life += dt;
    if (p.life >= p.maxLife) {
      freeInk(s, p);
      s.freeInks.splice(i, 1);
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const dm = Math.exp(-2.0 * dt);
    p.vx *= dm;
    p.vy *= dm;
    const k = 1 - p.life / p.maxLife;
    p.a = p.a0 * clamp(k, 0, 1);
  }

  /* 自由丝缕 */
  for (let j = s.freeFilaments.length - 1; j >= 0; j--) {
    const ff = s.freeFilaments[j];
    ff.life += dt;
    if (ff.life >= ff.maxLife) {
      for (let q = 0; q < ff.pts.length; q++) freeInk(s, ff.pts[q]);
      s.freeFilaments.splice(j, 1);
      continue;
    }
    const fdm = Math.exp(-2.2 * dt);
    ff.vx *= fdm;
    ff.vy *= fdm;
    ff.vy += ff.sink * dt * 0.55;
    const pts = ff.pts;
    for (let m = 0; m < pts.length; m++) {
      const fp = pts[m];
      fp.x += ff.vx * dt;
      fp.y += ff.vy * dt;
    }
    const ka = 1 - ff.life / ff.maxLife;
    for (let n = 0; n < pts.length; n++) {
      pts[n].a = pts[n].a0 * clamp(ka, 0, 1);
    }
  }

  /* 水中涟漪 */
  for (let r = s.rings.length - 1; r >= 0; r--) {
    const rg = s.rings[r];
    rg.life += dt;
    if (rg.life >= rg.maxLife) {
      for (let si = 0; si < rg.pts.length; si++) freeInk(s, rg.pts[si]);
      s.rings.splice(r, 1);
      continue;
    }
    const rt = rg.life / rg.maxLife;
    const rr = lerp(15, rg.maxR, rt);
    const ra = rg.alpha0 * (1 - rt) * (1 - rt);
    for (let u = 0; u < rg.pts.length; u++) {
      const rp = rg.pts[u];
      const ang = (u / rg.pts.length) * TAU;
      rp.x = rg.x + Math.cos(ang) * rr;
      rp.y = rg.y + Math.sin(ang) * rr;
      rp.a = ra;
      rp.a0 = ra;
    }
  }

  /* 扩散场 */
  for (let f = s.fields.length - 1; f >= 0; f--) {
    s.fields[f].life += dt;
    if (s.fields[f].life >= s.fields[f].maxLife) s.fields.splice(f, 1);
  }
}

/* ============================================================
   15. 墨滴融合（空间网格，仅蓄力墨滴参与）
   ============================================================ */
// 说明：原型没有任何调用点把 fuseable 置为 true（makeDrop 只从 opts.fuseable 取值，
// 唯一显式写入的 updateTrail 是 d.fuseable = false），因此这段融合逻辑在原文件里
// 同样永远不会命中，属于「静默失效的死代码」。这里原样保留算法以维持 1:1 对应，
// 只去掉了从未被读写的原型变量 fuseGrid。
function tryFuse(s) {
  const list = [];
  for (let i = 0; i < s.drops.length; i++) {
    const d = s.drops[i];
    if (d.fuseable && !d.dead && d.kind === 'water' && d.colorIdx === CONFIG.WATER_CORE) {
      list.push(d);
    }
  }
  if (list.length < 2 || list.length > 60) return;

  for (let a = 0; a < list.length; a++) {
    const A = list[a];
    if (A.dead) continue;
    for (let b = a + 1; b < list.length; b++) {
      const B = list[b];
      if (B.dead) continue;
      const dx = A.x - B.x, dy = A.y - B.y;
      const dist = Math.hypot(dx, dy);
      const rA = A.R * A.scale, rB = B.R * B.scale;
      if (dist < (rA + rB) * CONFIG.FUSE_FACTOR) {
        // 小墨滴被大墨滴吸收
        const big = (A.R >= B.R) ? A : B;
        const small = (A.R >= B.R) ? B : A;
        // 体积守恒
        const newR = Math.sqrt(big.R * big.R + small.R * small.R * 0.6);
        big.R = Math.min(newR, big.R * 1.25);
        if (big.core) big.core.r = big.R;
        big.targetScale = Math.min(big.targetScale * 1.02 + 0.01, 1.2);
        killDrop(s, small);
      }
    }
  }
}

/* ============================================================
   16. 渲染
   ============================================================ */
function drawParticle(s, p, alphaMul, scale) {
  const a = p.a * alphaMul;
  if (a <= 0.004) return;
  const rad = p.r * scale;
  if (rad <= 0.15) return;
  const ctx = s.ctx;
  const list = s.TEX[p.ci] || s.TEX[0];
  let ti = 0;
  const n = CONFIG.TEX_RADII.length;
  while (ti < n - 1 && CONFIG.TEX_RADII[ti] < rad) ti++;
  const tex = list[ti];
  ctx.globalAlpha = a > 1 ? 1 : a;
  ctx.drawImage(tex, p.x - rad, p.y - rad, rad * 2, rad * 2);
}

function drawDrop(s, d) {
  if (d.dead) return;
  const am = d.alphaMul;
  if (am <= 0.01) return;
  let sc = d.scale;
  if (d.breathing) {
    sc *= 1 + 0.05 * Math.sin(s.time * TAU * 0.8 + d.x * 0.01);
  }

  /* 绘制顺序：毛细边缘 → 丝缕 → 浓度扩散层 → 核心墨核 */
  for (let i = 0; i < d.caps.length; i++) {
    drawParticle(s, d.caps[i], am, sc);
  }
  for (let i = 0; i < d.filaments.length; i++) {
    const pts = d.filaments[i].pts;
    for (let j = 0; j < pts.length; j++) {
      drawParticle(s, pts[j], am, sc);
    }
  }
  for (let i = 0; i < d.diffuse.length; i++) {
    drawParticle(s, d.diffuse[i], am, sc);
  }
  if (d.core) {
    drawParticle(s, d.core, am, sc);
  }
}

export class CursorInk extends CursorEffectElement {
  // 原型用的是 mousemove / mousedown / mouseup（不是 pointer 事件族），
  // 不声明这一行，基类会去监听 pointermove，动效将完全收不到鼠标输入。
  inputFamily = 'mouse';

  /* ============================================================
     18. 启动 —— 只建池、贴图与状态，不注册任何监听
     ============================================================ */
  setup({ canvas, ctx, width, height, input }) {
    // 与原型一致：初始光标位置取视口中心（原型启动时 mouse.x = W * 0.5）
    input.x = input.lx = width * 0.5;
    input.y = input.ly = height * 0.5;

    const s = {
      // 本实例的画布上下文（已按 DPR 缩放过，统一使用 CSS 像素坐标）
      ctx,

      // 画布尺寸（CSS 像素），由基类 onResize 同步
      W: width,
      H: height,

      input,

      // 离屏纹理的宿主文档：取元素自身的 ownerDocument，不碰全局 document
      doc: canvas.ownerDocument,

      // 离屏纹理表 TEX[colorIndex][radiusIndex]
      TEX: [],

      // 全局时间（原型的 time）
      time: 0,

      // 光标原始速度：原型 updateMouse() 的 mouse.vx / vy / speed
      rawVx: 0,
      rawVy: 0,
      speed: 0,
      // 原型的 mouse.has：第一次 mousemove 之前不生成拖尾
      has: false,

      // 墨粒对象池
      inkPool: [],
      inkFreeStack: [],
      inkFreeCount: CONFIG.MAX_INK,

      // 墨滴 / 自由墨粒 / 自由丝缕 / 涟漪 / 扩散场
      drops: [],
      freeInks: [],
      freeFilaments: [],
      rings: [],
      fields: [],

      // 左右键状态
      leftDown: false,
      rightDown: false,

      // 拖尾
      trailLastX: 0, trailLastY: 0, trailAcc: 0, trailInit: false,

      // 蓄力状态机
      charge: {
        active: false,
        kind: null,
        t: 0,
        x: 0, y: 0,
        cloud: null,
        redDrop: null,
        redDone: false,
        dripTimer: 0
      }
    };

    for (let i = 0; i < CONFIG.MAX_INK; i++) {
      s.inkPool.push(makeInk(i));
      s.inkFreeStack.push(i);
    }

    buildTextures(s);

    return s;
  }

  /* ============================================================
     7. 输入（按键）—— 坐标与速度由基类写入 this.input
     ============================================================ */
  onPointerDown(e) {
    const s = this.state;
    if (!s) return;

    if (e.button === 0) {
      s.leftDown = true;
      startCharge(s, 'water');
    } else if (e.button === 2) {
      s.rightDown = true;
      startCharge(s, 'paper');
    }
  }

  onPointerUp(e) {
    const s = this.state;
    if (!s) return;

    if (e.button === 0 && s.leftDown) {
      s.leftDown = false;
      endCharge(s, 'water');
    } else if (e.button === 2 && s.rightDown) {
      s.rightDown = false;
      endCharge(s, 'paper');
    }
  }

  // 原型 window blur 的收尾：清掉按键状态并放弃当前蓄力
  onBlur() {
    const s = this.state;
    if (!s) return;
    s.leftDown = false;
    s.rightDown = false;
    abortCharge(s);
  }

  /* ============================================================
     3. 尺寸 —— 只同步动效自己的 W / H，画布与 DPR 由基类维护
     ============================================================ */
  onResize(width, height) {
    const s = this.state;
    if (!s) return;
    s.W = width;
    s.H = height;
  }

  /* ============================================================
     17. 主循环 —— 原型 frame() 去掉 rAF / render 后的部分
     ============================================================ */
  update(dt, s) {
    if (!s) return;

    s.time += dt;

    // 原型 updateMouse()：mouse.vx / vy 是「原始逐帧位移 / dt」，未经平滑，
    // 与基类 input.vx/vy（1-exp(-25dt) 平滑）语义不同，因此这里自己复现；
    // 原型的 6000 钳制与每帧 0.4 系数的速度 EMA（mouse.speed）也原样保留。
    const M = s.input;
    if (dt > 0) {
      s.rawVx = (M.x - M.lx) / dt;
      s.rawVy = (M.y - M.ly) / dt;
    } else {
      s.rawVx = 0;
      s.rawVy = 0;
    }
    let sp = Math.hypot(s.rawVx, s.rawVy);
    if (sp > 6000) sp = 6000;
    s.speed = s.speed + (sp - s.speed) * 0.4;

    // 原型的 mouse.has：第一次 mousemove 时把 px/py 对齐到当前位置（该帧 dx = 0）。
    // 基类的 input.inside 初始即为 true，不会做这次对齐，若不在这里补上，
    // 第一次移动会被当成「从视口中心跳过来」的巨大位移，速度与拖尾都会爆掉。
    if (!s.has && (M.x !== M.lx || M.y !== M.ly)) {
      s.rawVx = 0;
      s.rawVy = 0;
      s.speed = 0;
      s.has = true;
    }

    updateTrail(s, dt);
    updateCharge(s, dt, s.time);

    /* 墨滴更新 */
    for (let i = s.drops.length - 1; i >= 0; i--) {
      const d = s.drops[i];
      updateDrop(s, d, dt, s.time);
      if (d.dead) s.drops.splice(i, 1);
    }

    tryFuse(s);

    updateFreeStuff(s, dt, s.time);
  }

  /* ============================================================
     16. 渲染
     ============================================================ */
  render(s) {
    if (!s) return;
    const ctx = s.ctx;

    // 画布缓冲、DPR 与 setTransform 由基类维护（原型在此处的 setTransform 已移除），
    // 这里统一使用 CSS 像素坐标。原型没有任何整屏铺底，只做清屏。
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, s.W, s.H);

    /* 自由墨粒 */
    for (let i = 0; i < s.freeInks.length; i++) {
      drawParticle(s, s.freeInks[i], 1, 1);
    }
    /* 自由丝缕 */
    for (let i = 0; i < s.freeFilaments.length; i++) {
      const ff = s.freeFilaments[i];
      for (let j = 0; j < ff.pts.length; j++) {
        drawParticle(s, ff.pts[j], 1, 1);
      }
    }
    /* 涟漪 */
    for (let i = 0; i < s.rings.length; i++) {
      const rg = s.rings[i];
      for (let j = 0; j < rg.pts.length; j++) {
        drawParticle(s, rg.pts[j], 1, 1);
      }
    }
    /* 墨滴 */
    for (let i = 0; i < s.drops.length; i++) {
      drawDrop(s, s.drops[i]);
    }

    ctx.globalAlpha = 1;
  }
}

if (!customElements.get('cursor-ink')) {
  customElements.define('cursor-ink', CursorInk);
}

export default CursorInk;
