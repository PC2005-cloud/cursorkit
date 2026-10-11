/**
 * cursor-lightning —— 鼠标光标电离放电动效（左键云地闪 / 右键球状闪电）。
 *
 * 由 html/闪电.html 原型移植：算法流程、数值、视觉表现与原文件一一对应。
 * 作为光标层组件，原型页面自身的行为已剔除：
 *   - 原型 render() 开头铺了一层 #05060a 整屏底色（第 1492~1493 行的 fillStyle + fillRect）
 *     来承载页面背景；移植后基类的 canvas 是透明的，render() 改为 clearRect，绝不覆盖宿主页面；
 *   - 原型在右键菜单上阻止默认行为，改由基类统一处理（保留 Shift/Ctrl 右键的逃生出口）；
 *   - 画布创建、DPR 适配（封顶 2）、尺寸同步、监听注册、rAF 循环、dt 钳制
 *     全部由基类负责。
 *
 * 原型监听 mousemove / mousedown / mouseup，因此声明 inputFamily = 'mouse'。
 *
 * 锚点口径（事件级）：原型第 1377~1378 行在 mousemove 回调内推进锚点（mouse.px = mouse.x），
 * 全文没有帧级推进（mouse.px 只在第 1370 行首次对齐、第 1377 行事件内推进两处），
 * 因此取用基类的 input.lx / ly（上一次移动事件的位置），不用 frameLx / frameLy。
 *
 * 速度口径：原型全程**不使用速度** —— 既没有 dx / dt 的逐帧速度，也没有速度阈值与钳制；
 * 它只用「逐事件位移距离 dist」以及它的 EMA（smoothSpeed，第 1383 行）。
 * 基类平滑后的 input.vx / vy / speed 在本动效中一次都没有用到。
 *
 * 与原型的差异（详见交付回报）：
 *   1. 删掉 render() 开头的整屏铺底（第 1492~1493 行的 fillStyle + fillRect），改为 clearRect；
 *   2. 原型第 1414 行引用了未定义的 CONFIG.shortArcInterval，慢速移动时抛 TypeError、
 *      短电弧完全失效；这里按快速分支 0.08 的节奏外推补了一组区间（见 CONFIG 末尾）；
 *   3. 原型第 1404 行引用了未定义的 CONFIG.trailSparkGravity，经 spawnSpark 的 grav||0
 *      兜底后实为 0；这里显式补 0，运行效果与原文件一致；
 *   4. mousemove 回调里的生成逻辑改为每帧执行一次（基类只暴露每帧输入），
 *      smoothSpeed 与 shortArcTimer 因此按「帧」而不是按「事件」推进；
 *      初始光标位置取视口中心（原型是 -1000，靠首次 mousemove 对齐），
 *      首次移动只做对齐、不生成任何东西（对应原型第 1368~1371 行的对齐，dist 恒为 0）；
 *   5. 原型只写不读的死字段 mouse.px / py / speed 未移植；CONFIG 里未被引用的键
 *      （segMin / segMax / returnAlpha、L.ion / L.spark、R.core / R.mid / R.outer /
 *      R.sparkA / R.sparkB）按「数值原样保留」全部保留。
 *
 * 所有运行状态都放在 setup() 返回的 state 上，多实例互不干扰。
 */

import { CursorEffectElement } from '../core/base.js';
import { TAU, clamp, lerp, rand, randInt } from '../core/utils.js';

/* =========================================================
   0. 全局配置（CONFIG）
   ========================================================= */
const CONFIG = {
  /* —— 左键（云地闪）冷白蓝组 —— */
  L: {
    leader: '#3A4A6A',   // 先导（暗蓝灰）
    core:   '#FFFFFF',   // 回击核心（炽白）
    mid:    '#A8D8FF',   // 回击外圈（冰蓝）
    branch: '#4FE3FF',   // 分叉末端（青）
    ion:    '#6A8AC0',   // 电离通道残影（灰蓝）
    spark:  '#FFD24A'    // 地面电火花（暖金）
  },

  /* —— 右键（球状闪电）暖紫红组 —— */
  R: {
    core:   '#FFD24A',   // 球体核心（金黄）
    mid:    '#FF6B1A',   // 球体中层（橙红）
    outer:  '#8A5CFF',   // 球体外层（电紫）
    glow:   '#FF4FD8',   // 球体辉光（品红）
    arc:    '#FFFFFF',   // 内部电弧（炽白）
    sparkA: '#FFD24A',   // 爆裂火花（金）
    sparkB: '#FF4FD8'    // 爆裂火花（品红）
  },

  /* —— 亮度 —— */
  leaderAlpha: 0.34,     // 先导亮度（暗）
  returnAlpha: 1.0,      // 回击亮度（亮）

  /* —— 折线参数 —— */
  jitterAmp: 40,         // 折线横向抖动幅度（px）
  segMin: 8,             // 折线最少段数
  segMax: 25,            // 折线最多段数
  branchChance: 0.30,    // 主电弧节点分叉概率
  branchChance2: 0.20,   // 次级节点分叉概率
  branchDepthMax: 2,     // 分叉递归深度上限

  /* —— 时序（秒） —— */
  leaderTime:  [0.08, 0.12], // 先导延伸时长
  returnTime:  [0.04, 0.06], // 回击返回时长
  phaseGap:    0.06,         // 先导 → 回击之间的延迟
  flickerTime: 0.20,         // 回击后闪频持续
  ionLife:     [1.0, 2.0],   // 电离通道残影寿命

  /* —— 蓄力 —— */
  chargeMax:  2.5,       // 蓄力上限（秒）
  minCharge:  0.12,      // 低于此值视为普通单击

  /* —— 容量 —— */
  maxArcs:   200,        // 电弧对象上限
  maxSparks: 1500,       // 火花对象上限
  maxGlows:  1400,       // 软光斑上限

  /* —— 原型漏定义的两项：引用悬空，见文件头「与原型的差异」 —— */
  trailSparkGravity: 0,           // 第 1404 行：undefined 经 grav||0 兜底后实为 0，显式补 0 保持原有效果
  shortArcInterval: [0.14, 0.28]  // 第 1414 行：CONFIG.shortArcInterval[0] 会抛 TypeError，按快速分支 0.08 的节奏外推补一组区间
};

/* =========================================================
   1. 离屏纹理预渲染（软光斑）
   ========================================================= */
// 原型用全局 document 预渲染 7 张径向渐变贴图；移植后改用元素自身的
// ownerDocument 创建：不触碰任何全局对象，每个实例各自持有一份，且绝不挂进 DOM。
// 这里的 cv.width / getContext 只作用于离屏贴图画布，与主画布无关。
function makeGlowTex(doc, r, g, b) {
  const S = 64;
  const cv = doc.createElement('canvas');
  cv.width = cv.height = S;
  const c2 = cv.getContext('2d');
  const grd = c2.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0.00, `rgba(${r},${g},${b},1)`);
  grd.addColorStop(0.22, `rgba(${r},${g},${b},0.52)`);
  grd.addColorStop(0.52, `rgba(${r},${g},${b},0.16)`);
  grd.addColorStop(1.00, `rgba(${r},${g},${b},0)`);
  c2.fillStyle = grd;
  // 贴图自身的整块填充：它落在离屏画布上，不是视口铺底，必须保留
  c2.fillRect(0, 0, S, S);
  return cv;
}

function buildTextures(doc) {
  return {
    white:   makeGlowTex(doc, 255, 255, 255),
    ice:     makeGlowTex(doc, 168, 216, 255),
    ion:     makeGlowTex(doc, 106, 138, 192),
    gold:    makeGlowTex(doc, 255, 210, 74),
    orange:  makeGlowTex(doc, 255, 107, 26),
    magenta: makeGlowTex(doc, 255, 79, 216),
    purple:  makeGlowTex(doc, 138, 92, 255)
  };
}

/* =========================================================
   2. 折线路径生成（闪电不走直线）
   ========================================================= */
function genPath(x1, y1, x2, y2, segs, jitter) {
  const pts = [];
  const dx = x2 - x1, dy = y2 - y1;
  const dist = Math.hypot(dx, dy) || 1;
  const nx = -dy / dist, ny = dx / dist;      // 主方向的垂直方向
  const j = Math.min(jitter, dist * 0.65);    // 抖动不超过路径长度
  pts.push({ x: x1, y: y1 });
  for (let i = 1; i < segs; i++) {
    const t = i / segs;
    const env = Math.sin(Math.PI * t);        // 两端收敛，中间抖动大
    const off = (Math.random() - 0.5) * j * env * 2;
    pts.push({
      x: x1 + dx * t + nx * off,
      y: y1 + dy * t + ny * off
    });
  }
  pts.push({ x: x2, y: y2 });
  return pts;
}

function pathLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) {
    L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return L;
}

/* =========================================================
   3. 等离子球内部电弧（只改写传入的对象，无实例状态）
   ========================================================= */
function regenInnerArc(ia, r) {
  const n = randInt(2, 3);
  const a0 = Math.random() * TAU;
  const rr = Math.random() * r * 0.7;
  let x = Math.cos(a0) * rr;
  let y = Math.sin(a0) * rr;
  const pts = [{ x, y }];
  let ang = Math.random() * TAU;
  const len = rand(5, 15);
  const step = len / n;
  for (let i = 0; i < n; i++) {
    ang += (Math.random() - 0.5) * 1.7;
    x += Math.cos(ang) * step;
    y += Math.sin(ang) * step;
    pts.push({ x, y });
  }
  ia.pts = pts;
  ia.alpha = rand(0.55, 1.0);
  ia.timer = rand(0.1, 0.2);
}

export class CursorLightning extends CursorEffectElement {
  /** 主题光标：亮黄描边 + 电弧装饰 */
  cursorTheme() {
    return {
      edge: '#ffe066',
      fill: 'rgba(35, 29, 5, .88)',
      glow: '#ffe066',
      deco: { color: [255, 232, 120], style: 'arc', rate: 20, speedGain: 0.3 }
    };
  }

  // 原型用的是 mousemove / mousedown / mouseup（不是 pointer 事件族），
  // 不声明这一行，基类会去监听 pointermove，动效将完全收不到鼠标输入。
  inputFamily = 'mouse';

  /* =========================================================
     初始化
     ========================================================= */
  // 只建池与状态，不注册任何监听（监听、DPR 缩放、rAF 全归基类）
  setup({ canvas, ctx, width, height, input }) {
    // 与其它动效一致：初始光标位置取视口中心。
    // 原型的光标初始在 (-1000, -1000)，首次 mousemove 时先对齐再按 dist = 0 直接返回；
    // 这里用「中心 + mouseInit 门」复现同一语义，避免首帧从左上角拉出一条长拖尾。
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
      tex: buildTextures(canvas.ownerDocument),

      // 全局时间（原型的 time）
      time: 0,

      // 原型 mouse.x === -1000 的对齐门：首次移动只对齐，不生成任何东西
      mouseInit: false,

      // 拖尾光点（电弧跳跃目标）
      trailPoints: [],

      // 位移累加器 / 短电弧计时 / 平滑位移距离（原型 moveAccum / shortArcTimer / smoothSpeed）
      moveAccum: 0,
      shortArcTimer: 0,
      smoothSpeed: 0,

      // 电弧池
      arcs: [],
      arcPool: [],

      // 火花池
      sparks: [],
      sparkPool: [],

      // 软光斑 / 电离环 / 环形电弧
      glows: [],
      rings: [],
      ringArcs: [],

      // 延迟调度队列 { t, fn }
      timers: [],

      // 蓄力状态（左键云层 / 右键等离子球）
      charge: {
        active: false,
        button: -1,
        t: 0,
        cloudX: 0, cloudY: 0, cloudR: 30, cloudAlpha: 0.15,
        nextIntra: 0,
        nextProbe: 0,
        nextOut: 0,
        ball: null
      }
    };
  }

  /* =========================================================
     贴图绘制 / 延迟调度器
     ========================================================= */
  _drawTex(s, tex, x, y, radius, alpha) {
    if (alpha <= 0.004 || radius <= 0.3) return;
    s.ctx.globalAlpha = alpha;
    s.ctx.drawImage(tex, x - radius, y - radius, radius * 2, radius * 2);
  }

  _later(s, delay, fn) {
    s.timers.push({ t: delay, fn: fn });
  }

  _updateTimers(s, dt) {
    const timers = s.timers;
    for (let i = timers.length - 1; i >= 0; i--) {
      const tm = timers[i];
      tm.t -= dt;
      if (tm.t <= 0) {
        timers.splice(i, 1);
        tm.fn();
      }
    }
  }

  /* =========================================================
     电弧系统
     ========================================================= */
  _obtainArc(s) { return s.arcPool.length ? s.arcPool.pop() : {}; }

  _freeArc(s, a) { if (s.arcPool.length < 300) s.arcPool.push(a); }

  /**
   * 生成一条电弧。
   * mode: 'leader'（暗先导，单层）/ 'full'（回击，三层描边）/ 'short'（短电弧，两层）
   * reverse: true 时从终点向起点延伸（回击）
   * 池对象的 13 个字段每次生成都会写全（与原型一致），不会带出上一位使用者的脏值。
   */
  _spawnArc(s, pts, o) {
    if (!pts || pts.length < 2) return null;
    if (s.arcs.length >= CONFIG.maxArcs) return null;

    const a = this._obtainArc(s);
    a.pts = pts;
    a.n = pts.length - 1;
    a.t = 0;
    a.delay = o.delay || 0;
    a.dur = o.dur || 0.1;
    a.flicker = o.flicker || 0;
    a.life = a.delay + a.dur + a.flicker;
    a.reverse = !!o.reverse;
    a.mode = o.mode || 'full';
    a.w0 = o.w0 != null ? o.w0 : 3;
    a.w1 = o.w1 != null ? o.w1 : 1;
    a.alpha = o.alpha != null ? o.alpha : 1;
    a.colCore = o.colCore || '#FFFFFF';
    a.colMid  = o.colMid  || '#A8D8FF';
    a.colGlow = o.colGlow || '#A8D8FF';
    s.arcs.push(a);
    return a;
  }

  _updateArcs(s, dt) {
    for (let i = s.arcs.length - 1; i >= 0; i--) {
      const a = s.arcs[i];
      a.t += dt;
      if (a.t >= a.life) {
        s.arcs.splice(i, 1);
        this._freeArc(s, a);
      }
    }
  }

  _strokeSub(s, pts, i0, i1, w, color, alpha) {
    if (i1 <= i0) return;
    const ctx = s.ctx;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(pts[i0].x, pts[i0].y);
    for (let k = i0 + 1; k <= i1; k++) ctx.lineTo(pts[k].x, pts[k].y);
    ctx.stroke();
  }

  _drawArcs(s) {
    for (let i = 0; i < s.arcs.length; i++) {
      const a = s.arcs[i];
      const local = a.t - a.delay;
      if (local < 0) continue;

      const n = a.n;
      let p = local / a.dur;
      if (p > 1) p = 1;

      /* —— 闪频阶段 —— */
      let flick = 1;
      if (a.flicker > 0 && local > a.dur) {
        const ft = clamp((local - a.dur) / a.flicker, 0, 1);
        const seq = [1.0, 0.3, 1.0, 0.5, 0.8];
        const idx = Math.min(seq.length - 1, Math.floor(ft * seq.length));
        flick = seq[idx] * (1 - ft * 0.75);
      }

      const drawn = Math.max(1, Math.ceil(n * p));
      let start, end;
      if (a.reverse) {
        start = n - drawn;
        end = n;
      } else {
        start = 0;
        end = drawn;
      }

      /* —— 粗细：沿路径渐变（根部粗 / 尖端细） —— */
      const midIdx = (start + end) * 0.5;
      const frac = midIdx / n;
      const w = a.w0 + (a.w1 - a.w0) * frac;

      if (a.mode === 'leader') {
        /* 先导：单层暗描边 */
        this._strokeSub(s, a.pts, start, end, a.w0, a.colCore, CONFIG.leaderAlpha * a.alpha);
      } else if (a.mode === 'short') {
        /* 短电弧：双层 */
        this._strokeSub(s, a.pts, start, end, Math.max(2, w * 2.4), a.colMid, 0.35 * a.alpha * flick);
        this._strokeSub(s, a.pts, start, end, Math.max(1, w * 0.9), a.colCore, 0.9 * a.alpha * flick);
      } else {
        /* 回击：三层描边（外层辉光 / 中层冰蓝 / 内层炽白） */
        this._strokeSub(s, a.pts, start, end, w * 3.4, a.colGlow, 0.20 * a.alpha * flick);
        this._strokeSub(s, a.pts, start, end, w * 1.8, a.colMid,  0.60 * a.alpha * flick);
        this._strokeSub(s, a.pts, start, end, Math.max(0.9, w * 0.7), a.colCore, 1.00 * a.alpha * flick);
      }
    }
  }

  /* —— 分叉递归 —— */
  _spawnBranches(s, pts, depth, opt) {
    if (depth > CONFIG.branchDepthMax) return;
    if (pts.length < 3) return;
    if (s.arcs.length > CONFIG.maxArcs * 0.75) return;

    const chance = depth === 0 ? CONFIG.branchChance : CONFIG.branchChance2;
    const total = pathLength(pts);

    for (let i = 1; i < pts.length - 1; i++) {
      if (Math.random() > chance) continue;

      const p  = pts[i];
      const pr = pts[i - 1];
      const nx = pts[i + 1];
      const ang = Math.atan2(nx.y - pr.y, nx.x - pr.x);
      const side = Math.random() < 0.5 ? 1 : -1;
      const bAng = ang + side * rand(0.35, 1.15);

      const blen = clamp(total * rand(0.30, 0.60), 14, 260);
      const bx = p.x + Math.cos(bAng) * blen;
      const by = p.y + Math.sin(bAng) * blen;

      const bsegs = clamp(Math.round(blen / 18), 3, 12);
      const bpts = genPath(p.x, p.y, bx, by, bsegs, CONFIG.jitterAmp * 0.55);

      const ld = opt.leaderDur * 0.8;
      const baseDelay = opt.delay || 0;

      /* 分叉先导（暗） */
      this._spawnArc(s, bpts, {
        mode: 'leader',
        dur: ld,
        w0: 1.1,
        colCore: CONFIG.L.leader,
        delay: baseDelay + 0.012 * (depth + 1),
        alpha: 0.85
      });

      /* 分叉回击（亮，延迟略长，亮度略低） */
      this._spawnArc(s, bpts, {
        mode: 'full',
        dur: opt.returnDur,
        delay: baseDelay + ld + CONFIG.phaseGap + 0.02,
        reverse: true,
        w0: 0.55,
        w1: 2.0,
        colCore: '#FFFFFF',
        colMid: CONFIG.L.branch,
        colGlow: CONFIG.L.branch,
        alpha: 0.78,
        flicker: 0.08
      });

      this._spawnBranches(s, bpts, depth + 1, opt);
    }
  }

  /* =========================================================
     火花池
     ========================================================= */
  _spawnSpark(s, x, y, vx, vy, life, size, kind, grav, canSplit) {
    if (s.sparks.length >= CONFIG.maxSparks) return;
    const sp = s.sparkPool.length ? s.sparkPool.pop() : {};
    sp.x = x; sp.y = y;
    sp.vx = vx; sp.vy = vy;
    sp.t = 0;
    sp.life = life;
    sp.size = size;
    sp.kind = kind || 'cool';
    sp.grav = grav || 0;
    sp.canSplit = !!canSplit;
    sp.splitDone = false;
    s.sparks.push(sp);
  }

  _updateSparks(s, dt) {
    const charge = s.charge;
    const charging = charge.active;
    const cAnchorX = charge.button === 0 ? charge.cloudX : (charge.ball ? charge.ball.x : 0);
    const cAnchorY = charge.button === 0 ? charge.cloudY : (charge.ball ? charge.ball.y : 0);

    for (let i = s.sparks.length - 1; i >= 0; i--) {
      const sp = s.sparks[i];
      sp.t += dt;
      if (sp.t >= sp.life) {
        s.sparks.splice(i, 1);
        if (s.sparkPool.length < 600) s.sparkPool.push(sp);
        continue;
      }

      /* 飞行中分叉（爆裂火花） */
      if (sp.canSplit && !sp.splitDone && sp.t > sp.life * 0.35) {
        sp.splitDone = true;
        this._spawnSpark(s, sp.x, sp.y,
          sp.vx * 0.72 + rand(-70, 70), sp.vy * 0.72 + rand(-70, 70),
          sp.life * 0.55, sp.size * 0.75, sp.kind, sp.grav, false);
        this._spawnSpark(s, sp.x, sp.y,
          sp.vx * 0.72 + rand(-70, 70), sp.vy * 0.72 + rand(-70, 70),
          sp.life * 0.55, sp.size * 0.75, sp.kind, sp.grav, false);
      }

      sp.vy += sp.grav * dt;

      /* 污染拖尾：蓄力时靠近云层 / 等离子球的火花被吸引 */
      if (charging) {
        const dx = cAnchorX - sp.x, dy = cAnchorY - sp.y;
        const d2 = dx * dx + dy * dy;
        const range = charge.button === 0 ? 220 : 140;
        if (d2 < range * range && d2 > 1) {
          const d = Math.sqrt(d2);
          const f = (1 - d / range) * (charge.button === 0 ? 420 : 600);
          sp.vx += (dx / d) * f * dt;
          sp.vy += (dy / d) * f * dt;
          sp.grav = 0;
        }
      }

      sp.x += sp.vx * dt;
      sp.y += sp.vy * dt;
    }
  }

  _sparkTex(s, sp) {
    if (sp.kind === 'gold')    return s.tex.gold;
    if (sp.kind === 'magenta') return s.tex.magenta;
    return sp.t / sp.life < 0.4 ? s.tex.white : s.tex.ice;
  }

  _drawSparks(s) {
    const ctx = s.ctx;
    ctx.lineCap = 'round';
    for (let i = 0; i < s.sparks.length; i++) {
      const sp = s.sparks[i];
      const p = sp.t / sp.life;
      const alpha = 1 - p * p;
      const tex = this._sparkTex(s, sp);

      /* 短拖尾 */
      const spd = Math.hypot(sp.vx, sp.vy);
      if (spd > 60) {
        ctx.globalAlpha = alpha * 0.45;
        ctx.strokeStyle = sp.kind === 'gold' ? '#FFD24A'
                        : sp.kind === 'magenta' ? '#FF4FD8'
                        : '#A8D8FF';
        ctx.lineWidth = sp.size * 0.9;
        ctx.beginPath();
        ctx.moveTo(sp.x - sp.vx * 0.028, sp.y - sp.vy * 0.028);
        ctx.lineTo(sp.x, sp.y);
        ctx.stroke();
      }

      /* 主体软光斑 */
      const r = sp.size * 3.2;
      this._drawTex(s, tex, sp.x, sp.y, r, alpha * 0.95);

      /* 炽白核心 */
      if (sp.size > 1.2) {
        this._drawTex(s, s.tex.white, sp.x, sp.y, sp.size * 1.1, alpha * 0.9);
      }
    }
  }

  /* =========================================================
     软光斑系统（电离通道残影 / 辉光 / 闪光）
     ========================================================= */
  _addGlow(s, x, y, r0, r1, life, tex, a0) {
    if (s.glows.length >= CONFIG.maxGlows) return;
    s.glows.push({ x, y, r0, r1, t: 0, life, tex: tex || s.tex.ion, a0: a0 != null ? a0 : 0.5 });
  }

  /* 沿折线路径铺软光斑（电离通道残影） */
  _addIonPath(s, pts, width, life, tex, a0) {
    const t = tex || s.tex.ion;
    const a = a0 != null ? a0 : 0.5;
    for (let i = 0; i < pts.length - 1; i++) {
      const A = pts[i], B = pts[i + 1];
      const d = Math.hypot(B.x - A.x, B.y - A.y);
      const steps = Math.max(1, Math.floor(d / 9));
      for (let j = 0; j < steps; j++) {
        const k = j / steps;
        this._addGlow(s,
          A.x + (B.x - A.x) * k,
          A.y + (B.y - A.y) * k,
          width * rand(0.75, 1.25),
          width * rand(0.9, 1.5),
          life * rand(0.85, 1.15),
          t, a
        );
      }
    }
  }

  _updateGlows(s, dt) {
    for (let i = s.glows.length - 1; i >= 0; i--) {
      const g = s.glows[i];
      g.t += dt;
      if (g.t >= g.life) s.glows.splice(i, 1);
    }
  }

  _drawGlows(s) {
    for (let i = 0; i < s.glows.length; i++) {
      const g = s.glows[i];
      const p = g.t / g.life;
      const r = lerp(g.r0, g.r1, p);
      const a = g.a0 * (1 - p);
      this._drawTex(s, g.tex, g.x, g.y, r, a);
    }
  }

  /* =========================================================
     电离环（细圆环）
     ========================================================= */
  _addRing(s, x, y, life, maxR, color, w) {
    s.rings.push({
      x, y, t: 0, life, maxR,
      color: color || '#A8D8FF',
      w: w || 1.5
    });
  }

  _updateRings(s, dt) {
    for (let i = s.rings.length - 1; i >= 0; i--) {
      const r = s.rings[i];
      r.t += dt;
      if (r.t >= r.life) s.rings.splice(i, 1);
    }
  }

  _drawRings(s) {
    const ctx = s.ctx;
    for (let i = 0; i < s.rings.length; i++) {
      const r = s.rings[i];
      const p = r.t / r.life;
      const R = r.maxR * p;
      const a = (1 - p) * 0.75;
      if (R < 1 || a <= 0.01) continue;
      ctx.globalAlpha = a;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.w;
      ctx.beginPath();
      ctx.arc(r.x, r.y, R, 0, TAU);
      ctx.stroke();
    }
  }

  /* =========================================================
     环形电弧（右键爆裂专属）
     ========================================================= */
  _addRingArcs(s, x, y, r0, r1, life) {
    const count = randInt(8, 16);
    const items = [];
    for (let i = 0; i < count; i++) {
      const len = rand(18, 42);
      const n = 3;
      const pts = [];
      for (let k = 0; k <= n; k++) {
        const sPos = (k / n - 0.5) * len;
        const j = (k === 0 || k === n) ? 0 : (Math.random() - 0.5) * 11;
        pts.push({ s: sPos, j });
      }
      items.push({
        baseAng: (i / count) * TAU + rand(-0.12, 0.12),
        pts
      });
    }
    s.ringArcs.push({ x, y, r0, r1, t: 0, life, items });
  }

  _updateRingArcs(s, dt) {
    for (let i = s.ringArcs.length - 1; i >= 0; i--) {
      const ra = s.ringArcs[i];
      ra.t += dt;
      if (ra.t >= ra.life) s.ringArcs.splice(i, 1);
    }
  }

  _drawRingArcs(s) {
    const ctx = s.ctx;
    ctx.lineCap = 'round';
    for (let i = 0; i < s.ringArcs.length; i++) {
      const ra = s.ringArcs[i];
      const p = ra.t / ra.life;
      const R = lerp(ra.r0, ra.r1, p);
      const a = (1 - p) * (1 - p);
      if (a <= 0.01) continue;

      /* 外辉光 */
      ctx.globalAlpha = a * 0.35;
      ctx.strokeStyle = CONFIG.R.glow;
      ctx.lineWidth = 3.5;

      for (let k = 0; k < ra.items.length; k++) {
        const it = ra.items[k];
        const ang = it.baseAng + ra.t * 0.6;
        const cx = ra.x + Math.cos(ang) * R;
        const cy = ra.y + Math.sin(ang) * R;
        const tx = -Math.sin(ang), ty = Math.cos(ang);
        const ox = Math.cos(ang), oy = Math.sin(ang);

        ctx.beginPath();
        for (let m = 0; m < it.pts.length; m++) {
          const pt = it.pts[m];
          const px = cx + tx * pt.s + ox * pt.j;
          const py = cy + ty * pt.s + oy * pt.j;
          if (m === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }

      /* 内层炽白 */
      ctx.globalAlpha = a * 0.95;
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.4;

      for (let k = 0; k < ra.items.length; k++) {
        const it = ra.items[k];
        const ang = it.baseAng + ra.t * 0.6;
        const cx = ra.x + Math.cos(ang) * R;
        const cy = ra.y + Math.sin(ang) * R;
        const tx = -Math.sin(ang), ty = Math.cos(ang);
        const ox = Math.cos(ang), oy = Math.sin(ang);

        ctx.beginPath();
        for (let m = 0; m < it.pts.length; m++) {
          const pt = it.pts[m];
          const px = cx + tx * pt.s + ox * pt.j;
          const py = cy + ty * pt.s + oy * pt.j;
          if (m === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    }
  }

  /* =========================================================
     鼠标输入 / 拖尾
     ========================================================= */
  // 原型这段逻辑写在 mousemove 回调里（逐事件）；移植后按帧执行一次，
  // 位移取基类的事件级锚点 lx / ly → x / y（即本帧最后一段位移，与原型第 1373~1375 行同义）。
  _updateMouseMotion(s) {
    const M = s.input;

    // 原型第 1368~1371 行：首次 mousemove 只做对齐（此时 dist 恒为 0，直接 return）
    if (!s.mouseInit) {
      if (M.x !== M.lx || M.y !== M.ly) s.mouseInit = true;
      return;
    }

    const x = M.x, y = M.y;
    const dx = x - M.lx;
    const dy = y - M.ly;
    const dist = Math.hypot(dx, dy);

    s.smoothSpeed = s.smoothSpeed * 0.85 + dist * 0.15;

    if (dist < 0.5) return;

    /* —— 拖尾光点 —— */
    if (dist > 8) this._pushTrailPoint(s, x, y);

    /* —— 电火花（每移动 25px 生成一批） —— */
    s.moveAccum += dist;
    while (s.moveAccum > 25) {
      s.moveAccum -= 25;
      const n = randInt(3, 5);
      for (let i = 0; i < n; i++) {
        this._spawnSpark(s,
          x + rand(-14, 14),
          y + rand(-14, 14),
          rand(-45, 45) - dx * 1.2,
          rand(-45, 45) - dy * 1.2,
          rand(0.4, 0.8),
          rand(0.8, 1.8),
          'cool',
          CONFIG.trailSparkGravity,
          false
        );
      }
    }

    /* —— 短电弧 —— */
    // 原型按事件近似 1/60 帧步进（第 1411 行）；这里按「发生移动的帧」推进一次，口径相同
    s.shortArcTimer -= 1 / 60;
    if (s.shortArcTimer <= 0) {
      const fast = s.smoothSpeed > 22;
      const interval = fast ? 0.08 : rand(CONFIG.shortArcInterval[0], CONFIG.shortArcInterval[1]) * 0.9;
      s.shortArcTimer = interval;

      /* 连接鼠标轨迹上的两个随机点 */
      const back = fast ? 70 : 34;
      const x1 = x - dx * rand(0.5, 1.5) - rand(-back, back);
      const y1 = y - dy * rand(0.5, 1.5) - rand(-back, back);
      const len = clamp(Math.hypot(x - x1, y - y1), 20, 50);
      const ex = x1 + (x - x1) / (Math.hypot(x - x1, y - y1) || 1) * len;
      const ey = y1 + (y - y1) / (Math.hypot(x - x1, y - y1) || 1) * len;

      const pts = genPath(x1, y1, ex, ey, randInt(3, 5), 14);
      this._spawnArc(s, pts, {
        mode: 'short',
        dur: 0.1,
        w0: 1.6, w1: 1,
        colCore: '#FFFFFF',
        colMid: '#A8D8FF',
        colGlow: '#A8D8FF',
        alpha: fast ? 0.95 : 0.7
      });
    }
  }

  _pushTrailPoint(s, x, y) {
    s.trailPoints.push({ x, y, life: 1.2, maxLife: 1.2, over: 0 });
    if (s.trailPoints.length > 70) s.trailPoints.shift();
  }

  _updateTrailPoints(s, dt) {
    for (let i = s.trailPoints.length - 1; i >= 0; i--) {
      const p = s.trailPoints[i];
      p.life -= dt;
      if (p.over > 0) p.over -= dt;
      if (p.life <= 0) s.trailPoints.splice(i, 1);
    }
  }

  _drawTrailPoints(s) {
    for (let i = 0; i < s.trailPoints.length; i++) {
      const p = s.trailPoints[i];
      const lp = p.life / p.maxLife;
      /* 被电弧击中过 → 过曝 */
      const over = p.over > 0 ? 1 : 0;
      const a = (0.12 * lp) + over * 1.5;
      const r = 3 + over * 8;
      this._drawTex(s, over ? s.tex.white : s.tex.ice, p.x, p.y, r, a * 0.5);
    }
  }

  /* =========================================================
     等离子球系统
     ========================================================= */
  _createBall(x, y) {
    const ball = {
      x, y,
      vx: rand(-45, 45), vy: rand(-45, 45),
      dirTimer: rand(0.5, 1.0),
      r: 5,
      spin: 0,
      spinSpeed: rand(0.5, 1.5),
      pulse: 1,
      alpha: 0.8,
      glowA: 0.3,
      innerArcs: []
    };
    for (let i = 0; i < 8; i++) {
      const ia = { pts: [], alpha: 1, timer: 0, active: i < 3 };
      regenInnerArc(ia, 30);
      ball.innerArcs.push(ia);
    }
    return ball;
  }

  _updateBall(s, dt, p) {
    const b = s.charge.ball;
    const M = s.input;
    if (!b) return;

    /* 漂浮：随机方向，慢速 */
    b.dirTimer -= dt;
    if (b.dirTimer <= 0) {
      b.dirTimer = rand(0.5, 1.0);
      const a = Math.random() * TAU;
      const sp = rand(30, 60);
      b.vx = Math.cos(a) * sp;
      b.vy = Math.sin(a) * sp;
    }
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    /* 向光标靠拢 + 限制在 60px 范围内 */
    b.x += (M.x - b.x) * Math.min(1, dt * 3.5);
    b.y += (M.y - b.y) * Math.min(1, dt * 3.5);

    const dx = b.x - M.x, dy = b.y - M.y;
    const d = Math.hypot(dx, dy) || 1;
    if (d > 60) {
      b.x = M.x + (dx / d) * 60;
      b.y = M.y + (dy / d) * 60;
      b.vx *= -0.5;
      b.vy *= -0.5;
    }

    /* 自转 */
    b.spin += b.spinSpeed * dt;

    /* 半径 / 亮度 */
    b.r = 5 + 30 * p;
    b.alpha = 0.7 + 0.2 * p + Math.sin(s.time * TAU * 1.0) * 0.06;
    b.glowA = 0.3 + 0.2 * p;

    /* 脉动 */
    b.pulse = 1 + 0.1 * Math.sin(s.time * TAU * 3);

    /* 微震 */
    if (p > 0.55) {
      const j = (p - 0.55) / 0.45;
      b.x += rand(-1, 1) * 4 * j;
      b.y += rand(-1, 1) * 4 * j;
    }

    /* 电离痕迹 */
    if (Math.random() < 0.4) {
      this._addGlow(s, b.x, b.y, b.r * 0.8, b.r * 0.9, 0.5, s.tex.magenta, 0.07);
    }

    /* 内部电弧 */
    const arcCount = Math.round(lerp(3, 8, p));
    for (let i = 0; i < b.innerArcs.length; i++) {
      const ia = b.innerArcs[i];
      ia.active = i < arcCount;
      if (!ia.active) continue;
      ia.timer -= dt;
      if (ia.timer <= 0) regenInnerArc(ia, b.r);
    }

    /* 外放电 */
    if (p > 0.4) {
      s.charge.nextOut -= dt;
      if (s.charge.nextOut <= 0) {
        s.charge.nextOut = lerp(0.5, 0.15, (p - 0.4) / 0.6) * rand(0.7, 1.3);
        const ang = Math.random() * TAU;
        const len = rand(15, 40);
        const ex = b.x + Math.cos(ang) * len;
        const ey = b.y + Math.sin(ang) * len;
        const pts = genPath(b.x, b.y, ex, ey, randInt(3, 5), 14);
        this._spawnArc(s, pts, {
          mode: 'short',
          dur: 0.12,
          w0: 1.6, w1: 1,
          colCore: '#FFFFFF',
          colMid: CONFIG.R.glow,
          colGlow: CONFIG.R.glow,
          alpha: 0.9
        });
      }
    }
  }

  _drawBall(s) {
    const b = s.charge.ball;
    if (!b) return;
    const ctx = s.ctx;
    const r = b.r * b.pulse;

    /* 外圈辉光 */
    this._drawTex(s, s.tex.magenta, b.x, b.y, r * 3.4, b.glowA * 0.55);
    this._drawTex(s, s.tex.purple,  b.x, b.y, r * 2.1, b.glowA * 0.7);

    /* 球体本体：三层径向渐变 */
    const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, r);
    g.addColorStop(0.00, `rgba(255,210,74,${0.95 * b.alpha})`);
    g.addColorStop(0.30, `rgba(255,107,26,${0.80 * b.alpha})`);
    g.addColorStop(0.62, `rgba(138,92,255,${0.42 * b.alpha})`);
    g.addColorStop(1.00, `rgba(138,92,255,0)`);
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(b.x, b.y, r, 0, TAU);
    ctx.fill();

    /* 内部电弧 */
    ctx.lineCap = 'round';
    const cs = Math.cos(b.spin), sn = Math.sin(b.spin);
    for (let i = 0; i < b.innerArcs.length; i++) {
      const ia = b.innerArcs[i];
      if (!ia.active || !ia.pts || ia.pts.length < 2) continue;

      ctx.globalAlpha = ia.alpha * b.alpha * 0.95;
      ctx.strokeStyle = CONFIG.R.arc;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let k = 0; k < ia.pts.length; k++) {
        const px = ia.pts[k].x, py = ia.pts[k].y;
        const rx = px * cs - py * sn;
        const ry = px * sn + py * cs;
        if (k === 0) ctx.moveTo(b.x + rx, b.y + ry);
        else ctx.lineTo(b.x + rx, b.y + ry);
      }
      ctx.stroke();
    }
  }

  /* =========================================================
     左键蓄力：云层可视化
     ========================================================= */
  _updateCloudCharge(s, dt, p) {
    const charge = s.charge;
    const M = s.input;

    /* 云层点：光标上方 200 → 120 px，随蓄力下移 */
    const targetY = M.y - (200 - 80 * p);
    charge.cloudY += (targetY - charge.cloudY) * Math.min(1, dt * 8);
    charge.cloudX += (M.x - charge.cloudX) * Math.min(1, dt * 8);

    /* 微震 */
    if (p > 0.55) {
      const j = (p - 0.55) / 0.45;
      charge.cloudX += rand(-1, 1) * 3 * j;
      charge.cloudY += rand(-1, 1) * 3 * j;
    }

    charge.cloudR = 30 + 50 * p;
    charge.cloudAlpha = 0.15 + 0.2 * p;

    /* —— 云内小放电 —— */
    charge.nextIntra -= dt;
    if (charge.nextIntra <= 0) {
      charge.nextIntra = lerp(0.30, 0.15, p) * rand(0.7, 1.3);
      const n = Math.random() < 0.5 ? 1 : 2;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU;
        const rr = Math.random() * charge.cloudR * 0.75;
        const sx = charge.cloudX + Math.cos(a) * rr;
        const sy = charge.cloudY + Math.sin(a) * rr * 0.6;
        const ang = Math.random() * TAU;
        const len = rand(15, 40);
        const pts = genPath(sx, sy, sx + Math.cos(ang) * len, sy + Math.sin(ang) * len,
                            randInt(3, 6), 12);
        const col = p < 0.5 ? '#A8D8FF' : (p < 0.8 ? '#4FE3FF' : '#FFFFFF');
        this._spawnArc(s, pts, {
          mode: 'short',
          dur: 0.08,
          w0: 1.5, w1: 1,
          colCore: '#FFFFFF',
          colMid: col,
          colGlow: col,
          alpha: 0.45 + p * 0.55
        });
      }
      /* 云层闪一下 */
      this._addGlow(s, charge.cloudX, charge.cloudY, charge.cloudR * 0.9, charge.cloudR * 1.1,
                    0.14, s.tex.purple, 0.15 + p * 0.12);
    }

    /* —— 试探先导（>1s） —— */
    if (charge.t > 1.0) {
      charge.nextProbe -= dt;
      if (charge.nextProbe <= 0) {
        const k = clamp((charge.t - 1.0) / 1.5, 0, 1);
        charge.nextProbe = lerp(0.75, 0.25, k) * rand(0.75, 1.25);
        const sx = charge.cloudX + rand(-30, 30);
        const sy = charge.cloudY + rand(-10, 10);
        const len = rand(30, 60);
        const ex = sx + rand(-16, 16);
        const ey = sy + len;
        const pts = genPath(sx, sy, ex, ey, randInt(3, 5), 12);
        this._spawnArc(s, pts, {
          mode: 'leader',
          dur: 0.22,
          w0: 1,
          colCore: CONFIG.L.leader,
          alpha: 0.9
        });
      }
    }
  }

  _drawCloudCharge(s) {
    const ctx = s.ctx;
    const charge = s.charge;
    const M = s.input;
    const p = clamp(charge.t / CONFIG.chargeMax, 0, 1);
    const pulseFreq = 1 + 4 * p;
    const pulse = 1 + 0.1 * Math.sin(s.time * pulseFreq * TAU);
    const R = charge.cloudR * pulse;

    /* 云层软光斑（暗蓝 → 深蓝 → 蓝紫） */
    const warm = clamp(p * 1.4, 0, 1);
    this._drawTex(s, s.tex.ion, charge.cloudX, charge.cloudY, R * 1.5, charge.cloudAlpha);
    this._drawTex(s, s.tex.purple, charge.cloudX, charge.cloudY, R * 1.9, charge.cloudAlpha * 0.35 * warm);

    /* 电离辉光（>1.5s） */
    if (charge.t > 1.5) {
      const ga = 0.10 * clamp((charge.t - 1.5) / 1.0, 0, 1);
      this._drawTex(s, s.tex.purple, charge.cloudX, charge.cloudY, R * 3.4, ga);
    }

    /* 电场线（>1.8s） */
    if (charge.t > 1.8) {
      const fa = 0.15 * clamp((charge.t - 1.8) / 0.5, 0, 1);
      const bottomY = M.y + 50 + Math.random() * 30;
      ctx.globalAlpha = fa;
      ctx.strokeStyle = '#8A5CFF';
      ctx.lineWidth = 1;
      for (let i = 0; i < 4; i++) {
        const lx = charge.cloudX + (i - 1.5) * 18;
        ctx.beginPath();
        ctx.moveTo(lx, charge.cloudY);
        const segs = 6;
        for (let k = 1; k <= segs; k++) {
          const t2 = k / segs;
          const yy = charge.cloudY + (bottomY - charge.cloudY) * t2;
          const xx = lx + Math.sin(s.time * 4 + k * 1.7 + i * 2.1) * 3 * t2;
          ctx.lineTo(xx, yy);
        }
        ctx.stroke();
      }
    }
  }

  /* =========================================================
     电弧跳跃（Arc Jump）—— 点击时对拖尾的冲击
     ========================================================= */
  _arcJumpChain(s, x, y, visited, depth) {
    if (depth > 3) return;

    const range = depth === 0 ? 300 : 80;
    const cands = [];
    for (let i = 0; i < s.trailPoints.length; i++) {
      const p = s.trailPoints[i];
      if (p.life <= 0 || visited.has(p)) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < range) cands.push({ p, d });
    }
    if (!cands.length) return;

    cands.sort((a, b) => a.d - b.d);
    const maxTargets = depth === 0 ? randInt(3, 5) : 2;
    const chosen = cands.slice(0, maxTargets);

    for (let i = 0; i < chosen.length; i++) {
      const target = chosen[i].p;
      visited.add(target);

      // 原型用 IIFE 绑定 tg / idx / srcX / srcY；let / const 的块级作用域等价
      this._later(s, i * 0.03, () => {
        if (target.life <= 0) return;

        const len = Math.hypot(target.x - x, target.y - y);
        const segs = clamp(Math.round(len / 22), 4, 8);
        const pts = genPath(x, y, target.x, target.y, segs, 20);

        /* 主电弧 */
        this._spawnArc(s, pts, {
          mode: 'full',
          dur: 0.07,
          flicker: 0.05,
          w0: depth === 0 ? 2.2 : 1.4,
          w1: 0.9,
          colCore: '#FFFFFF',
          colMid: CONFIG.L.mid,
          colGlow: CONFIG.L.mid,
          alpha: depth === 0 ? 1 : 0.75
        });

        /* 分叉（浅层） */
        if (depth < 2 && Math.random() < 0.6) {
          const p0 = pts[Math.floor(pts.length / 2)];
          const ang = Math.random() * TAU;
          const bl = rand(12, 30);
          const bpts = genPath(p0.x, p0.y, p0.x + Math.cos(ang) * bl, p0.y + Math.sin(ang) * bl,
                               3, 10);
          this._spawnArc(s, bpts, {
            mode: 'short',
            dur: 0.08,
            w0: 1.2, w1: 0.8,
            colCore: '#FFFFFF',
            colMid: CONFIG.L.branch,
            colGlow: CONFIG.L.branch,
            alpha: 0.8
          });
        }

        /* 目标过曝 + 小闪光 + 电离残影 */
        target.over = 0.4;
        this._addGlow(s, target.x, target.y, 10, 12, 0.14, s.tex.white, 0.9);
        this._addGlow(s, target.x, target.y, 8, 14, 0.4, s.tex.ion, 0.35);

        /* 次级跳跃 */
        this._later(s, 0.02, () => {
          this._arcJumpChain(s, target.x, target.y, visited, depth + 1);
        });
      });
    }
  }

  /* =========================================================
     交互二：普通单击（短促对地闪电）
     ========================================================= */
  _doClickLightning(s, x, y) {
    const cx = x + rand(-14, 14);
    const cy = y - rand(60, 100);

    const pts = genPath(cx, cy, x, y, 8, 16);

    const leaderDur = 0.07;
    const returnDur = 0.035;

    /* 先导（暗） */
    this._spawnArc(s, pts, {
      mode: 'leader',
      dur: leaderDur,
      w0: 1.5,
      colCore: CONFIG.L.leader,
      alpha: 1
    });

    /* 回击（亮，沿原路返回） */
    this._spawnArc(s, pts, {
      mode: 'full',
      dur: returnDur,
      delay: leaderDur + CONFIG.phaseGap,
      flicker: 0.12,
      reverse: true,
      w0: 1,
      w1: 3.6,
      colCore: CONFIG.L.core,
      colMid: CONFIG.L.mid,
      colGlow: CONFIG.L.mid,
      alpha: 1
    });

    /* 1~2 条分叉 */
    this._spawnBranches(s, pts, 1, { leaderDur: leaderDur, returnDur: returnDur, delay: 0 });

    /* 击中小闪光 */
    this._addGlow(s, x, y, 12, 12, 0.10, s.tex.white, 1.0);

    /* 向外散射 8~12 个电火花 */
    const n = randInt(8, 12);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const sp = rand(150, 400);
      this._spawnSpark(s, x, y, Math.cos(a) * sp, Math.sin(a) * sp,
                       rand(0.4, 0.8), rand(1, 2.2), 'gold', 300, false);
    }

    /* 电离通道残影 */
    this._addIonPath(s, pts, 4, 0.5, s.tex.ion, 0.5);

    /* 电弧跳跃 */
    this._arcJumpChain(s, x, y, new Set(), 0);
  }

  /* =========================================================
     交互四：左键云地闪
     ========================================================= */
  _fireCG(s, power) {
    const M = s.input;
    const charge = s.charge;
    const cx = charge.cloudX;
    const cy = charge.cloudY;
    const gx = M.x;
    const gy = M.y + 60 + 80 * power;

    const segs = clamp(Math.round(8 + power * 8), 8, 16);
    const pts = genPath(cx, cy, gx, gy, segs, CONFIG.jitterAmp * (0.5 + power * 0.7));

    const leaderDur = lerp(CONFIG.leaderTime[1], CONFIG.leaderTime[0], power);
    const returnDur = lerp(CONFIG.returnTime[1], CONFIG.returnTime[0], power);
    const gap = CONFIG.phaseGap;
    const strokeStart = leaderDur + gap;

    /* —— 1. 主先导（暗折线，从云层向地面摸索） —— */
    this._spawnArc(s, pts, {
      mode: 'leader',
      dur: leaderDur,
      w0: 1.7,
      colCore: CONFIG.L.leader,
      alpha: 1
    });

    /* —— 2. 主回击（亮折线，沿原路径从地面返回云层） —— */
    this._spawnArc(s, pts, {
      mode: 'full',
      dur: returnDur,
      delay: strokeStart,
      flicker: CONFIG.flickerTime,
      reverse: true,
      w0: 1,
      w1: 4.5,
      colCore: CONFIG.L.core,
      colMid: CONFIG.L.mid,
      colGlow: CONFIG.L.mid,
      alpha: 1
    });

    /* —— 3. 分叉（递归 2 级，各自有先导与回击） —— */
    this._spawnBranches(s, pts, 0, {
      leaderDur: leaderDur,
      returnDur: returnDur,
      delay: 0
    });

    /* —— 4. 回击到达地面：电火花 + 电离环 + 闪光 —— */
    this._later(s, strokeStart, () => {
      const n = Math.round(20 + 25 * power);
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.7;
        const sp = 200 + Math.random() * 400 * (0.5 + power);
        this._spawnSpark(s, gx, gy, Math.cos(a) * sp, Math.sin(a) * sp,
                         rand(0.5, 1.1), rand(1, 2.4), 'gold', 300, false);
      }
      this._addGlow(s, gx, gy, 26 + 40 * power, 34 + 46 * power, 0.16, s.tex.white, 0.9);

      const ringN = randInt(2, 3);
      for (let i = 0; i < ringN; i++) {
        this._addRing(s, gx, gy, 0.4 + i * 0.05,
                      80 + 120 * power * (0.6 + i * 0.25),
                      '#A8D8FF', 1 + i * 0.4);
      }
    });

    /* —— 5. 电离通道残影 —— */
    this._later(s, strokeStart + returnDur * 0.4, () => {
      this._addIonPath(s, pts, 4.5, rand(CONFIG.ionLife[0], CONFIG.ionLife[1]), s.tex.ion, 0.5);
    });

    /* —— 6. 云层爆散 —— */
    this._later(s, strokeStart + returnDur, () => {
      this._addGlow(s, cx, cy, 80, 150, 0.22, s.tex.purple, 0.35);
      this._addGlow(s, cx, cy, 60, 120, 0.30, s.tex.ion, 0.25);
    });

    /* —— 7. 地面余电（爆发后 2s 内偶发金色火花） —— */
    for (let i = 0; i < 8; i++) {
      this._later(s, 0.4 + i * 0.22 + Math.random() * 0.15, () => {
        const a = Math.random() * TAU;
        const sp = rand(60, 220);
        this._spawnSpark(s, gx + rand(-16, 16), gy + rand(-10, 10),
                         Math.cos(a) * sp, Math.sin(a) * sp - rand(40, 120),
                         rand(0.4, 0.8), rand(0.8, 1.8), 'gold', 280, false);
      });
    }

    /* —— 8. 拖尾被电弧跳跃击中 —— */
    this._arcJumpChain(s, M.x, M.y, new Set(), 0);
  }

  /* =========================================================
     交互五：右键球状闪电爆裂
     ========================================================= */
  _burstBall(s, power) {
    const M = s.input;
    const b = s.charge.ball;
    if (!b) return;

    const bx = b.x, by = b.y;
    const r = b.r;

    /* —— 1. 过曝（一帧纯白） —— */
    this._addGlow(s, bx, by, r * 1.3, r * 1.3, 0.05, s.tex.white, 1.0);

    /* —— 2. 第一层：球体本体三层径向扩张 —— */
    this._addGlow(s, bx, by, r, r * 2.0, 0.12, s.tex.gold,   0.9);
    this._addGlow(s, bx, by, r * 0.9, r * 1.7, 0.12, s.tex.orange, 0.7);
    this._addGlow(s, bx, by, r * 0.8, r * 1.5, 0.12, s.tex.purple, 0.6);

    /* —— 3. 第二层：内部电弧向外射出 —— */
    const arcN = b.innerArcs.length;
    for (let i = 0; i < arcN; i++) {
      const ang = Math.random() * TAU;
      const len = rand(40, 120);
      const ex = bx + Math.cos(ang) * len;
      const ey = by + Math.sin(ang) * len;
      const pts = genPath(bx, by, ex, ey, randInt(4, 6), 24);
      this._spawnArc(s, pts, {
        mode: 'full',
        dur: 0.13,
        flicker: 0.06,
        w0: 1.6, w1: 0.4,
        colCore: '#FFFFFF',
        colMid: CONFIG.R.glow,
        colGlow: CONFIG.R.glow,
        alpha: 0.92
      });
    }

    /* —— 4. 环形电弧 —— */
    const ringLayers = randInt(1, 2);
    for (let k = 0; k < ringLayers; k++) {
      this._addRingArcs(s, bx, by, r, 80 + 300 * power, 0.5 + k * 0.08);
    }

    /* —— 5. 爆裂火花雨（20% 会在飞行中分叉） —— */
    const n = Math.round(80 + 250 * power);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const sp = (200 + 800 * power) * rand(0.3, 1.0);
      const kind = Math.random() < 0.65 ? 'gold' : 'magenta';
      this._spawnSpark(s, bx, by, Math.cos(a) * sp, Math.sin(a) * sp,
                       rand(0.5, 1.4), rand(1, 3), kind, 200, true);
    }

    /* —— 6. 爆裂残影 —— */
    this._addGlow(s, bx, by, 40, 64, 0.8, s.tex.magenta, 0.3);

    /* —— 7. 电离感应：场上拖尾火花闪一下并向外获得小速度 —— */
    for (let i = 0; i < s.sparks.length; i++) {
      const sp = s.sparks[i];
      const dx = sp.x - bx, dy = sp.y - by;
      const d = Math.hypot(dx, dy) || 1;
      if (d < 320) {
        const f = (1 - d / 320) * rand(100, 300);
        sp.vx += (dx / d) * f;
        sp.vy += (dy / d) * f;
        sp.t *= 0.7;
      }
    }
    for (let i = 0; i < s.trailPoints.length; i++) {
      const p = s.trailPoints[i];
      const d = Math.hypot(p.x - bx, p.y - by);
      if (d < 240) p.over = Math.max(p.over, 0.25);
    }

    /* —— 8. 余韵：光标处残余放电 1.5s —— */
    for (let i = 0; i < 10; i++) {
      this._later(s, 0.08 + i * 0.13, () => {
        const a = Math.random() * TAU;
        const len = rand(10, 30);
        const sx = M.x + rand(-20, 20);
        const sy = M.y + rand(-20, 20);
        const pts = genPath(sx, sy, sx + Math.cos(a) * len, sy + Math.sin(a) * len,
                            randInt(3, 5), 14);
        this._spawnArc(s, pts, {
          mode: 'short',
          dur: 0.1,
          w0: 1.4, w1: 0.9,
          colCore: '#FFFFFF',
          colMid: CONFIG.R.glow,
          colGlow: CONFIG.R.glow,
          alpha: 0.75
        });
      });
    }
  }

  /* =========================================================
     鼠标事件
     ========================================================= */
  _startCharge(s, btn, x, y) {
    const charge = s.charge;
    charge.active = true;
    charge.button = btn;
    charge.t = 0;
    charge.nextIntra = 0;
    charge.nextProbe = 0.6;
    charge.nextOut = 0.5;

    if (btn === 0) {
      charge.cloudX = x;
      charge.cloudY = y - 200;
      charge.cloudR = 30;
      charge.cloudAlpha = 0.15;
      charge.ball = null;
    } else {
      charge.ball = this._createBall(x, y);
    }
  }

  _endCharge(s, x, y) {
    const charge = s.charge;
    if (!charge.active) return;

    const btn = charge.button;
    const t = charge.t;
    const p = clamp(t / CONFIG.chargeMax, 0, 1);
    const power = Math.pow(p, 1.6);

    if (btn === 0) {
      if (t < CONFIG.minCharge) {
        /* 蓄力不足 → 普通单击 */
        this._doClickLightning(s, x, y);
      } else {
        this._fireCG(s, power);
      }
    } else if (btn === 2) {
      if (t < CONFIG.minCharge) {
        /* 快速小等离子球：快速成型 + 快速爆裂 */
        if (!charge.ball) charge.ball = this._createBall(x, y);
        charge.ball.r = 14;
        charge.ball.x = x;
        charge.ball.y = y;
        charge.ball.alpha = 0.85;
        charge.ball.glowA = 0.45;
        charge.ball.pulse = 1;
        this._burstBall(s, 0.18);
      } else {
        this._burstBall(s, power);
      }
    }

    charge.active = false;
    charge.button = -1;
    charge.ball = null;
  }

  // 原型以 mousedown / mouseup 的事件坐标作为蓄力与爆发原点
  onPointerDown(e) {
    const s = this.state;
    if (!s) return;
    if (e.button === 0) this._startCharge(s, 0, e.clientX, e.clientY);
    else if (e.button === 2) this._startCharge(s, 2, e.clientX, e.clientY);
  }

  onPointerUp(e) {
    const s = this.state;
    if (!s) return;
    if (e.button === 0 && s.charge.button === 0) this._endCharge(s, e.clientX, e.clientY);
    else if (e.button === 2 && s.charge.button === 2) this._endCharge(s, e.clientX, e.clientY);
  }

  // 失焦时清理蓄力状态（原型 window blur 的行为）
  onBlur() {
    const s = this.state;
    if (!s) return;
    s.charge.active = false;
    s.charge.button = -1;
    s.charge.ball = null;
    s.timers.length = 0;
  }

  /* =========================================================
     尺寸 —— 只同步动效自己的 W / H，画布尺寸与 DPR 由基类维护
     ========================================================= */
  onResize(width, height) {
    const s = this.state;
    if (!s) return;
    s.W = width;
    s.H = height;
  }

  /* =========================================================
     更新
     ========================================================= */
  update(dt, s) {
    if (!s) return;

    s.time += dt;

    this._updateTimers(s, dt);

    /* 蓄力 */
    if (s.charge.active) {
      s.charge.t += dt;
      const p = clamp(s.charge.t / CONFIG.chargeMax, 0, 1);
      if (s.charge.button === 0) {
        this._updateCloudCharge(s, dt, p);
      } else if (s.charge.button === 2 && s.charge.ball) {
        this._updateBall(s, dt, p);
      }
    }

    this._updateArcs(s, dt);
    this._updateSparks(s, dt);
    this._updateGlows(s, dt);
    this._updateRings(s, dt);
    this._updateRingArcs(s, dt);
    this._updateTrailPoints(s, dt);

    // 鼠标位移生成（原型在 mousemove 回调里）：放在各 update 之后，
    // 新生成的电弧 / 火花 / 光点本帧不推进，与原型「事件先于帧、下一帧才更新」的时序一致。
    this._updateMouseMotion(s);
  }

  /* =========================================================
     渲染
     ========================================================= */
  render(s) {
    if (!s) return;
    const ctx = s.ctx;

    /* 清屏：原型在这里铺了一层 #05060a 整屏底色（第 1492~1493 行）来承载页面背景。
       移植成光标层后必须透明，只清除上一帧内容，绝不覆盖宿主页面；
       其后的加法混合与全部绘制逻辑与原文件保持一致。 */
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, s.W, s.H);

    /* 叠加发光 */
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    this._drawGlows(s);        /* 电离通道残影 / 辉光 */
    this._drawRings(s);        /* 电离环 */
    this._drawRingArcs(s);     /* 环形电弧 */
    this._drawTrailPoints(s);  /* 拖尾光点（过曝态） */
    this._drawArcs(s);         /* 电弧 */
    this._drawSparks(s);       /* 电火花 */

    /* 蓄力可视化 */
    if (s.charge.active) {
      if (s.charge.button === 0) this._drawCloudCharge(s);
      else if (s.charge.button === 2) this._drawBall(s);
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}

if (!customElements.get('cursor-lightning')) {
  customElements.define('cursor-lightning', CursorLightning);
}

export default CursorLightning;
