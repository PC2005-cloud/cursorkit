/**
 * cursor-silk —— 鼠标光标丝绸动效。
 *
 * 由 html/丝绸.html 原型移植：柔体弹簧网格、左键拉伸撕裂、右键折叠褶皱、
 * 丝线风暴、波纹传播等算法与数值与原文件一一对应。
 * 作为光标层组件，原型页面自身的行为已剔除：
 *   - 不携带深色页面底色（基类保证 canvas 透明，绘制中也没有整屏填底）；
 *   - 不拦截 contextmenu，宿主页面的右键菜单不受影响；
 *   - 画布创建、DPR 适配、监听注册、rAF 循环均由基类负责。
 *
 * 输入事件族：原型监听的是 mousemove / mousedown / mouseup，
 * 故声明 inputFamily = 'mouse'，由基类负责监听并把坐标写入 this.input。
 * 所有运行状态都放在 setup() 返回的 state 上，多实例互不干扰。
 */

import { CursorEffectElement } from '../core/base.js';
import { TAU, clamp, lerp, rand, randInt } from '../core/utils.js';

// ==== 配置 ====
/* CONFIG —— 集中所有可调参数 */
const CONFIG = {
  maxParticles: 1600,          // 粒子池上限
  maxThreads: 700,             // 丝线上限（非粒子，独立数组）

  // ---- 柔体模拟 ----
  sim: {
    maxDt: 1 / 30,             // 单帧最大步长，防炸
    gravity: 55,               // 全局重力 px/s²
    velDamp: 0.986,            // 每帧(60fps)速度衰减系数
    windAmp: 15,               // 风力振幅 px/s²
    windSpeed: 0.55,           // 风力演化速度
    springK: 900,              // 结构弹簧刚度
    shearK: 520,               // 剪切（对角）弹簧刚度
    springDamp: 7              // 弹簧阻尼系数
  },

  // ---- 两套配色（严格区分） ----
  cold: {                      // 左键 拉伸撕裂 —— 冷丝绸组
    dark:   [138, 106, 160],   // 绸面暗色 #8A6AA0
    sub:    [200, 176, 224],   // 绸面副色 #C8B0E0
    main:   [232, 216, 240],   // 绸面主色 #E8D8F0
    hi:     [255, 255, 255],   // 高光 #FFFFFF
    tear:   [255,  79, 216],   // 撕裂边缘 #FF4FD8
    thread: [240, 232, 255]    // 丝线 #F0E8FF
  },
  warm: {                      // 右键 折叠褶皱 —— 暖丝绸组
    dark:   [106,  74,  42],   // 褶皱暗影 #6A4A2A
    sub:    [224, 192, 144],   // 绸面副色 #E0C090
    main:   [240, 224, 200],   // 绸面主色 #F0E0C8
    hi:     [255, 232, 176],   // 褶皱高光 #FFE8B0
    tear:   [255, 248, 224],   // 高光 #FFF8E0
    thread: [255, 232, 176]    // 丝线 #FFE8B0
  },

  // ---- 拖尾丝带 ----
  trail: {
    minDist: 13,               // 触发间距 px
    cols: 3, rows: 2,          // 2×3 = 6 粒子
    cellW: 13, cellH: 11,
    life: [2.0, 4.0],          // 寿命区间 s
    maxSheets: 34
  },

  // ---- 单击 ----
  click: {
    gridN: 3,                  // 3×3 小块
    cell: 13,
    threadCount: 8,            // 飞散丝线
    rippleMax: 80,             // 波纹最大半径
    rippleLife: 0.5,
    starLife: 0.12
  },

  // ---- 左键：拉伸撕裂 ----
  left: {
    cols: 16, rows: 16,        // 网格 16×16
    startHalfW: 46,            // 初始半宽
    endHalfW: 150,             // 蓄满半宽
    startHalfH: 46,
    endHalfH: 58,
    chargeTime: 2.5,           // 蓄力时长 s
    strainThreshold: 1.8,      // 撕裂应变阈值
    healthRate: 3.0,           // 健康度下降速率
    minCharge: 0.12            // 低于此视为单击
  },

  // ---- 右键：折叠褶皱 ----
  right: {
    cols: 10, rows: 6,         // 网格 10×6
    initW: 200, initH: 110,    // 初始尺寸
    minW: 62,                  // 压缩到的最小宽度
    chargeTime: 2.5,
    foldMin: 2, foldMax: 8,    // 褶皱数量区间
    ampMin: 5, ampMax: 26,     // 褶皱振幅区间
    minCharge: 0.12
  },

  // ---- 抖动传播 ----
  ripple: {
    speed: 900,                // 波传播速度 px/s
    life: 0.4,                 // 持续时长
    strength: 220              // 冲量强度
  }
};

const MAXP = CONFIG.maxParticles;

// ==== 工具函数 ====
/* 颜色字符串缓存（量化到 4 的倍数，减少 GC）；缓存挂在 state 上，多实例互不干扰 */
function rgbStr(cache, r, g, b) {
  let R = (r | 0) & ~3, G = (g | 0) & ~3, B = (b | 0) & ~3;
  if (R < 0) R = 0; if (R > 255) R = 255;
  if (G < 0) G = 0; if (G > 255) G = 255;
  if (B < 0) B = 0; if (B > 255) B = 255;
  const key = (R << 16) | (G << 8) | B;
  let str = cache.get(key);
  if (str === undefined) {
    str = 'rgb(' + R + ',' + G + ',' + B + ')';
    cache.set(key, str);
  }
  return str;
}

// ==== Sheet —— 一张布（粒子网格 + 弹簧约束集合）====
class Sheet {
  constructor(type, cols, rows, palName) {
    this.type = type;              // 'main' | 'ribbon' | 'click' | 'frag'
    this.cols = cols;
    this.rows = rows;
    this.n = cols * rows;
    this.palName = palName;
    this.pal = palName === 'cold' ? CONFIG.cold : CONFIG.warm;
    this.idx = new Int32Array(this.n).fill(-1);

    /* 弹簧约束（用平行数组存储，避免对象开销） */
    this.sA = [];      // 端点 A（局部索引）
    this.sB = [];      // 端点 B
    this.sRest = [];   // 原长
    this.sK = [];      // 刚度
    this.sD = [];      // 阻尼
    this.sH = [];      // 健康度 0~1
    this.sAlive = [];  // 是否存活

    this.restCellW = 10;
    this.restCellH = 10;

    this.age = 0;
    this.life = Infinity;
    this.alpha = 1;
    this.dead = false;

    this.cx = 0; this.cy = 0;

    this.mode = 'free';        // 'free' | 'charge-left' | 'charge-right' | 'burst'
    this.chargeT = 0;
    this.power = 0;
    this.wavePhase = 0;
    this.invulnerable = false;

    this.block = new Int32Array(this.n);
    this.uf = new Int32Array(this.n);
    this.blocksDirty = true;

    this.ripple = null;        // {x, y, t0, used}
  }
}

export class CursorSilk extends CursorEffectElement {
  /**
   * 滚轮动效：绸缎状的长条缓慢飘动，几乎不受重力，靠阻尼收束。
   */
  wheelTheme() {
    return {
      style: 'shard',
      color:  [242, 232, 213],
      color2: [200, 180, 150],
      sizeMin: 3.5, sizeMax: 9,
      lifeMin: 0.8, lifeMax: 1.6,
      upSpeed: 130,
      downSpeed: 110,
      spread: 70,
      drag: 2.2,             // 强阻尼 → 出去就慢下来，像绸缎
      turbulence: 18,
      spin: 0.6,             // 缓慢自转
      grow: 2,
      jitter: 12
    };
  }

  /** 主题光标：米白描边 + 墨点装饰 */
  cursorTheme() {
    return {
      edge: '#f2e8d5',
      fill: 'rgba(30, 26, 20, .88)',
      glow: '#d8c9a8',
      deco: { color: [242, 232, 213], style: 'ink', rate: 11, speedGain: 0.16 }
    };
  }

  // 原型用的是 mouse 事件族，不声明的话基类会去监听 pointer*，动效收不到输入
  inputFamily = 'mouse';

  // ==== 初始化 ====
  // 只建池与状态，不注册任何监听（监听归基类）
  setup({ ctx, width, height, input }) {
    // 与原型一致：初始光标位置取视口中心。
    // 基类的 input 从 (0, 0) 起算，若不在这里对齐，首帧位移会按「从左上角跳过来」计算。
    input.x = input.lx = width * 0.5;
    input.y = input.ly = height * 0.5;

    /* 粒子池 —— 对象池，上限 CONFIG.maxParticles */
    const pool = new Array(MAXP);
    const freeStack = [];
    for (let i = 0; i < MAXP; i++) {
      pool[i] = {
        active: false,
        x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0,
        invMass: 1, pinned: false,
        ic: 0, ir: 0, sheet: null
      };
      freeStack.push(i);
    }

    return {
      // 本实例的画布上下文（已按 DPR 缩放过，统一使用 CSS 像素坐标）
      ctx,

      // 画布尺寸（CSS 像素），由基类 onResize 同步
      W: width,
      H: height,

      // 基类的光标输入：{ x, y, lx, ly, vx, vy, speed, inside }
      input,

      // 粒子池
      pool,
      freeStack,

      // 所有布面
      sheets: [],

      // 丝线系统 —— 独立于粒子的细线段
      threads: [],

      // 波纹 / 星芒 —— 单击与冲击的瞬时视觉
      ripples: [],
      stars: [],

      // 风力系统 —— 2~3 层正弦叠加
      wind: { x: 0, y: 0 },
      windT: 0,

      // 高光系统 —— 伪法线点积光源
      light: { x: 0.48, y: 0.34, z: 0.81 },
      lightT: 0,

      // 颜色字符串缓存
      colorCache: new Map(),

      // 左右键蓄力状态：charging 蓄力中，sheet 指向蓄力布面，downT 为按下时刻（s）
      left: { charging: false, sheet: null, downT: 0 },
      right: { charging: false, sheet: null, downT: 0 },

      // 冻结帧计时（原型中「松开瞬间的凝固」，但原文件从未把它置为正值，保留以对齐）
      freezeTimer: 0,

      // 拖尾触发点
      lastTrailX: width * 0.5,
      lastTrailY: height * 0.5,

      // 全局时间（s）：波纹相位、按键时长判定都基于它
      time: 0
    };
  }

  // ==== 粒子池 ====
  _allocP(s) {
    if (s.freeStack.length === 0) return -1;
    const i = s.freeStack.pop();
    const p = s.pool[i];
    p.active = true;
    p.pinned = false;
    p.invMass = 1;
    return i;
  }

  _freeP(s, i) {
    const p = s.pool[i];
    if (!p.active) return;
    p.active = false;
    p.sheet = null;
    s.freeStack.push(i);
  }

  // ==== 弹簧添加 ====
  _addSpring(sh, a, b, rest, k, d) {
    sh.sA.push(a);
    sh.sB.push(b);
    sh.sRest.push(rest);
    sh.sK.push(k);
    sh.sD.push(d);
    sh.sH.push(1);
    sh.sAlive.push(1);
  }

  // ==== 网格构建 —— 在指定位置生成 rows×cols 粒子网格并建立弹簧约束 ====
  _initGrid(s, sh, cx, cy, cellW, cellH, opts) {
    opts = opts || {};
    const cols = sh.cols, rows = sh.rows, idx = sh.idx;
    const startScale = opts.startScale !== undefined ? opts.startScale : 0.18;
    const spread = opts.spread !== undefined ? opts.spread : 9;
    const K = opts.k !== undefined ? opts.k : CONFIG.sim.springK;
    const KS = opts.ks !== undefined ? opts.ks : CONFIG.sim.shearK;
    const D = CONFIG.sim.springDamp;

    sh.restCellW = cellW;
    sh.restCellH = cellH;
    sh.cx = cx; sh.cy = cy;

    /* 检查粒子是否足够 */
    if (s.freeStack.length < sh.n) return false;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const pi = this._allocP(s);
        if (pi < 0) return false;
        const p = s.pool[pi];
        const tx = cx + (c - (cols - 1) * 0.5) * cellW;
        const ty = cy + (r - (rows - 1) * 0.5) * cellH;

        p.x = cx + (tx - cx) * startScale + rand(-0.7, 0.7);
        p.y = cy + (ty - cy) * startScale + rand(-0.7, 0.7);
        p.vx = (tx - p.x) * spread;
        p.vy = (ty - p.y) * spread;
        p.ax = 0; p.ay = 0;
        p.invMass = 1;
        p.pinned = false;
        p.ic = c; p.ir = r;
        p.sheet = sh;
        idx[r * cols + c] = pi;
      }
    }

    const diagRest = Math.sqrt(cellW * cellW + cellH * cellH);

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const a = r * cols + c;
        if (c + 1 < cols) this._addSpring(sh, a, a + 1, cellW, K, D);        // 结构：右
        if (r + 1 < rows) this._addSpring(sh, a, a + cols, cellH, K, D);     // 结构：下
        if (c + 1 < cols && r + 1 < rows) {
          this._addSpring(sh, a, a + cols + 1, diagRest, KS, D);             // 剪切：主对角
          this._addSpring(sh, a + 1, a + cols, diagRest, KS, D);             // 剪切：副对角
        }
      }
    }

    sh.blocksDirty = true;
    return true;
  }

  // ==== 并查集分块 —— 用于撕裂后跳过跨块的四边形 ====
  _computeBlocks(sh) {
    const n = sh.n;
    const uf = sh.uf;
    for (let i = 0; i < n; i++) uf[i] = i;

    const sA = sh.sA, sB = sh.sB, sAlive = sh.sAlive;
    const len = sA.length;
    for (let i = 0; i < len; i++) {
      if (!sAlive[i]) continue;
      let ra = sA[i];
      while (uf[ra] !== ra) { uf[ra] = uf[uf[ra]]; ra = uf[ra]; }
      let rb = sB[i];
      while (uf[rb] !== rb) { uf[rb] = uf[uf[rb]]; rb = uf[rb]; }
      if (ra !== rb) uf[ra] = rb;
    }

    const map = new Map();
    let next = 0;
    const block = sh.block;
    for (let i = 0; i < n; i++) {
      let r = i;
      while (uf[r] !== r) { uf[r] = uf[uf[r]]; r = uf[r]; }
      let b = map.get(r);
      if (b === undefined) { b = next++; map.set(r, b); }
      block[i] = b;
    }
    sh.blocksDirty = false;
  }

  // ==== 销毁 Sheet —— 归还所有粒子 ====
  _destroySheet(s, sh) {
    sh.dead = true;
    for (let i = 0; i < sh.n; i++) {
      const pi = sh.idx[i];
      if (pi >= 0) this._freeP(s, pi);
      sh.idx[i] = -1;
    }
  }

  /* 回收最旧的拖尾/碎片，腾出粒子空间 */
  _recycleOldest(s) {
    let best = null, bestAge = -1;
    for (let i = 0; i < s.sheets.length; i++) {
      const sh = s.sheets[i];
      if (sh.dead) continue;
      if (sh.type === 'ribbon' || sh.type === 'frag' || sh.type === 'click') {
        if (sh.age > bestAge) { bestAge = sh.age; best = sh; }
      }
    }
    if (best) { this._destroySheet(s, best); return true; }
    return false;
  }

  _ensureSpace(s, need) {
    let guard = 0;
    while (s.freeStack.length < need && guard++ < 40) {
      if (!this._recycleOldest(s)) break;
    }
  }

  // ==== 丝线系统 —— 独立于粒子的细线段 ====
  _spawnThread(s, x, y, dx, dy, speed, len, col, life) {
    if (s.threads.length >= CONFIG.maxThreads) return;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = dx / d, ny = dy / d;
    s.threads.push({
      x: x, y: y,
      vx: nx * speed + rand(-40, 40),
      vy: ny * speed + rand(-40, 40),
      ang: Math.atan2(ny, nx),
      len: len,
      spin: rand(-9, 9),
      life: life, maxLife: life,
      col: col
    });
  }

  _updateThreads(s, dt) {
    const threads = s.threads;
    for (let i = threads.length - 1; i >= 0; i--) {
      const t = threads[i];
      t.life -= dt;
      if (t.life <= 0) { threads.splice(i, 1); continue; }
      t.vx *= 0.985;
      t.vy = t.vy * 0.985 + 120 * dt;
      t.x += t.vx * dt;
      t.y += t.vy * dt;
      t.ang += t.spin * dt;
    }
  }

  _drawThreads(s) {
    const ctx = s.ctx;
    const threads = s.threads;
    for (let i = 0; i < threads.length; i++) {
      const t = threads[i];
      const a = clamp(t.life / t.maxLife, 0, 1);
      if (a <= 0.02) continue;
      ctx.globalAlpha = a * 0.95;
      ctx.strokeStyle = rgbStr(s.colorCache, t.col[0], t.col[1], t.col[2]);
      ctx.lineWidth = 1;
      const ex = Math.cos(t.ang) * t.len;
      const ey = Math.sin(t.ang) * t.len;
      ctx.beginPath();
      ctx.moveTo(t.x, t.y);
      ctx.lineTo(t.x + ex, t.y + ey);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ==== 波纹 / 星芒 —— 单击与冲击的瞬时视觉 ====
  _spawnRipple(s, x, y, col) {
    s.ripples.push({ x: x, y: y, t: 0, life: CONFIG.click.rippleLife, col: col });
  }

  _spawnStar(s, x, y) {
    s.stars.push({ x: x, y: y, t: 0, life: CONFIG.click.starLife });
  }

  _updateDecals(s, dt) {
    const ripples = s.ripples;
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      r.t += dt;
      if (r.t >= r.life) ripples.splice(i, 1);
    }
    const stars = s.stars;
    for (let i = stars.length - 1; i >= 0; i--) {
      const st = stars[i];
      st.t += dt;
      if (st.t >= st.life) stars.splice(i, 1);
    }
  }

  _drawRipples(s) {
    const ctx = s.ctx;
    const ripples = s.ripples;
    for (let i = 0; i < ripples.length; i++) {
      const r = ripples[i];
      const k = r.t / r.life;
      const rad = lerp(15, CONFIG.click.rippleMax, k);
      const a = (1 - k) * (1 - k);
      ctx.globalAlpha = a * 0.7;
      ctx.strokeStyle = rgbStr(s.colorCache, r.col[0], r.col[1], r.col[2]);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      const seg = 72;
      for (let j = 0; j <= seg; j++) {
        const ang = (j / seg) * TAU;
        const wob = 1 + Math.sin(ang * 6 + k * 8) * 0.12 * (1 - k);
        const rr = rad * wob;
        const px = r.x + Math.cos(ang) * rr;
        const py = r.y + Math.sin(ang) * rr;
        if (j === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  _drawStars(s) {
    const ctx = s.ctx;
    const stars = s.stars;
    for (let i = 0; i < stars.length; i++) {
      const st = stars[i];
      const k = st.t / st.life;
      const a = 1 - k;
      const len = lerp(30, 6, k);
      ctx.globalAlpha = a * 0.9;
      ctx.strokeStyle = 'rgb(255,255,255)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(st.x - len, st.y); ctx.lineTo(st.x + len, st.y);
      ctx.moveTo(st.x, st.y - len); ctx.lineTo(st.x, st.y + len);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ==== 风力系统 —— 2~3 层正弦叠加 ====
  _updateWind(s, dt) {
    s.windT += dt * CONFIG.sim.windSpeed;
    const windT = s.windT;
    s.wind.x = (Math.sin(windT * 0.73) * 0.62 + Math.sin(windT * 1.61 + 1.7) * 0.38) * CONFIG.sim.windAmp;
    s.wind.y = (Math.sin(windT * 1.07 + 2.3) * 0.5 + Math.sin(windT * 2.13) * 0.28) * CONFIG.sim.windAmp * 0.7;
  }

  // ==== 高光系统 —— 伪法线点积光源 ====
  _updateLight(s, dt) {
    s.lightT += dt * 0.22;
    const lx = Math.cos(s.lightT) * 0.62;
    const ly = Math.sin(s.lightT * 0.83) * 0.44;
    const lz = 0.78;
    const l = Math.sqrt(lx * lx + ly * ly + lz * lz);
    s.light.x = lx / l; s.light.y = ly / l; s.light.z = lz / l;
  }

  // ==== 柔体模拟 —— 弹簧力 + 外力 + 半隐式欧拉积分 ====
  _simulateSheet(s, sh, dt) {
    const pool = s.pool;
    const n = sh.n, idx = sh.idx;
    const sA = sh.sA, sB = sh.sB, sRest = sh.sRest, sK = sh.sK, sD = sh.sD, sH = sh.sH, sAlive = sh.sAlive;
    const cnt = sA.length;

    /* 1. 清空加速度 */
    for (let i = 0; i < n; i++) {
      const pi = idx[i];
      if (pi < 0) continue;
      const p = pool[pi];
      p.ax = 0; p.ay = 0;
    }

    /* 2. 弹簧力 F = -k*(len-rest)*dir + 阻尼 */
    const tearTh = CONFIG.left.strainThreshold;
    const healthRate = CONFIG.left.healthRate;

    for (let i = 0; i < cnt; i++) {
      if (!sAlive[i]) continue;
      const pa = pool[idx[sA[i]]];
      const pb = pool[idx[sB[i]]];
      if (!pa || !pb) continue;

      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const len2 = dx * dx + dy * dy;
      if (len2 < 0.0001) continue;
      const len = Math.sqrt(len2);

      const rest = sRest[i];
      const nx = dx / len, ny = dy / len;

      /* 弹簧力 */
      let f = (len - rest) * sK[i];
      /* 阻尼力：沿弹簧方向的相对速度 */
      const rv = (pb.vx - pa.vx) * nx + (pb.vy - pa.vy) * ny;
      f += rv * sD[i];

      const fx = nx * f, fy = ny * f;
      pa.ax += fx * pa.invMass; pa.ay += fy * pa.invMass;
      pb.ax -= fx * pb.invMass; pb.ay -= fy * pb.invMass;

      /* 撕裂：健康度衰减 */
      if (!sh.invulnerable) {
        const strain = len / rest;
        if (strain > tearTh) {
          sH[i] -= (strain - tearTh) * healthRate * dt;
          if (sH[i] <= 0) {
            sH[i] = 0;
            sAlive[i] = 0;
            sh.blocksDirty = true;
            /* 断裂瞬间生成丝线 */
            const mx = (pa.x + pb.x) * 0.5;
            const my = (pa.y + pb.y) * 0.5;
            for (let k = 0; k < 2; k++) {
              this._spawnThread(s, mx, my, pa.x - pb.x, pa.y - pb.y,
                rand(80, 240), rand(24, 60), sh.pal.thread, rand(0.5, 1.0));
            }
          }
        }
      }
    }

    /* 3. 外力 + 积分 */
    const wind = s.wind;
    for (let i = 0; i < n; i++) {
      const pi = idx[i];
      if (pi < 0) continue;
      const p = pool[pi];
      if (p.pinned) { p.vx = 0; p.vy = 0; continue; }

      p.ax += wind.x;
      p.ay += wind.y + CONFIG.sim.gravity;

      p.vx += p.ax * dt;
      p.vy += p.ay * dt;

      const dmp = Math.pow(CONFIG.sim.velDamp, dt * 60);
      p.vx *= dmp;
      p.vy *= dmp;

      /* 限速，防数值爆炸 */
      const sp2 = p.vx * p.vx + p.vy * p.vy;
      if (sp2 > 250000) {
        const sp = Math.sqrt(sp2);
        p.vx = p.vx / sp * 500;
        p.vy = p.vy / sp * 500;
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  }

  // ==== 丝绸绘制 —— 四边形连续填充 + 法线高光 ====
  _drawSheet(s, sh) {
    if (sh.alpha <= 0.012) return;
    const cols = sh.cols, rows = sh.rows, idx = sh.idx;
    if (cols < 2 || rows < 2) return;

    const ctx = s.ctx;
    const pool = s.pool;
    const pal = sh.pal;
    const restArea = sh.restCellW * sh.restCellH;
    const block = sh.block;
    const useBlock = sh.blocksDirty === false && sh.type !== 'ribbon';

    if (sh.blocksDirty) this._computeBlocks(sh);

    ctx.globalAlpha = sh.alpha;

    const Lx = s.light.x, Ly = s.light.y, Lz = s.light.z;

    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const l00 = r * cols + c;
        const l10 = l00 + 1;
        const l01 = l00 + cols;
        const l11 = l01 + 1;

        const i00 = idx[l00], i10 = idx[l10], i01 = idx[l01], i11 = idx[l11];
        if (i00 < 0 || i10 < 0 || i01 < 0 || i11 < 0) continue;

        /* 撕裂后跳过跨块四边形 */
        if (useBlock) {
          const b = block[l00];
          if (block[l10] !== b || block[l01] !== b || block[l11] !== b) continue;
        }

        const p00 = pool[i00], p10 = pool[i10], p01 = pool[i01], p11 = pool[i11];

        const ax = p10.x - p00.x, ay = p10.y - p00.y;
        const bx = p01.x - p00.x, by = p01.y - p00.y;
        const area = ax * by - ay * bx;
        if (area < 0.4) continue;

        const ratio = area / restArea;
        const lenA = Math.sqrt(ax * ax + ay * ay) || 1;
        const lenB = Math.sqrt(bx * bx + by * by) || 1;
        const shear = (ax * bx + ay * by) / (lenA * lenB);

        /* 平均速度，让高光随流动漂移 */
        const avx = (p00.vx + p10.vx + p01.vx + p11.vx) * 0.25;
        const avy = (p00.vy + p10.vy + p01.vy + p11.vy) * 0.25;

        /* 伪法线（假三维：剪切 + 压缩/拉伸 + 速度倾斜） */
        let nx = shear * 1.9 + avx * 0.0018;
        let ny = (ratio - 1) * 1.7 + avy * 0.0018;
        let nz = 1.0;
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx /= nl; ny /= nl; nz /= nl;

        const dot = nx * Lx + ny * Ly + nz * Lz;
        const base = clamp(dot * 0.5 + 0.5, 0, 1);

        /* 拉伸变薄 → 整体变亮 */
        const thin = clamp((ratio - 0.85) * 0.55, -0.2, 0.42);
        const lum = clamp(base * 0.88 + thin + 0.1, 0, 1);

        /* 基础色 */
        let R, G, B;
        if (lum < 0.5) {
          const t = lum / 0.5;
          R = pal.dark[0] + (pal.sub[0] - pal.dark[0]) * t;
          G = pal.dark[1] + (pal.sub[1] - pal.dark[1]) * t;
          B = pal.dark[2] + (pal.sub[2] - pal.dark[2]) * t;
        } else {
          const t = (lum - 0.5) / 0.5;
          R = pal.sub[0] + (pal.main[0] - pal.sub[0]) * t;
          G = pal.sub[1] + (pal.main[1] - pal.sub[1]) * t;
          B = pal.sub[2] + (pal.main[2] - pal.sub[2]) * t;
        }

        /* 镜面高光 */
        const spec = clamp((lum - 0.70) / 0.30, 0, 1);
        const sa = spec * spec * 0.88;
        if (sa > 0.004) {
          R += (pal.hi[0] - R) * sa;
          G += (pal.hi[1] - G) * sa;
          B += (pal.hi[2] - B) * sa;
        }

        /* 应力染色（撕裂蓄力时偏品红） */
        if (sh.mode === 'charge-left' && sh.power > 0.05) {
          const st = sh.power * 0.3;
          R += (255 - R) * st;
          G += (79 - G) * st * 0.5;
          B += (216 - B) * st * 0.6;
        }

        ctx.fillStyle = rgbStr(s.colorCache, R, G, B);
        ctx.beginPath();
        ctx.moveTo(p00.x, p00.y);
        ctx.lineTo(p10.x, p10.y);
        ctx.lineTo(p11.x, p11.y);
        ctx.lineTo(p01.x, p01.y);
        ctx.closePath();
        ctx.fill();
      }
    }

    /* 边缘轮廓：外边界 1px 描边（绸面暗色） */
    if (sh.alpha > 0.2 && sh.type === 'main') {
      ctx.globalAlpha = sh.alpha * 0.55;
      ctx.strokeStyle = rgbStr(s.colorCache, pal.dark[0], pal.dark[1], pal.dark[2]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      let started = false;
      for (let c = 0; c < cols; c++) {
        const pi = idx[c];
        if (pi < 0) continue;
        const p = pool[pi];
        if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y);
      }
      for (let r = 1; r < rows; r++) {
        const pi = idx[r * cols + cols - 1];
        if (pi < 0) continue;
        const p = pool[pi];
        ctx.lineTo(p.x, p.y);
      }
      for (let c = cols - 2; c >= 0; c--) {
        const pi = idx[(rows - 1) * cols + c];
        if (pi < 0) continue;
        const p = pool[pi];
        ctx.lineTo(p.x, p.y);
      }
      for (let r = rows - 2; r >= 0; r--) {
        const pi = idx[r * cols];
        if (pi < 0) continue;
        const p = pool[pi];
        ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
  }

  // ==== 拖尾 —— 鼠标移动生成柔性丝带 ====
  // 原型在 mousemove 事件里触发；基类不暴露移动回调，这里按帧读取 input 的帧间位移，
  // 位移语义（上一事件位置 → 当前位置）与原型的 mouse.px/py 完全一致。
  _emitTrail(s) {
    const M = s.input;
    const dx = M.x - M.lx;
    const dy = M.y - M.ly;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= 0.5) return;

    /* 拖尾：快速移动时形成连续飘带 */
    const ldx = M.x - s.lastTrailX;
    const ldy = M.y - s.lastTrailY;
    const ld = Math.sqrt(ldx * ldx + ldy * ldy);
    if (ld >= CONFIG.trail.minDist && !s.left.charging && !s.right.charging) {
      s.lastTrailX = M.x;
      s.lastTrailY = M.y;
      this._spawnRibbon(s, M.x, M.y, ldx, ldy, ld);
    }
  }

  _spawnRibbon(s, x, y, dx, dy, spd) {
    if (s.sheets.length >= CONFIG.trail.maxSheets) return;
    if (s.freeStack.length < 12) return;

    const t = CONFIG.trail;
    const sh = new Sheet('ribbon', t.cols, t.rows, 'cold');
    if (!this._initGrid(s, sh, x, y, t.cellW, t.cellH, { spread: 8, k: 420, ks: 260 })) {
      this._destroySheet(s, sh);
      return;
    }

    const sp = Math.min(spd * 14, 280);
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = dx / d, ny = dy / d;

    for (let i = 0; i < sh.n; i++) {
      const p = s.pool[sh.idx[i]];
      if (!p) continue;
      p.vx = nx * sp + rand(-28, 28);
      p.vy = ny * sp + rand(-28, 28) - 24;
    }

    sh.life = rand(t.life[0], t.life[1]);
    sh.alpha = 0.95;
    sh.age = 0;
    s.sheets.push(sh);
  }

  // ==== 单击 —— 3×3 小丝绸 + 丝线 + 波纹 + 星芒 ====
  _doClick(s, x, y) {
    /* 3×3 小丝绸 */
    const c = CONFIG.click;
    this._ensureSpace(s, c.gridN * c.gridN + 24);
    if (s.freeStack.length >= c.gridN * c.gridN) {
      const sh = new Sheet('click', c.gridN, c.gridN, 'cold');
      if (this._initGrid(s, sh, x, y, c.cell, c.cell, { spread: 12, k: 700, ks: 420 })) {
        sh.life = 1.6;
        sh.alpha = 1;
        for (let i = 0; i < sh.n; i++) {
          const p = s.pool[sh.idx[i]];
          if (!p) continue;
          p.vx += rand(-60, 60);
          p.vy += rand(-60, 60);
        }
        s.sheets.push(sh);
      } else {
        this._destroySheet(s, sh);
      }
    }

    /* 飞散丝线 */
    const nThread = randInt(6, 10);
    for (let i = 0; i < nThread; i++) {
      const ang = Math.random() * TAU;
      this._spawnThread(s, x, y, Math.cos(ang), Math.sin(ang),
        rand(200, 400), rand(20, 50), CONFIG.cold.tear, 0.6);
    }
    /* 抖动丝线 */
    const nJit = randInt(8, 12);
    for (let i = 0; i < nJit; i++) {
      const ang = Math.random() * TAU;
      this._spawnThread(s, x, y, Math.cos(ang), Math.sin(ang),
        rand(140, 300), rand(30, 60), CONFIG.cold.thread, 0.4);
    }

    /* 波浪形波纹 + 星芒 */
    this._spawnRipple(s, x, y, CONFIG.cold.sub);
    this._spawnStar(s, x, y);

    /* 抖动传播：对场上所有布面/丝带施加延迟冲量 */
    this._applyRipple(s, x, y);
  }

  // ==== 抖动传播 / Ripple Propagation —— 本主题独有机制 ====
  // 波沿布面传播，距离越远越晚感受到抖动
  _applyRipple(s, x, y) {
    for (let i = 0; i < s.sheets.length; i++) {
      const sh = s.sheets[i];
      if (sh.dead) continue;
      sh.ripple = { x: x, y: y, t0: s.time, used: false };
    }
  }

  _updateSheetRipple(s, sh, dt) {
    const rp = sh.ripple;
    if (!rp) return;
    const t0 = rp.t0;
    const now = s.time;
    const speed = CONFIG.ripple.speed;
    const R = CONFIG.ripple;

    let any = false;
    for (let i = 0; i < sh.n; i++) {
      const pi = sh.idx[i];
      if (pi < 0) continue;
      const p = s.pool[pi];
      const dx = p.x - rp.x;
      const dy = p.y - rp.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const arrive = t0 + dist / speed;
      const age = now - arrive;
      if (age < 0 || age > R.life) continue;
      any = true;

      /* 垂直（切向）方向冲量 —— 布面上下起伏 */
      const inv = 1 / (dist || 1);
      const nx = -dy * inv;
      const ny = dx * inv;

      const decay = Math.exp(-age * 7) * (1 - age / R.life);
      const amp = R.strength * decay;
      /* 正弦振荡，形成真正的“抖动”而非位移 */
      const osc = Math.sin(age * 46) * amp;

      p.vx += nx * osc * dt * 6;
      p.vy += ny * osc * dt * 6;
    }
    if (!any) sh.ripple = null;
  }

  // ==== 左键蓄力 —— 展开丝绸 / 拉伸 / 撕裂 ====
  _beginLeftCharge(s, x, y) {
    const L = CONFIG.left;
    this._ensureSpace(s, L.cols * L.rows + 40);
    if (s.freeStack.length < L.cols * L.rows) return null;

    const sh = new Sheet('main', L.cols, L.rows, 'cold');
    const halfW = L.startHalfW;
    const halfH = L.startHalfH;
    const cellW = (halfW * 2) / (L.cols - 1);
    const cellH = (halfH * 2) / (L.rows - 1);

    if (!this._initGrid(s, sh, x, y, cellW, cellH, { spread: 10, k: 800, ks: 460 })) {
      this._destroySheet(s, sh);
      return null;
    }

    sh.mode = 'charge-left';
    sh.cx = x; sh.cy = y;
    sh.chargeT = 0;
    sh.power = 0;
    sh.life = Infinity;
    sh.alpha = 1;
    sh.invulnerable = true;
    s.sheets.push(sh);
    return sh;
  }

  _updateLeftCharge(s, sh, dt) {
    const L = CONFIG.left;
    sh.chargeT += dt;
    const t = clamp(sh.chargeT, 0, L.chargeTime);
    sh.power = Math.pow(t / L.chargeTime, 1.6);

    const power = sh.power;
    const cols = sh.cols, rows = sh.rows, idx = sh.idx;

    const halfW = lerp(L.startHalfW, L.endHalfW, power);
    const halfH = lerp(L.startHalfH, L.endHalfH, power);

    /* 微震（蓄力 > 55%） */
    const shake = power > 0.55 ? (power - 0.55) / 0.45 * 4.2 : 0;
    const sx = (Math.random() - 0.5) * shake;
    const sy = (Math.random() - 0.5) * shake;

    const cx = sh.cx, cy = sh.cy;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const pi = idx[r * cols + c];
        if (pi < 0) continue;
        const p = s.pool[pi];

        const u = (c / (cols - 1)) * 2 - 1;
        const v = (r / (rows - 1)) * 2 - 1;

        /* 腰部收窄：中间缩得最厉害 */
        const narrow = 1 - 0.28 * power * (1 - u * u);
        const tx = cx + u * halfW * narrow + sx;
        const ty = cy + v * halfH + sy;

        const k = clamp(dt * 9, 0, 0.55);
        p.x += (tx - p.x) * k;
        p.y += (ty - p.y) * k;
      }
    }

    /* 应变可视化：让弹簧原长慢慢跟随，避免爆炸 */
    const sRest = sh.sRest;
    const sA = sh.sA, sB = sh.sB, sAlive = sh.sAlive;
    for (let i = 0; i < sA.length; i++) {
      if (!sAlive[i]) continue;
      const pa = s.pool[idx[sA[i]]];
      const pb = s.pool[idx[sB[i]]];
      if (!pa || !pb) continue;
      const dx = pb.x - pa.x, dy = pb.y - pa.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      sRest[i] += (len - sRest[i]) * 0.04;
    }

    /* 蓄满后自动松手 */
    if (sh.chargeT >= L.chargeTime) {
      // 原型这里误用了未声明的 x / y（会抛 ReferenceError），
      // 与右键路径保持一致，改用当前光标位置作为爆发原点
      this._releaseLeft(s, sh, s.input.x, s.input.y);
      // 自动松手后断开引用（原型因上面的错误走不到这一步）：
      // 否则之后松开鼠标会对同一张已经爆发的布再爆发一次
      s.left.sheet = null;
    }
  }

  /* ---- 松开：撕裂爆发 ---- */
  _releaseLeft(s, sh, mx, my) {
    const L = CONFIG.left;
    const power = sh.power;

    /* 蓄力不足视为单击 */
    if (sh.chargeT < L.minCharge) {
      this._doClick(s, mx, my);
      sh.dead = true;
      return;
    }

    sh.mode = 'burst';
    sh.invulnerable = false;
    sh.alpha = 1;
    sh.life = 3.2;
    sh.age = 0;
    sh.ripple = null;

    const cols = sh.cols, rows = sh.rows, idx = sh.idx;

    /* 1. 静止一帧（速度归零） */
    for (let i = 0; i < sh.n; i++) {
      const pi = idx[i];
      if (pi < 0) continue;
      const p = s.pool[pi];
      p.vx = 0; p.vy = 0;
    }

    /* 2. 确定撕裂列（腰部附近，垂直于拉伸方向的裂缝） */
    const crackCount = 2 + Math.round(power * 2);
    const cracks = [];
    for (let k = 0; k < crackCount; k++) {
      const f = 0.22 + 0.56 * ((k + 0.5) / crackCount);
      let c = Math.round(f * (cols - 1));
      c = clamp(c, 1, cols - 2);
      if (cracks.indexOf(c) < 0) cracks.push(c);
    }

    /* 3. 主撕裂：断开裂缝处的水平弹簧 */
    const sA = sh.sA, sB = sh.sB, sAlive = sh.sAlive;
    for (let i = 0; i < sA.length; i++) {
      if (!sAlive[i]) continue;
      const a = sA[i], b = sB[i];
      const ca = a % cols, cb = b % cols;
      const ra = (a / cols) | 0, rb = (b / cols) | 0;
      if (ra === rb && Math.abs(ca - cb) === 1) {
        const cMin = Math.min(ca, cb);
        if (cracks.indexOf(cMin) >= 0) {
          sAlive[i] = 0;
          const pa = s.pool[idx[a]], pb = s.pool[idx[b]];
          if (pa && pb) {
            const mxp = (pa.x + pb.x) * 0.5;
            const myp = (pa.y + pb.y) * 0.5;
            for (let k = 0; k < 2; k++) {
              this._spawnThread(s, mxp, myp, pa.x - pb.x, pa.y - pb.y,
                rand(200, 500), rand(30, 70), CONFIG.cold.tear, rand(0.6, 1.0));
            }
          }
        }
      }
    }

    /* 4. 额外随机撕裂，加速碎片化 */
    const extraTears = Math.round(30 + 120 * power);
    for (let k = 0; k < extraTears; k++) {
      const i = randInt(0, sA.length - 1);
      if (!sAlive[i]) continue;
      sAlive[i] = 0;
      const pa = s.pool[idx[sA[i]]], pb = s.pool[idx[sB[i]]];
      if (pa && pb) {
        this._spawnThread(s, (pa.x + pb.x) * 0.5, (pa.y + pb.y) * 0.5,
          pa.x - pb.x, pa.y - pb.y, rand(150, 420), rand(24, 60),
          CONFIG.cold.tear, rand(0.5, 1.0));
      }
    }

    sh.blocksDirty = true;
    this._computeBlocks(sh);

    /* 5. 碎块飞出：沿各自相对光标中心的方向 */
    const burstSpeed = 300 + 800 * power;
    for (let i = 0; i < sh.n; i++) {
      const pi = idx[i];
      if (pi < 0) continue;
      const p = s.pool[pi];
      const dx = p.x - mx;
      const dy = p.y - my;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const sp = burstSpeed * rand(0.7, 1.15);
      p.vx += (dx / d) * sp;
      p.vy += (dy / d) * sp;
      p.vx += rand(-90, 90);
      p.vy += rand(-90, 90);
    }

    /* 6. 丝线风暴 */
    const stormN = Math.round(60 + 200 * power);
    for (let i = 0; i < stormN; i++) {
      const ang = Math.random() * TAU;
      const spd = rand(400, 800);
      this._spawnThread(s, mx + Math.cos(ang) * rand(0, 40), my + Math.sin(ang) * rand(0, 40),
        Math.cos(ang), Math.sin(ang), spd, rand(30, 80),
        CONFIG.cold.tear, 1.0);
    }

    /* 7. 丝绸碎片环：24~40 个小碎布片环形排列 */
    const ringCount = Math.round(24 + 16 * power);
    const maxR = 150 + 400 * power;
    this._spawnFragmentRing(s, mx, my, ringCount, maxR, power);

    /* 8. 抖动传播：场上拖尾被震散 */
    this._applyRipple(s, mx, my);

    /* 9. 短寿命高光闪点 */
    this._spawnStar(s, mx, my);
    this._spawnRipple(s, mx, my, CONFIG.cold.tear);
  }

  /* 碎片环 */
  _spawnFragmentRing(s, cx, cy, count, maxR, power) {
    const perSheet = 4;           // 每块碎布 2×2
    const need = count * perSheet;
    this._ensureSpace(s, need);

    for (let i = 0; i < count; i++) {
      if (s.freeStack.length < perSheet) break;
      const ang = (i / count) * TAU + rand(-0.1, 0.1);
      const r = rand(6, 20);
      const x = cx + Math.cos(ang) * r;
      const y = cy + Math.sin(ang) * r;

      const sh = new Sheet('frag', 2, 2, 'cold');
      if (!this._initGrid(s, sh, x, y, rand(8, 14), rand(8, 14), { spread: 6, k: 600, ks: 340 })) {
        this._destroySheet(s, sh);
        continue;
      }
      const sp = maxR / 0.9 * rand(0.85, 1.2);
      for (let j = 0; j < sh.n; j++) {
        const p = s.pool[sh.idx[j]];
        if (!p) continue;
        p.vx = Math.cos(ang) * sp + rand(-60, 60);
        p.vy = Math.sin(ang) * sp + rand(-60, 60);
      }
      sh.life = 0.8;
      sh.alpha = 1;
      s.sheets.push(sh);
    }
  }

  // ==== 右键蓄力 —— 折叠褶皱 ====
  _beginRightCharge(s, x, y) {
    const R = CONFIG.right;
    this._ensureSpace(s, R.cols * R.rows + 40);
    if (s.freeStack.length < R.cols * R.rows) return null;

    const sh = new Sheet('main', R.cols, R.rows, 'warm');
    const cellW = R.initW / (R.cols - 1);
    const cellH = R.initH / (R.rows - 1);

    if (!this._initGrid(s, sh, x, y, cellW, cellH, { spread: 10, k: 850, ks: 480 })) {
      this._destroySheet(s, sh);
      return null;
    }

    sh.mode = 'charge-right';
    sh.cx = x; sh.cy = y;
    sh.chargeT = 0;
    sh.power = 0;
    sh.wavePhase = 0;
    sh.waveDir = Math.random() < 0.5 ? 1 : -1;
    sh.life = Infinity;
    sh.alpha = 1;
    sh.invulnerable = true;
    s.sheets.push(sh);
    return sh;
  }

  _updateRightCharge(s, sh, dt) {
    const R = CONFIG.right;
    sh.chargeT += dt;
    const t = clamp(sh.chargeT, 0, R.chargeTime);
    sh.power = Math.pow(t / R.chargeTime, 1.6);

    const power = sh.power;
    const cols = sh.cols, rows = sh.rows, idx = sh.idx;

    /* 褶皱波传播：相位随时间移动 */
    const waveSpeed = lerp(3.0, 14.0, power);
    sh.wavePhase += waveSpeed * dt * sh.waveDir;

    /* 微震 */
    const shake = power > 0.55 ? (power - 0.55) / 0.45 * 3.4 : 0;
    const sx = (Math.random() - 0.5) * shake * 1.6;
    const sy = (Math.random() - 0.5) * shake * 0.5;

    const cx = sh.cx, cy = sh.cy;
    const curW = lerp(R.initW, R.minW, power);
    const curH = R.initH * lerp(1, 0.92, power);

    const folds = lerp(R.foldMin, R.foldMax, power);
    const amp = lerp(R.ampMin, R.ampMax, power);
    const secondT = power > 0.55 ? (power - 0.55) / 0.45 : 0;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const pi = idx[r * cols + c];
        if (pi < 0) continue;
        const p = s.pool[pi];

        const u = c / (cols - 1);       // 0..1
        const v = r / (rows - 1);       // 0..1

        /* 主褶皱：正弦波沿横向分布，相位随时间移动 */
        const ph = u * folds * TAU + sh.wavePhase;
        let wob = Math.sin(ph) * amp;

        /* 二级褶皱（蓄力极限时） */
        if (secondT > 0) {
          wob += Math.sin(ph * 2.6 + 1.3) * amp * 0.34 * secondT;
          wob += Math.sin(ph * 4.1 - 0.7) * amp * 0.16 * secondT;
        }

        /* 上下边缘也波动 */
        const edgeWave = Math.sin(ph * 0.9) * amp * 0.18;

        const tx = cx + (u - 0.5) * curW + wob + sx;
        const ty = cy + (v - 0.5) * curH + edgeWave * (Math.abs(v - 0.5) * 2) + sy;

        const k = clamp(dt * 11, 0, 0.6);
        p.x += (tx - p.x) * k;
        p.y += (ty - p.y) * k;

        /* 速度同步，保证松开时物理平滑接管 */
        p.vx *= 0.85;
        p.vy *= 0.85;
      }
    }

    /* 原长跟随，避免力爆炸 */
    const sRest = sh.sRest, sA = sh.sA, sB = sh.sB, sAlive = sh.sAlive;
    for (let i = 0; i < sA.length; i++) {
      if (!sAlive[i]) continue;
      const pa = s.pool[idx[sA[i]]];
      const pb = s.pool[idx[sB[i]]];
      if (!pa || !pb) continue;
      const dx = pb.x - pa.x, dy = pb.y - pa.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      sRest[i] += (len - sRest[i]) * 0.05;
    }

    if (sh.chargeT >= R.chargeTime) {
      this._releaseRight(s, sh, s.input.x, s.input.y);
      // 同上：自动松手后断开引用，避免松开时二次爆发
      s.right.sheet = null;
    }
  }

  /* ---- 松开：展开爆发 ---- */
  _releaseRight(s, sh, mx, my) {
    const R = CONFIG.right;
    const power = sh.power;

    if (sh.chargeT < R.minCharge) {
      this._doClick(s, mx, my);
      sh.dead = true;
      return;
    }

    sh.mode = 'burst';
    sh.invulnerable = false;
    sh.alpha = 1;
    sh.life = 3.4;
    sh.age = 0;
    sh.ripple = null;

    const cols = sh.cols, rows = sh.rows, idx = sh.idx;

    /* 1. 静止一帧 */
    for (let i = 0; i < sh.n; i++) {
      const pi = idx[i];
      if (pi < 0) continue;
      const p = s.pool[pi];
      p.vx = 0; p.vy = 0;
    }

    /* 2. 瞬间展开：向外巨大速度 */
    const burst = 300 + 800 * power;
    for (let i = 0; i < sh.n; i++) {
      const pi = idx[i];
      if (pi < 0) continue;
      const p = s.pool[pi];
      const u = (p.ic / (cols - 1)) - 0.5;
      const v = (p.ir / (rows - 1)) - 0.5;

      p.vx += u * 2 * burst;
      p.vy += v * 2 * burst * 0.35;
      p.vx += rand(-70, 70);
      p.vy += rand(-70, 70);
    }

    /* 3. 甩出丝线：从左右边缘沿切线飞出 */
    const edgeThreads = Math.round(20 + 60 * power);
    for (let i = 0; i < edgeThreads; i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const ri = randInt(0, rows - 1);
      const ci = side < 0 ? 0 : cols - 1;
      const pi = idx[ri * cols + ci];
      if (pi < 0) continue;
      const p = s.pool[pi];
      const ang = side < 0 ? Math.PI + rand(-0.7, 0.7) : rand(-0.7, 0.7);
      this._spawnThread(s, p.x, p.y, Math.cos(ang), Math.sin(ang),
        rand(300, 600), rand(30, 100), CONFIG.warm.thread, rand(0.6, 1.0));
    }

    /* 4. 自然分裂成 5~10 块大布片 */
    const sA = sh.sA, sB = sh.sB, sAlive = sh.sAlive;
    const breakCount = randInt(5, 10) * 4;
    for (let k = 0; k < breakCount; k++) {
      const i = randInt(0, sA.length - 1);
      if (!sAlive[i]) continue;
      sAlive[i] = 0;
      const pa = s.pool[idx[sA[i]]], pb = s.pool[idx[sB[i]]];
      if (pa && pb) {
        this._spawnThread(s, (pa.x + pb.x) * 0.5, (pa.y + pb.y) * 0.5,
          pa.x - pb.x, pa.y - pb.y, rand(120, 360), rand(30, 80),
          CONFIG.warm.thread, rand(0.5, 0.9));
      }
    }

    /* 边缘快速拉伸造成的断裂 */
    for (let i = 0; i < sA.length; i++) {
      if (!sAlive[i]) continue;
      if (Math.random() < 0.06) {
        sAlive[i] = 0;
        const pa = s.pool[idx[sA[i]]], pb = s.pool[idx[sB[i]]];
        if (pa && pb) {
          this._spawnThread(s, (pa.x + pb.x) * 0.5, (pa.y + pb.y) * 0.5,
            pa.x - pb.x, pa.y - pb.y, rand(150, 400), rand(30, 90),
            CONFIG.warm.thread, rand(0.5, 0.9));
        }
      }
    }

    sh.blocksDirty = true;
    this._computeBlocks(sh);

    /* 5. 抖动传播 */
    this._applyRipple(s, mx, my);

    /* 6. 金色高光扫过 */
    this._spawnStar(s, mx, my);
    this._spawnRipple(s, mx, my, CONFIG.warm.hi);
  }

  // ==== 布面生命周期 ====
  _updateSheetLife(sh, dt) {
    if (sh.life === Infinity) return;
    sh.age += dt;
    if (sh.age >= sh.life) {
      sh.dead = true;
      return;
    }
    const fadeStart = sh.life * 0.55;
    if (sh.age > fadeStart) {
      sh.alpha = 1 - (sh.age - fadeStart) / (sh.life - fadeStart);
      if (sh.alpha < 0) sh.alpha = 0;
    }
  }

  // ==== 鼠标按键 ====
  // 原型在 mousedown 里拦截了默认行为，基类的监听器约定为只读，这里不再拦截
  onPointerDown(e) {
    const s = this.state;
    if (!s) return;

    if (e.button === 0) {
      if (s.right.charging) return;
      s.left.downT = s.time;

      if (!s.left.charging) {
        s.left.charging = true;
        s.left.sheet = this._beginLeftCharge(s, e.clientX, e.clientY);
        /* 按下瞬间的单击特效 */
        this._doClick(s, e.clientX, e.clientY);
      }
    } else if (e.button === 2) {
      if (s.left.charging) return;
      s.right.downT = s.time;

      if (!s.right.charging) {
        s.right.charging = true;
        s.right.sheet = this._beginRightCharge(s, e.clientX, e.clientY);
        this._doClick(s, e.clientX, e.clientY);
      }
    }
  }

  onPointerUp(e) {
    const s = this.state;
    if (!s) return;

    if (e.button === 0) {
      if (s.left.charging) {
        s.left.charging = false;
        const sh = s.left.sheet;
        if (sh && !sh.dead) {
          const held = s.time - s.left.downT;
          if (held < CONFIG.left.minCharge) {
            /* 普通单击 */
            sh.dead = true;
            s.left.sheet = null;
          } else {
            this._releaseLeft(s, sh, e.clientX, e.clientY);
            s.left.sheet = null;
          }
        }
      }
    } else if (e.button === 2) {
      if (s.right.charging) {
        s.right.charging = false;
        const sh = s.right.sheet;
        if (sh && !sh.dead) {
          const held = s.time - s.right.downT;
          if (held < CONFIG.right.minCharge) {
            sh.dead = true;
            s.right.sheet = null;
          } else {
            this._releaseRight(s, sh, e.clientX, e.clientY);
            s.right.sheet = null;
          }
        }
      }
    }
  }

  /* 失焦时清理蓄力状态 */
  onBlur() {
    const s = this.state;
    if (!s) return;

    if (s.left.sheet && !s.left.sheet.dead) s.left.sheet.dead = true;
    if (s.right.sheet && !s.right.sheet.dead) s.right.sheet.dead = true;
    s.left.sheet = null;
    s.right.sheet = null;
    s.left.charging = false;
    s.right.charging = false;
  }

  // ==== 尺寸 ====
  // 原型 resize() 里「同步 W/H 到动效状态」的部分搬到这里；画布缓冲由基类维护
  onResize(width, height) {
    const s = this.state;
    if (!s) return;
    s.W = width;
    s.H = height;
  }

  // ==== 更新 ====
  update(dt, s) {
    if (!s) return;

    // 与原型一致：单帧最大步长 1/30，防炸
    if (dt > CONFIG.sim.maxDt) dt = CONFIG.sim.maxDt;
    if (dt <= 0) return;

    s.time += dt;

    this._updateWind(s, dt);
    this._updateLight(s, dt);
    this._updateThreads(s, dt);
    this._updateDecals(s, dt);

    // 拖尾生成（原型挂在 mousemove 上，这里按帧驱动）
    this._emitTrail(s);

    /* 冻结帧（松开瞬间的凝固）：原型中 freezeTimer 从未被置为正值，此分支恒不进入 */
    if (s.freezeTimer > 0) {
      s.freezeTimer -= dt;
      /* 冻结期间仍然推进生命周期，但不做物理 */
      for (let i = 0; i < s.sheets.length; i++) {
        const sh = s.sheets[i];
        if (!sh.dead) this._updateSheetLife(sh, dt);
      }
      return;
    }

    /* 更新所有布面 */
    for (let i = 0; i < s.sheets.length; i++) {
      const sh = s.sheets[i];
      if (sh.dead) continue;

      this._updateSheetLife(sh, dt);
      if (sh.dead) continue;

      this._updateSheetRipple(s, sh, dt);

      if (sh.mode === 'charge-left') {
        this._updateLeftCharge(s, sh, dt);
      } else if (sh.mode === 'charge-right') {
        this._updateRightCharge(s, sh, dt);
      }

      if (sh.dead) continue;

      this._simulateSheet(s, sh, dt);
    }

    /* 清理死亡布面 */
    for (let i = s.sheets.length - 1; i >= 0; i--) {
      if (s.sheets[i].dead) {
        this._destroySheet(s, s.sheets[i]);
        s.sheets.splice(i, 1);
      }
    }
  }

  // ==== 渲染 ====
  render(s) {
    if (!s) return;
    const ctx = s.ctx;

    // 画布缓冲与 DPR 缩放由基类维护，这里统一使用 CSS 像素坐标
    // 只做清屏，不铺任何底色：光标层必须透明
    ctx.clearRect(0, 0, s.W, s.H);

    for (let i = 0; i < s.sheets.length; i++) {
      const sh = s.sheets[i];
      if (!sh.dead) this._drawSheet(s, sh);
    }

    this._drawThreads(s);
    this._drawRipples(s);
    this._drawStars(s);

    ctx.globalAlpha = 1;
  }
}

if (!customElements.get('cursor-silk')) {
  customElements.define('cursor-silk', CursorSilk);
}

export default CursorSilk;
