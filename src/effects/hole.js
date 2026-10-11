/**
 * cursor-hole —— 鼠标光标黑洞动效（左键引力坍缩 / 右键霍金辐射）。
 *
 * 由 html/黑洞.html 原型移植：算法流程、数值、视觉表现与原文件一一对应。
 * 作为光标层组件，原型页面自身的行为已剔除：
 *   - 不拦截 contextmenu，宿主页面的右键菜单不受影响（基类统一处理）；
 *   - 画布创建、DPR 适配（封顶 2）、尺寸同步、监听注册、rAF 循环全部由基类负责；
 *   - 离屏光斑纹理用元素自身的 ownerDocument 创建，绝不挂进 DOM；
 *   - render() 开头的 destination-out 整屏 fillRect 是「拖影衰减」（只擦除已有像素的 alpha、
 *     保持画布透明），不是不透明铺底，必须保留 —— 删掉它拖尾会变成永久残影。
 *
 * 原型监听 mousemove / mousedown / mouseup，因此声明 inputFamily = 'mouse'。
 * 所有运行状态（粒子池、黑洞状态机、波 / 光弧 / 残影、各类累加器）都放在 setup() 返回的 state 上，
 * 多实例互不干扰。
 *
 * 速度口径：原型的 mouse.vx / mouse.vy 是「最后一次 mousemove 事件的像素位移」——
 *   既没有除以 dt，也不是基类的平滑值（写入见原型第 851-852 行，读取见第 934-935 行）。
 *   这里用基类的事件级锚点复算原值：s.rawVx = input.x - input.lx（单位：像素，不除 dt）。
 * 锚点口径：原型的 trailAccum 在 mousemove 回调里推进（注册见第 826 行，函数体第 843-865 行），
 *   属于事件级；组件不能注册监听，因此拖尾改为在 update() 里按「整帧位移」推进，
 *   用帧级锚点 input.frameLx / frameLy 作为本帧起点，生成点沿该线段均布（间距仍是 6.5px）。
 */

import { CursorEffectElement } from '../core/base.js';
import { TAU, clamp, lerp, rand, mixColor } from '../core/utils.js';

/* ============================================================
 * 1. CONFIG —— 全部可调参数集中于此（中文注释）
 * ============================================================ */
const CONFIG = {
  /* --- 粒子池 --- */
  maxParticles: 2200,           // 粒子池上限

  /* --- 引力场 --- */
  GM: 2.6e6,                    // 引力常数 × 黑洞质量（a = GM / r²）
  gravityRMin: 12,              // 引力饱和半径：r < rMin 时引力不再增大（避免奇点）
  lensStrength: 5200,           // 引力透镜加速度系数（a = lensStrength / r）—— 原型中未被使用（死配置，原样保留）

  /* --- 事件视界 --- */
  horizonIdle: 6,               // 静止（未蓄力）时的事件视界半径
  horizonMin: 5,                // 右键蒸发时视界最小半径
  horizonMax: 25,               // 左键坍缩时视界默认半径
  horizonMaxGrow: 30,           // 吞噬物质后视界可扩张到的上限
  absorbGrow: 0.02,             // 每吞噬一个粒子视界半径增量

  /* --- 吸积盘 --- */
  diskInnerGap: 5,              // 吸积盘内半径 = 事件视界半径 + 该值
  diskOuterStart: 100,          // 蓄力初期吸积盘外半径
  diskOuterEnd: 250,            // 蓄满时吸积盘外半径
  diskFlatten: 0.42,            // 椭圆扁率（倾斜透视，必须有明确的近端/远端）
  diskCountStart: 50,           // 蓄力初期吸积盘粒子数
  diskCountEnd: 400,            // 蓄满时吸积盘粒子数
  diskKeplerK: 1800,            // 开普勒角速度常数：ω = K / r^1.5
  diskDecayBase: 1.5,           // 轨道衰减基础速率
  diskDecayScale: 1500,         // 轨道衰减半径系数（越靠内衰减越快）

  /* --- 潮汐撕裂 --- */
  tidalRadiusFactor: 3,         // 潮汐半径 = 系数 × 事件视界半径
  tidalStretchScale: 110,       // 拉伸长度系数
  tidalMaxStretch: 60,          // 拉伸断裂阈值（超过则断裂）

  /* --- 光子环 --- */
  photonRingOffset: 2,          // 光子环半径 = 视界半径 + 该值
  photonRingWidth: 2,           // 光子环基础线宽
  photonRingPulseHz: 2,         // 光子环脉动频率（Hz）—— 原型中未被使用（相位按 dt 累加，死配置，原样保留）

  /* --- 霍金辐射 --- */
  hawkingSpeedMin: 100,         // 逃逸辐射粒子最低速度
  hawkingSpeedMax: 300,         // 逃逸辐射粒子最高速度
  virtualPairRateMin: 0.15,     // 虚粒子对产生间隔（蓄力初期，秒）
  virtualPairRateMax: 0.05,     // 虚粒子对产生间隔（蓄满，秒）

  /* --- 相对论喷流 --- */
  jetSpeedMin: 1000,            // 喷流粒子最低速度
  jetSpeedMax: 2000,            // 喷流粒子最高速度
  jetStartCharge: 1.5,          // 蓄力超过该秒数后开始喷流
  jetMaxLength: 400,            // 喷流最大长度

  /* --- 蓄力 --- */
  chargeMax: 2.5,               // 蓄力总时长
  clickThreshold: 0.12,         // 低于该时长视为普通单击

  /* --- 配色：左键（引力坍缩）深空高温组 --- */
  collapseColors: {
    horizon:    '#000000',      // 事件视界：纯黑，绝对不反射任何光
    photonRing: '#FFFFFF',      // 光子环：炽白
    diskInner:  '#FFE8B0',      // 吸积盘内圈：过热金白
    diskMid:    '#FF8C1A',      // 吸积盘中圈：炽橙
    diskOuter:  '#8A1A4A',      // 吸积盘外圈：深红紫
    diskEdge:   '#2A0A2A',      // 吸积盘最外：暗紫黑
    tidal:      '#FF4FD8',      // 潮汐流：品红
    jet:        '#A8D8FF',      // 相对论喷流：冰蓝
    lens:       '#4FE3FF'       // 引力透镜：青
  },

  /* --- 配色：右键（霍金辐射）量子蒸发组 --- */
  evaporateColors: {
    horizon:    '#050510',      // 事件视界：接近黑但带极暗蓝
    photonRing: '#A8E8FF',      // 光子环：淡青白
    virtualPair:'#9B5CFF',      // 虚粒子对：紫
    hawking:    '#3DFFD0',      // 霍金辐射：青绿
    negative:   '#2A0A3A',      // 负能粒子：暗紫
    flash:      '#FFD24A',      // 蒸发闪光：金
    wave:       '#4FE3FF',      // 引力波：青
    lens:       '#FF4FD8'       // 透镜光：品红
  }
};

/* ============================================================
 * 2. 工具函数
 * ============================================================ */
function hex2rgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/* 预解析调色板（避免每帧解析字符串） */
const PAL = {
  collapse: {
    ring:   hex2rgb(CONFIG.collapseColors.photonRing),
    inner:  hex2rgb(CONFIG.collapseColors.diskInner),
    mid:    hex2rgb(CONFIG.collapseColors.diskMid),
    outer:  hex2rgb(CONFIG.collapseColors.diskOuter),
    edge:   hex2rgb(CONFIG.collapseColors.diskEdge),
    tidal:  hex2rgb(CONFIG.collapseColors.tidal),
    jet:    hex2rgb(CONFIG.collapseColors.jet),
    lens:   hex2rgb(CONFIG.collapseColors.lens)
  },
  evap: {
    ring:   hex2rgb(CONFIG.evaporateColors.photonRing),
    hawking:hex2rgb(CONFIG.evaporateColors.hawking),
    neg:    hex2rgb(CONFIG.evaporateColors.negative),
    flash:  hex2rgb(CONFIG.evaporateColors.flash),
    wave:   hex2rgb(CONFIG.evaporateColors.wave),
    lens:   hex2rgb(CONFIG.evaporateColors.lens),
    vpair:  hex2rgb(CONFIG.evaporateColors.virtualPair)
  }
};

/* ============================================================
 * 3. 离屏纹理预渲染（软光斑，用于光子环 / 透镜光弧 / 喷流辉光）
 * 原型用全局 document 创建；移植后改用元素自身的 ownerDocument（s.doc），
 * 既不触碰全局对象，也绝不挂进 DOM。
 * ============================================================ */
function makeGlowTex(doc, r, g, b) {
  const S = 64;
  const c = doc.createElement('canvas');
  c.width = c.height = S;
  const x = c.getContext('2d');
  const gd = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gd.addColorStop(0.00, 'rgba(' + r + ',' + g + ',' + b + ',1)');
  gd.addColorStop(0.28, 'rgba(' + r + ',' + g + ',' + b + ',0.45)');
  gd.addColorStop(0.60, 'rgba(' + r + ',' + g + ',' + b + ',0.12)');
  gd.addColorStop(1.00, 'rgba(' + r + ',' + g + ',' + b + ',0)');
  x.fillStyle = gd;
  x.fillRect(0, 0, S, S);
  return c;
}

function makeGlowSet(doc) {
  return {
    white:   makeGlowTex(doc, 255, 255, 255),
    cyan:    makeGlowTex(doc, 79, 227, 255),
    magenta: makeGlowTex(doc, 255, 79, 216),
    ice:     makeGlowTex(doc, 168, 216, 255),
    hawking: makeGlowTex(doc, 61, 255, 208),
    violet:  makeGlowTex(doc, 155, 92, 255),
    gold:    makeGlowTex(doc, 255, 210, 74)
  };
}

function drawGlow(ctx, tex, x, y, size, alpha) {
  if (alpha <= 0.004) return;
  const a = alpha > 1 ? 1 : alpha;
  ctx.globalAlpha = a;
  const h = size * 0.5;
  ctx.drawImage(tex, x - h, y - h, size, size);
  ctx.globalAlpha = 1;
}

/* ============================================================
 * 4. 粒子池
 * ============================================================ */
const MAXP = CONFIG.maxParticles;

/* 粒子类型 */
const K_TRAIL = 1;   // 鼠标拖尾 / 自由粒子
const K_DISK  = 2;   // 吸积盘粒子（极坐标轨道）
const K_HAWK  = 3;   // 霍金辐射逃逸粒子
const K_VIRT  = 4;   // 量子涨落虚粒子
const K_JET   = 5;   // 相对论喷流粒子
const K_FLASH = 6;   // 短寿命闪光
const K_FRAG  = 7;   // 潮汐碎片

function makeParticle() {
  return {
    active: false, kind: 0,
    x: 0, y: 0, vx: 0, vy: 0,
    baseX: 0, baseY: 0,
    life: 0, maxLife: 1,
    size: 1, alpha: 1,
    cr: 255, cg: 255, cb: 255,
    br: 255, bg: 255, bb: 255,
    tex: null, brighten: true,
    /* 吸积盘极坐标 */
    pr: 0, theta: 0, omega: 0,
    /* 潮汐拉伸 / 拖尾 */
    stretch: 0, trail: 0,
    /* 喷流螺旋 */
    phase: 0, spin: 0
  };
}

function getFree(s) {
  const particles = s.particles;
  for (let i = 0; i < MAXP; i++) {
    const idx = (s.poolCursor + i) % MAXP;
    const p = particles[idx];
    if (!p.active) {
      s.poolCursor = (idx + 1) % MAXP;
      return p;
    }
  }
  return null;
}

function spawnParticle(s, kind, x, y, vx, vy, life, size, col, tex) {
  const p = getFree(s);
  if (!p) return null;
  p.active = true;
  p.kind = kind;
  p.x = x; p.y = y;
  p.baseX = x; p.baseY = y;
  p.vx = vx; p.vy = vy;
  p.life = 0; p.maxLife = life;
  p.size = size;
  p.alpha = 1;
  p.cr = col[0]; p.cg = col[1]; p.cb = col[2];
  p.br = col[0]; p.bg = col[1]; p.bb = col[2];
  p.tex = tex || null;
  p.brighten = true;
  p.stretch = 0;
  p.trail = 0;
  p.pr = 0; p.theta = 0; p.omega = 0;
  p.phase = 0; p.spin = 0;
  return p;
}

/* ============================================================
 * 5. 引力场系统
 * ============================================================ */
function applyGravity(p, dt, cx, cy, extraMul) {
  let dx = cx - p.x;
  let dy = cy - p.y;
  let r2 = dx * dx + dy * dy;
  if (r2 < 1) r2 = 1;
  const r = Math.sqrt(r2);

  /* 引力饱和：r < rMin 时不再增大，避免中心奇点 */
  const rs = r < CONFIG.gravityRMin ? CONFIG.gravityRMin : r;
  let acc = CONFIG.GM / (rs * rs);
  if (extraMul) acc *= extraMul;

  p.vx += (dx / r) * acc * dt;
  p.vy += (dy / r) * acc * dt;
}

/* ============================================================
 * 6. 事件视界系统
 * ============================================================ */
function absorbParticle(s, p) {
  const bh = s.bh;
  const ang = Math.atan2(p.y - bh.y, p.x - bh.x);
  const fx = bh.x + Math.cos(ang) * bh.R;
  const fy = bh.y + Math.sin(ang) * bh.R;
  spawnFlash(s, fx, fy, rand(1.5, 3.5), 0.1, [255, 255, 255], s.glow.white);
  p.active = false;

  if (bh.mode === 'collapse' && bh.R < CONFIG.horizonMaxGrow) {
    bh.targetR = Math.min(bh.targetR + CONFIG.absorbGrow, CONFIG.horizonMaxGrow);
  }
}

function spawnFlash(s, x, y, size, life, col, tex) {
  const p = getFree(s);
  if (!p) return;
  p.active = true;
  p.kind = K_FLASH;
  p.x = x; p.y = y;
  p.baseX = x; p.baseY = y;
  p.vx = 0; p.vy = 0;
  p.life = 0; p.maxLife = life;
  p.size = size;
  p.alpha = 1;
  p.cr = col[0]; p.cg = col[1]; p.cb = col[2];
  p.br = col[0]; p.bg = col[1]; p.bb = col[2];
  p.tex = tex || s.glow.white;
  p.brighten = false;
  p.stretch = 0; p.trail = 0;
  p.pr = 0; p.theta = 0; p.omega = 0;
  p.phase = 0; p.spin = 0;
}

/* ============================================================
 * 7. 吸积盘系统
 * ============================================================ */
function diskColorAt(t) {
  /* t: 0 = 内圈（白热），1 = 最外（暗紫黑） */
  const P = PAL.collapse;
  if (t < 0.34) return mixColor(P.inner, P.mid, t / 0.34);
  if (t < 0.67) return mixColor(P.mid, P.outer, (t - 0.34) / 0.33);
  return mixColor(P.outer, P.edge, (t - 0.67) / 0.33);
}

function spawnDiskParticles(s, charge) {
  const bh = s.bh;
  const particles = s.particles;
  const k = clamp(charge / CONFIG.chargeMax, 0, 1);
  const target = Math.round(lerp(CONFIG.diskCountStart, CONFIG.diskCountEnd, k));

  let count = 0;
  for (let i = 0; i < MAXP; i++) {
    if (particles[i].active && particles[i].kind === K_DISK) count++;
  }
  if (count >= target) return;

  const outer = lerp(CONFIG.diskOuterStart, CONFIG.diskOuterEnd, k);
  const inner = bh.R + CONFIG.diskInnerGap;
  const toSpawn = Math.min(7, target - count);

  for (let i = 0; i < toSpawn; i++) {
    const p = getFree(s);
    if (!p) return;

    const pr = inner + Math.pow(Math.random(), 0.75) * Math.max(1, outer - inner);
    const theta = Math.random() * TAU;

    p.active = true;
    p.kind = K_DISK;
    p.pr = pr;
    p.theta = theta;
    p.omega = CONFIG.diskKeplerK / Math.pow(Math.max(pr, 10), 1.5);
    p.x = bh.x + Math.cos(theta) * pr;
    p.y = bh.y + Math.sin(theta) * pr * CONFIG.diskFlatten;
    p.baseX = p.x; p.baseY = p.y;
    p.vx = 0; p.vy = 0;
    p.life = 0;
    p.maxLife = 9999;
    p.size = rand(1, 3);
    p.alpha = 1;
    p.stretch = 0;
    p.trail = 0;
    p.brighten = false;
    p.tex = s.glow.white;

    const t = clamp((pr - inner) / Math.max(1, outer - inner), 0, 1);
    const c = diskColorAt(t);
    p.cr = c[0]; p.cg = c[1]; p.cb = c[2];
    p.br = c[0]; p.bg = c[1]; p.bb = c[2];
  }
}

function updateDisk(s, p, dt) {
  const bh = s.bh;

  /* 开普勒角速度 ω ∝ r^(-1.5) */
  p.omega = CONFIG.diskKeplerK / Math.pow(Math.max(p.pr, 10), 1.5);
  p.theta += p.omega * dt;

  /* 轨道衰减：越靠内衰减越快，形成螺旋坠落 */
  const decay = CONFIG.diskDecayBase + CONFIG.diskDecayScale / Math.max(p.pr, 15);
  p.pr -= decay * dt;

  /* 投影到椭圆轨道（倾斜吸积盘） */
  const cs = Math.cos(p.theta), sn = Math.sin(p.theta);
  p.x = bh.x + cs * p.pr;
  p.y = bh.y + sn * p.pr * CONFIG.diskFlatten;

  /* 越过事件视界 → 立即吞噬 */
  if (p.pr <= bh.R * 0.92) {
    absorbParticle(s, p);
    return;
  }

  /* 拖尾长度：随轨道线速度增大（内圈极快 → 拖尾极长） */
  const v = Math.abs(p.pr * p.omega);
  p.trail = clamp(v * 0.055, 4, 22);

  /* 潮汐撕裂（见潮汐撕裂系统） */
  tidalTick(s, p);
}

/* ============================================================
 * 8. 潮汐撕裂系统
 * ============================================================ */
function tidalTick(s, p) {
  const bh = s.bh;
  const tidalR = bh.R * CONFIG.tidalRadiusFactor;
  if (p.pr < tidalR) {
    const t = 1 - p.pr / tidalR;                 /* 越靠近越大 */
    p.stretch = t * CONFIG.tidalStretchScale;

    if (p.stretch > CONFIG.tidalMaxStretch) {
      splitDiskParticle(s, p);
    }
  } else if (p.stretch > 0) {
    p.stretch *= Math.pow(0.02, 0.016);
    if (p.stretch < 0.5) p.stretch = 0;
  }
}

function splitDiskParticle(s, p) {
  const bh = s.bh;
  const n = 2 + (Math.random() < 0.4 ? 1 : 0);
  const tidal = PAL.collapse.tidal;

  for (let i = 0; i < n; i++) {
    const c = getFree(s);
    if (!c) break;

    c.active = true;
    c.kind = K_FRAG;
    c.x = p.x + rand(-3, 3);
    c.y = p.y + rand(-3, 3);
    c.baseX = c.x; c.baseY = c.y;

    const dx = bh.x - p.x, dy = bh.y - p.y;
    const d = Math.hypot(dx, dy) || 1;
    const sp = rand(70, 200);
    c.vx = (dx / d) * sp + rand(-35, 35);
    c.vy = (dy / d) * sp + rand(-35, 35);

    c.life = 0;
    c.maxLife = rand(0.5, 1.1);
    c.size = rand(0.8, 1.8);
    c.alpha = 1;
    c.stretch = rand(18, 40);
    c.trail = 0;
    c.brighten = false;
    c.tex = s.glow.magenta;
    c.cr = tidal[0]; c.cg = tidal[1]; c.cb = tidal[2];
    c.br = tidal[0]; c.bg = tidal[1]; c.bb = tidal[2];
    c.pr = 0; c.theta = 0; c.omega = 0;
  }
  p.active = false;
}

function updateFrag(s, p, dt) {
  updateTrail(s, p, dt);
  if (!p.active) return;
  p.stretch = Math.max(0, p.stretch - 45 * dt);
}

/* ============================================================
 * 9. 光子环系统
 * ============================================================ */
function drawPhotonRing(s) {
  const ctx = s.ctx;
  const bh = s.bh;
  if (bh.R < 1.5) return;

  let bright = bh.photon;
  if (bh.overexpose > 0) bright = Math.max(bright, bh.overexpose);

  if (bright < 0.02) return;

  const isEvap = bh.mode === 'evaporate';
  const ringCol = isEvap ? PAL.evap.ring : PAL.collapse.ring;

  /* 脉动线宽 1.5 ~ 3 px，频率约 2Hz */
  const puls = Math.sin(bh.pulseT * TAU) * 0.5 + 0.5;
  let w = CONFIG.photonRingWidth + puls * 1.2;
  if (bh.overexpose > 0) w += bh.overexpose * 4;

  const R = bh.R + CONFIG.photonRingOffset;
  const cr = ringCol[0], cg = ringCol[1], cb = ringCol[2];

  /* 外发光 */
  ctx.strokeStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',' + (bright * 0.16) + ')';
  ctx.lineWidth = w * 4.5;
  ctx.beginPath();
  ctx.arc(bh.x, bh.y, R, 0, TAU);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',' + (bright * 0.45) + ')';
  ctx.lineWidth = w * 2.1;
  ctx.beginPath();
  ctx.arc(bh.x, bh.y, R, 0, TAU);
  ctx.stroke();

  /* 主环 */
  ctx.strokeStyle = 'rgba(255,255,255,' + (bright * 0.95) + ')';
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.arc(bh.x, bh.y, R, 0, TAU);
  ctx.stroke();

  /* 软光斑沿环分布 */
  const spots = 8;
  for (let i = 0; i < spots; i++) {
    const a = (i / spots) * TAU + bh.pulseT * 0.6;
    const gx = bh.x + Math.cos(a) * R;
    const gy = bh.y + Math.sin(a) * R;
    drawGlow(ctx, s.glow.white, gx, gy, 16 + puls * 6, bright * 0.22);
  }
}

/* ============================================================
 * 10. 引力透镜系统
 * ============================================================ */
function doLensPulse(s) {
  s.lensPulse.t = s.lensPulse.dur;
}

function updateLensPulse(s, dt) {
  const lp = s.lensPulse;
  if (lp.t > 0) {
    lp.t -= dt;
    if (lp.t < 0) lp.t = 0;
  }
}

/* 透镜光弧：由点阵构成的弯曲光线 */
function addArc(s, cx, cy, r, a0, sweep, life, col) {
  if (s.arcs.length > 140) return;
  s.arcs.push({
    cx: cx, cy: cy, r: r,
    a0: a0, sweep: sweep,
    life: 0, maxLife: life,
    cr: col[0], cg: col[1], cb: col[2]
  });
}

function updateArcs(s, dt) {
  const arcs = s.arcs;
  for (let i = arcs.length - 1; i >= 0; i--) {
    const a = arcs[i];
    a.life += dt;
    if (a.life >= a.maxLife) arcs.splice(i, 1);
  }
}

function drawArcs(s) {
  const ctx = s.ctx;
  const arcs = s.arcs;
  for (let i = 0; i < arcs.length; i++) {
    const a = arcs[i];
    const t = a.life / a.maxLife;
    const alpha = (1 - t) * (1 - t) * 0.85;
    if (alpha < 0.01) continue;

    const steps = 14;
    ctx.fillStyle = 'rgba(' + (a.cr | 0) + ',' + (a.cg | 0) + ',' + (a.cb | 0) + ',' + alpha + ')';

    for (let k = 0; k <= steps; k++) {
      const ang = a.a0 + a.sweep * (k / steps);
      const px = a.cx + Math.cos(ang) * a.r;
      const py = a.cy + Math.sin(ang) * a.r;
      ctx.beginPath();
      ctx.arc(px, py, 1.3, 0, TAU);
      ctx.fill();
    }

    /* 弧线整体辉光（少量） */
    if (i % 3 === 0) {
      const mid = a.a0 + a.sweep * 0.5;
      drawGlow(ctx, s.glow.cyan, a.cx + Math.cos(mid) * a.r, a.cy + Math.sin(mid) * a.r, 22, alpha * 0.25);
    }
  }
}

function spawnLensArcStorm(s, x, y, power, col) {
  const n = Math.floor(20 + 60 * power);
  for (let i = 0; i < n; i++) {
    const ang = Math.random() * TAU;
    const r = rand(35, 300);
    const cx = x + Math.cos(ang) * r * 0.45;
    const cy = y + Math.sin(ang) * r * 0.45;
    addArc(s, cx, cy, r, ang + rand(0.5, 1.5), rand(0.7, 2.0), rand(0.4, 0.7), col);
  }
}

/* ============================================================
 * 11. 霍金辐射系统
 * ============================================================ */
function spawnVirtualPairTick(s, dt, k) {
  const bh = s.bh;
  const interval = lerp(CONFIG.virtualPairRateMin, CONFIG.virtualPairRateMax, k);
  s.vpAccum += dt;
  let guard = 0;

  while (s.vpAccum >= interval && guard < 8) {
    guard++;
    s.vpAccum -= interval;

    const ang = Math.random() * TAU;
    const rx = bh.x + Math.cos(ang) * bh.R;
    const ry = bh.y + Math.sin(ang) * bh.R;

    /* 产生瞬间的紫色闪光 */
    spawnFlash(s, rx, ry, rand(1.5, 3), 0.09, PAL.evap.vpair, s.glow.violet);

    /* 逃逸粒子（青绿，霍金辐射） */
    const esc = getFree(s);
    if (esc) {
      const sp = rand(CONFIG.hawkingSpeedMin, CONFIG.hawkingSpeedMax);
      esc.active = true;
      esc.kind = K_HAWK;
      esc.x = rx; esc.y = ry;
      esc.baseX = rx; esc.baseY = ry;
      esc.vx = Math.cos(ang) * sp;
      esc.vy = Math.sin(ang) * sp;
      esc.life = 0;
      esc.maxLife = rand(1, 2);
      esc.size = rand(1, 2);
      esc.alpha = 1;
      esc.cr = PAL.evap.hawking[0];
      esc.cg = PAL.evap.hawking[1];
      esc.cb = PAL.evap.hawking[2];
      esc.br = esc.cr; esc.bg = esc.cg; esc.bb = esc.cb;
      esc.tex = s.glow.hawking;
      esc.brighten = false;
      esc.stretch = 0; esc.trail = 0;
      esc.pr = 0; esc.theta = 0; esc.omega = 0;
      esc.phase = 0; esc.spin = 0;
    }

    /* 负能粒子（暗紫，落入黑洞） */
    const neg = getFree(s);
    if (neg) {
      const sp = rand(40, 120);
      neg.active = true;
      neg.kind = K_TRAIL;
      neg.x = rx; neg.y = ry;
      neg.baseX = rx; neg.baseY = ry;
      const toC = Math.atan2(bh.y - ry, bh.x - rx);
      neg.vx = Math.cos(toC) * sp + Math.cos(ang + 1.4) * 60;
      neg.vy = Math.sin(toC) * sp + Math.sin(ang + 1.4) * 60;
      neg.life = 0;
      neg.maxLife = rand(0.5, 1.0);
      neg.size = rand(0.8, 1.6);
      neg.alpha = 0.9;
      neg.cr = PAL.evap.neg[0];
      neg.cg = PAL.evap.neg[1];
      neg.cb = PAL.evap.neg[2];
      neg.br = neg.cr; neg.bg = neg.cg; neg.bb = neg.cb;
      neg.tex = s.glow.violet;
      neg.brighten = false;
      neg.stretch = 0; neg.trail = 0;
      neg.pr = 0; neg.theta = 0; neg.omega = 0;
      neg.phase = 0; neg.spin = 0;
    }
  }
}

/* 量子真空涨落：极短寿命的虚粒子 */
function spawnQuantumFoam(s, dt, k) {
  const bh = s.bh;
  const rate = lerp(5, 50, k);
  s.foamAccum += dt * rate;
  let guard = 0;
  while (s.foamAccum >= 1 && guard < 10) {
    guard++;
    s.foamAccum -= 1;

    const ang = Math.random() * TAU;
    const d = rand(100, 200);
    const fx = bh.x + Math.cos(ang) * d;
    const fy = bh.y + Math.sin(ang) * d;

    const p = getFree(s);
    if (!p) break;
    p.active = true;
    p.kind = K_VIRT;
    p.x = fx; p.y = fy;
    p.baseX = fx; p.baseY = fy;
    p.vx = 0; p.vy = 0;
    p.life = 0;
    p.maxLife = 0.05;
    p.size = rand(0.5, 1);
    p.alpha = rand(0.3, 0.6);
    p.cr = PAL.evap.neg[0];
    p.cg = PAL.evap.neg[1];
    p.cb = PAL.evap.neg[2];
    p.br = p.cr; p.bg = p.cg; p.bb = p.cb;
    p.tex = s.glow.violet;
    p.brighten = false;
    p.stretch = 0; p.trail = 0;
    p.pr = 0; p.theta = 0; p.omega = 0;
    p.phase = 0; p.spin = 0;
  }
}

/* ============================================================
 * 12. 相对论喷流系统
 * ============================================================ */
function spawnJetStream(s, dt, charge) {
  const bh = s.bh;
  const k = clamp((charge - CONFIG.jetStartCharge) / (CONFIG.chargeMax - CONFIG.jetStartCharge), 0, 1);
  s.jetAccum += dt * (35 + 110 * k);
  let guard = 0;

  while (s.jetAccum >= 1 && guard < 12) {
    guard++;
    s.jetAccum -= 1;

    for (let sgn = -1; sgn <= 1; sgn += 2) {
      const p = getFree(s);
      if (!p) return;
      p.active = true;
      p.kind = K_JET;
      p.x = bh.x + rand(-2, 2);
      p.y = bh.y + sgn * rand(0, 5);
      p.baseX = p.x;
      p.baseY = p.y;
      p.vx = 0;
      p.vy = sgn * rand(CONFIG.jetSpeedMin, CONFIG.jetSpeedMax);
      p.life = 0;
      p.maxLife = rand(0.22, 0.45);
      p.size = rand(1, 2);
      p.alpha = 0.95;
      p.cr = 255; p.cg = 255; p.cb = 255;
      p.br = 255; p.bg = 255; p.bb = 255;
      p.tex = s.glow.ice;
      p.brighten = false;
      p.stretch = 0; p.trail = 0;
      p.pr = 0; p.theta = 0; p.omega = 0;
      p.phase = rand(0, TAU);
      p.spin = rand(9, 18);
    }
  }
}

function updateJet(s, p, dt) {
  const bh = s.bh;
  p.y += p.vy * dt;
  p.phase += p.spin * dt;

  /* 轻微螺旋：横向摆动幅度随轴向距离增大 */
  const dist = Math.abs(p.y - bh.y);
  const amp = Math.min(70, dist * 0.16);
  p.x = p.baseX + Math.sin(p.phase) * amp;
}

function spawnJetBurst(s, power, x, y) {
  const count = Math.floor(100 + 200 * power);
  const speed = 2000 + 1000 * power;

  for (let sgn = -1; sgn <= 1; sgn += 2) {
    for (let i = 0; i < count; i++) {
      const p = getFree(s);
      if (!p) return;
      const sp = speed * rand(0.75, 1.25);
      p.active = true;
      p.kind = K_JET;
      p.x = x + rand(-4, 4);
      p.y = y + sgn * rand(0, 8);
      p.baseX = p.x;
      p.baseY = p.y;
      p.vx = 0;
      p.vy = sgn * sp;
      p.life = 0;
      p.maxLife = rand(0.3, 0.6);
      p.size = rand(1, 2.2);
      p.alpha = 1;
      p.cr = 255; p.cg = 255; p.cb = 255;
      p.br = 255; p.bg = 255; p.bb = 255;
      p.tex = s.glow.ice;
      p.brighten = false;
      p.stretch = 0; p.trail = 0;
      p.pr = 0; p.theta = 0; p.omega = 0;
      p.phase = rand(0, TAU);
      p.spin = rand(10, 22);
    }
  }
}

/* ============================================================
 * 13. 拖尾（鼠标轨迹粒子）
 * ============================================================ */
function spawnTrailParticle(s, x, y) {
  const p = getFree(s);
  if (!p) return;

  p.active = true;
  p.kind = K_TRAIL;
  p.x = x; p.y = y;
  p.baseX = x; p.baseY = y;

  /* 继承部分鼠标速度 → 形成被引力弯曲的弧线轨迹
     原型第 934-935 行用的是「最后一次 mousemove 的像素位移」（未除 dt），
     这里取事件级锚点复算的 s.rawVx / s.rawVy，数值口径完全一致 */
  p.vx = s.rawVx * rand(0.08, 0.35) + rand(-28, 28);
  p.vy = s.rawVy * rand(0.08, 0.35) + rand(-28, 28);

  p.life = 0;
  p.maxLife = rand(2, 4);
  p.size = rand(1, 3);
  p.alpha = 1;

  /* 深空冷色：青 → 冰蓝，偶发品红 */
  let col;
  if (Math.random() < 0.16) {
    col = PAL.collapse.tidal;
    p.tex = s.glow.magenta;
  } else if (Math.random() < 0.5) {
    col = PAL.collapse.lens;
    p.tex = s.glow.cyan;
  } else {
    col = PAL.collapse.jet;
    p.tex = s.glow.ice;
  }

  p.cr = col[0]; p.cg = col[1]; p.cb = col[2];
  p.br = col[0]; p.bg = col[1]; p.bb = col[2];
  p.brighten = true;
  p.stretch = 0;
  p.trail = 0;
  p.pr = 0; p.theta = 0; p.omega = 0;
  p.phase = 0; p.spin = 0;
}

function updateTrail(s, p, dt) {
  const bh = s.bh;
  const lp = s.lensPulse;

  /* 引力透镜脉冲：5 倍引力 + 切向弯曲（绕过黑洞而非被推开） */
  let mul = 1;
  if (lp.t > 0) {
    const dx = bh.x - p.x, dy = bh.y - p.y;
    const r = Math.hypot(dx, dy) || 1;
    if (r < lp.radius) {
      const k = 1 - r / lp.radius;
      mul = 1 + k * 4;

      /* 切向分量：让轨迹被强烈弯曲成弧线 */
      const tx = -dy / r;
      const ty = dx / r;
      const sign = (dx * p.vy - dy * p.vx) > 0 ? 1 : -1;
      const tang = 700 * k * sign;
      p.vx += tx * tang * dt;
      p.vy += ty * tang * dt;
    }
  }

  applyGravity(p, dt, bh.x, bh.y, mul);

  p.x += p.vx * dt;
  p.y += p.vy * dt;

  /* 越过事件视界 → 立即消失 */
  const ddx = p.x - bh.x;
  const ddy = p.y - bh.y;
  if (ddx * ddx + ddy * ddy < bh.R * bh.R) {
    absorbParticle(s, p);
    return;
  }

  /* 靠近黑洞时被引力加速 → 颜色越来越亮（向白色偏移） */
  if (p.brighten) {
    const r = Math.hypot(ddx, ddy);
    const t = clamp(1 - r / 260, 0, 1);
    const tt = t * t;
    p.cr = lerp(p.br, 255, tt);
    p.cg = lerp(p.bg, 255, tt);
    p.cb = lerp(p.bb, 255, tt);
  }
}

/* 拖尾生成：原型在 mousemove 回调里按事件推进 trailAccum（第 856-864 行），
   组件不能注册监听，改为在 update() 里按整帧位移推进；
   spacing / guard / 60 的复位阈值全部原样保留，生成点沿本帧位移线段均布。 */
function emitTrail(s) {
  const M = s.input;
  const dx = M.x - M.frameLx;
  const dy = M.y - M.frameLy;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.05) return;

  s.trailAccum += dist;
  const spacing = 6.5;
  const n = Math.min(8, Math.floor(s.trailAccum / spacing));
  if (n > 0) {
    s.trailAccum -= n * spacing;
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 1 : (i + 1) / n;
      spawnTrailParticle(s, M.frameLx + dx * t + rand(-5, 5), M.frameLy + dy * t + rand(-5, 5));
    }
  }
  if (s.trailAccum > 60) s.trailAccum = 0;
}

/* ============================================================
 * 14. 单击（左键按下瞬间的引力脉冲）
 * ============================================================ */
function doClickPulse(s, x, y) {
  /* 引力波（圆形，半径 5 → 100，0.3s） */
  addWave(s, x, y, 100, 0.3, PAL.collapse.lens, 0, 0);

  /* 视界闪点 */
  spawnFlash(s, x, y, 5, 0.1, [255, 255, 255], s.glow.white);

  /* 生成 10~16 个粒子，立刻被引力吸引 */
  const n = 10 + Math.floor(Math.random() * 7);
  for (let i = 0; i < n; i++) {
    const ang = Math.random() * TAU;
    const d = rand(60, 120);
    const px = x + Math.cos(ang) * d;
    const py = y + Math.sin(ang) * d;

    /* 切向初速度 → 形成小吸积盘 */
    const tang = ang + Math.PI * 0.5 * (Math.random() < 0.5 ? 1 : -1);
    const sp = rand(40, 120);
    const col = Math.random() < 0.5 ? PAL.collapse.lens : PAL.collapse.jet;
    const p = spawnParticle(
      s, K_TRAIL, px, py,
      Math.cos(tang) * sp, Math.sin(tang) * sp,
      rand(2, 4), rand(2, 4), col,
      Math.random() < 0.5 ? s.glow.cyan : s.glow.ice
    );
    if (!p) break;
  }
}

/* 右键短按：小型快速蒸发 */
function doRightPulse(s, x, y) {
  spawnFlash(s, x, y, 4, 0.08, PAL.evap.vpair, s.glow.violet);
}

/* ============================================================
 * 15. 左键坍缩（引力坍缩 / Collapse）
 * ============================================================ */
function doCollapseBurst(s, power) {
  const bh = s.bh;
  s.burst = {
    type: 'collapse',
    t: 0,
    power: power,
    x: bh.x,
    y: bh.y,
    step: 0
  };
  bh.frozen = 0.03;      /* 静止一帧 */
  bh.overexpose = 0;     /* 由时间轴驱动 */
  bh.targetR = bh.R;
}

function ejectDisk(s, power) {
  const particles = s.particles;
  const spd = 400 + 1200 * power;
  for (let i = 0; i < MAXP; i++) {
    const p = particles[i];
    if (!p.active || p.kind !== K_DISK) continue;

    /* 切线方向甩出（保留原有圆周运动方向） */
    const sgn = p.omega >= 0 ? 1 : -1;
    let tx = -Math.sin(p.theta) * sgn;
    let ty = Math.cos(p.theta) * CONFIG.diskFlatten * sgn;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl; ty /= tl;

    p.kind = K_TRAIL;
    p.vx = tx * spd;
    p.vy = ty * spd;
    p.life = 0;
    p.maxLife = rand(1.2, 2.0);
    p.stretch = Math.max(p.stretch, 0);
    p.brighten = true;
    p.trail = 0;
  }
}

function spawnTidalDebris(s, power) {
  const bh = s.bh;
  const tidal = PAL.collapse.tidal;
  const n = Math.floor(20 + 40 * power);
  for (let i = 0; i < n; i++) {
    const ang = Math.random() * TAU;
    const d = rand(30, 90);
    const x = bh.x + Math.cos(ang) * d;
    const y = bh.y + Math.sin(ang) * d;
    const sp = rand(300, 800);
    const p = spawnParticle(
      s, K_FRAG, x, y,
      Math.cos(ang) * sp, Math.sin(ang) * sp,
      rand(0.6, 0.9), rand(1, 2.2), tidal, s.glow.magenta
    );
    if (!p) return;
    p.stretch = rand(30, 70);
    p.brighten = false;
  }
}

/* ============================================================
 * 16. 右键蒸发（霍金辐射 / Evaporation）
 * ============================================================ */
function doSmallEvaporation(s, x, y) {
  spawnFlash(s, x, y, 8, 0.12, PAL.evap.flash, s.glow.gold);
  addWave(s, x, y, 80, 0.4, PAL.evap.wave, 0, 0);

  const n = 24;
  for (let i = 0; i < n; i++) {
    const ang = Math.random() * TAU;
    const sp = rand(120, 340);
    const p = spawnParticle(
      s, K_HAWK, x, y,
      Math.cos(ang) * sp, Math.sin(ang) * sp,
      rand(0.8, 1.6), rand(1, 2),
      PAL.evap.hawking, s.glow.hawking
    );
    if (!p) break;
    p.brighten = false;
  }
}

function doEvaporationBurst(s, power) {
  const bh = s.bh;
  s.burst = {
    type: 'evaporate',
    t: 0,
    power: power,
    x: bh.x,
    y: bh.y,
    step: 0
  };
  bh.frozen = 0.03;
  bh.targetR = bh.R;
}

/* 量子蒸发波：虚粒子对组成的环形波，扩散中被撕开 */
function spawnEvapWave(s, x, y, power) {
  const pairs = Math.floor(60 + 120 * power);
  const maxR = 150 + 400 * power;

  for (let i = 0; i < pairs; i++) {
    const ang = (i / pairs) * TAU + rand(-0.03, 0.03);
    const sp = rand(140, 320) * (0.8 + 0.5 * power);
    const spNeg = sp * rand(0.15, 0.4);

    /* 逃逸的青绿粒子（向外飞得更快） */
    const a = spawnParticle(
      s, K_HAWK, x, y,
      Math.cos(ang) * sp, Math.sin(ang) * sp,
      rand(0.8, 1.6), rand(1, 2),
      PAL.evap.hawking, s.glow.hawking
    );
    if (a) a.brighten = false;

    /* 暗紫负能粒子（向内/原地消失） */
    const b = spawnParticle(
      s, K_TRAIL, x, y,
      Math.cos(ang) * spNeg, Math.sin(ang) * spNeg,
      rand(0.4, 0.9), rand(0.8, 1.5),
      PAL.evap.neg, s.glow.violet
    );
    if (b) {
      b.brighten = false;
      b.alpha = 0.75;
    }
  }

  /* 视觉最大半径由波对象表现 */
  addWave(s, x, y, maxR, 0.9, PAL.evap.wave, 2, 14);
}

function spawnHawkingStorm(s, x, y, power) {
  const n = Math.floor(100 + 300 * power);
  const spd = 200 + 600 * power;
  for (let i = 0; i < n; i++) {
    const ang = Math.random() * TAU;
    const sp = spd * rand(0.6, 1.4);
    const p = spawnParticle(
      s, K_HAWK, x, y,
      Math.cos(ang) * sp, Math.sin(ang) * sp,
      rand(0.6, 1.5), rand(1, 2),
      PAL.evap.hawking, s.glow.hawking
    );
    if (!p) return;
    p.brighten = false;
  }
}

/* ============================================================
 * 17. 波 / 涟漪系统
 * ============================================================ */
function addWave(s, x, y, maxR, life, col, type, amp) {
  if (s.waves.length > 40) return;
  s.waves.push({
    x: x, y: y,
    r: 0, maxR: maxR,
    life: 0, maxLife: life,
    cr: col[0], cg: col[1], cb: col[2],
    type: type || 0,          /* 0 = 普通引力波, 2 = 时空涟漪 */
    amp: amp || 0,
    phase: Math.random() * TAU
  });
}

function updateWaves(s, dt) {
  const waves = s.waves;
  for (let i = waves.length - 1; i >= 0; i--) {
    const w = waves[i];
    w.life += dt;
    if (w.life >= w.maxLife) {
      waves.splice(i, 1);
      continue;
    }
    const t = w.life / w.maxLife;
    w.r = w.maxR * (1 - Math.pow(1 - t, 2));
  }
}

function drawWaves(s) {
  const ctx = s.ctx;
  const waves = s.waves;
  for (let i = 0; i < waves.length; i++) {
    const w = waves[i];
    const t = w.life / w.maxLife;
    const alpha = (1 - t) * (1 - t) * 0.85;

    if (w.type === 2) {
      /* 时空涟漪：多重形变同心圆 + 径向网格线 */
      ctx.strokeStyle = 'rgba(' + (w.cr | 0) + ',' + (w.cg | 0) + ',' + (w.cb | 0) + ',' + (alpha * 0.35) + ')';
      ctx.lineWidth = 1;

      const rings = 3;
      for (let k = 0; k < rings; k++) {
        const rr = w.r * (1 - k * 0.22);
        if (rr < 4) continue;
        ctx.beginPath();
        const N = 56;
        for (let j = 0; j <= N; j++) {
          const ang = (j / N) * TAU;
          const wob = Math.sin(ang * 5 + w.phase + k) * w.amp * (1 - t) * 0.8;
          const px = w.x + Math.cos(ang) * (rr + wob);
          const py = w.y + Math.sin(ang) * (rr + wob);
          if (j === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
      }

      /* 径向网格线 */
      const spokes = 14;
      ctx.beginPath();
      for (let j = 0; j < spokes; j++) {
        const ang = (j / spokes) * TAU + w.phase * 0.2;
        const outer = w.r;
        const inner = Math.max(0, w.r * 0.25);
        const wob = Math.sin(ang * 3 + w.phase) * w.amp * (1 - t) * 0.5;
        ctx.moveTo(w.x + Math.cos(ang) * inner, w.y + Math.sin(ang) * inner);
        ctx.lineTo(w.x + Math.cos(ang) * (outer + wob), w.y + Math.sin(ang) * (outer + wob));
      }
      ctx.stroke();
    } else {
      /* 普通引力波：形变同心圆 */
      ctx.strokeStyle = 'rgba(' + (w.cr | 0) + ',' + (w.cg | 0) + ',' + (w.cb | 0) + ',' + alpha + ')';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      const N = 72;
      const amp = w.amp || (2 + 4 * (1 - t));
      for (let j = 0; j <= N; j++) {
        const ang = (j / N) * TAU;
        const wob = Math.sin(ang * 6 + w.phase) * amp * (1 - t);
        const px = w.x + Math.cos(ang) * (w.r + wob);
        const py = w.y + Math.sin(ang) * (w.r + wob);
        if (j === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }
}

/* 视界残影 */
function addAfterimage(s, x, y, r, life) {
  s.afterimages.push({ x: x, y: y, r: r, life: 0, maxLife: life });
}

function updateAfterimages(s, dt) {
  const afterimages = s.afterimages;
  for (let i = afterimages.length - 1; i >= 0; i--) {
    const a = afterimages[i];
    a.life += dt;
    if (a.life >= a.maxLife) afterimages.splice(i, 1);
  }
}

function drawAfterimages(s) {
  const ctx = s.ctx;
  const afterimages = s.afterimages;
  for (let i = 0; i < afterimages.length; i++) {
    const a = afterimages[i];
    const t = a.life / a.maxLife;
    const r = a.r * (1 - t);
    if (r < 0.5) continue;
    ctx.fillStyle = 'rgba(0,0,0,0.92)';
    ctx.beginPath();
    ctx.arc(a.x, a.y, r, 0, TAU);
    ctx.fill();
  }
}

/* ============================================================
 * 18. 爆发时间轴
 * ============================================================ */
function updateBurst(s, dt) {
  const bh = s.bh;
  if (!s.burst) return;
  const b = s.burst;
  b.t += dt;
  const x = b.x, y = b.y, pw = b.power;

  if (b.type === 'collapse') {
    /* 0.04s：光子环过曝 */
    if (b.step === 0 && b.t >= 0.04) {
      b.step = 1;
      bh.overexpose = 1;
      bh.x = x; bh.y = y;
    }
    /* 0.08s：内爆一帧 + 全面爆发 */
    if (b.step === 1 && b.t >= 0.08) {
      b.step = 2;
      bh.targetR = 0;

      ejectDisk(s, pw);
      spawnJetBurst(s, pw, x, y);
      spawnTidalDebris(s, pw);
      spawnLensArcStorm(s, x, y, pw, PAL.collapse.lens);

      /* 引力波 2~3 层 */
      const layers = 2 + Math.floor(Math.random() * 2);
      for (let i = 0; i < layers; i++) {
        addWave(s, x, y, 200 + 500 * pw, 0.8, PAL.collapse.lens, 0, 6 + i * 3);
      }

      addAfterimage(s, x, y, 30 + 45 * pw, 1.0);
    }
    if (b.t > 1.6) {
      bh.overexpose = 0;
      s.burst = null;
    }
  } else {
    /* 右键蒸发 */
    if (b.step === 0 && b.t >= 0.04) {
      b.step = 1;
      bh.overexpose = 1;
      bh.x = x; bh.y = y;
      /* 蒸发闪光 */
      spawnFlash(s, x, y, 26, 0.15, [255, 255, 255], s.glow.white);
      spawnFlash(s, x, y, 44, 0.22, PAL.evap.flash, s.glow.gold);
    }
    if (b.step === 1 && b.t >= 0.08) {
      b.step = 2;
      bh.targetR = 0;

      spawnEvapWave(s, x, y, pw);
      spawnHawkingStorm(s, x, y, pw);
      spawnLensArcStorm(s, x, y, pw, PAL.evap.lens);

      /* 引力波 */
      addWave(s, x, y, 200 + 500 * pw, 0.8, PAL.evap.wave, 0, 7);
      /* 时空涟漪 */
      addWave(s, x, y, 250 + 500 * pw, 1.0, PAL.evap.wave, 2, 18);
    }
    /* 量子泡沫余韵 */
    if (b.step === 2) {
      const remain = clamp(1 - (b.t - 0.08) / 1.5, 0, 1);
      s.foamAccum += dt * (30 * remain);
      let guard = 0;
      while (s.foamAccum >= 1 && guard < 4) {
        guard++;
        s.foamAccum -= 1;
        const ang = Math.random() * TAU;
        const d = rand(5, 120 + 120 * pw);
        spawnFlash(
          s,
          x + Math.cos(ang) * d,
          y + Math.sin(ang) * d,
          rand(1, 2.5), rand(0.08, 0.18),
          PAL.evap.vpair, s.glow.violet
        );
      }
    }
    if (b.t > 1.9) {
      bh.overexpose = 0;
      s.burst = null;
    }
  }

  /* 过曝衰减 */
  if (bh.overexpose > 0) {
    bh.overexpose = Math.max(0, bh.overexpose - dt * 6);
  }
}

/* ============================================================
 * 19. 粒子更新总入口
 * ============================================================ */
function updateParticles(s, dt) {
  const particles = s.particles;
  for (let i = 0; i < MAXP; i++) {
    const p = particles[i];
    if (!p.active) continue;

    p.life += dt;
    if (p.life >= p.maxLife) {
      p.active = false;
      continue;
    }

    switch (p.kind) {
      case K_TRAIL: updateTrail(s, p, dt); break;
      case K_DISK:  updateDisk(s, p, dt);  break;
      case K_HAWK: {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        /* 屏幕外剔除 */
        if (p.x < -80 || p.x > s.W + 80 || p.y < -80 || p.y > s.H + 80) p.active = false;
        break;
      }
      case K_VIRT: break;
      case K_JET:  updateJet(s, p, dt); break;
      case K_FLASH: break;
      case K_FRAG: updateFrag(s, p, dt); break;
    }
  }
}

/* ============================================================
 * 20. 蓄力状态机
 * ============================================================ */
function updateCharge(s, dt) {
  const bh = s.bh;
  const M = s.input;

  bh.pulseT += dt;
  if (bh.pulseT > 1000) bh.pulseT -= 1000;

  if (bh.charging && dt > 0) {
    bh.charge += dt;
    bh.x = M.x;
    bh.y = M.y;

    const t = bh.charge;

    if (bh.mode === 'collapse') {
      const grow = clamp((t - 0.1) / 1.2, 0, 1);
      bh.targetR = lerp(6, CONFIG.horizonMax, grow);
      bh.photon = clamp((t - 0.1) / 1.2, 0, 1);

      spawnDiskParticles(s, t);
      if (t > CONFIG.jetStartCharge) spawnJetStream(s, dt, t);

    } else if (bh.mode === 'evaporate') {
      const k = clamp(t / CONFIG.chargeMax, 0, 1);
      bh.targetR = lerp(CONFIG.horizonMax, CONFIG.horizonMin, k);
      bh.photon = clamp(t / 1.5, 0, 1);

      spawnVirtualPairTick(s, dt, k);
      spawnQuantumFoam(s, dt, k);
    }

    /* 蓄力超过 55%：微震 */
    if (t > CONFIG.chargeMax * 0.55) {
      const amt = 1 + (t / CONFIG.chargeMax) * 2;
      bh.x += rand(-amt, amt);
      bh.y += rand(-amt, amt);
    }
  } else {
    bh.photon *= Math.pow(0.02, dt);
    if (!s.burst) bh.targetR = CONFIG.horizonIdle;
  }

  /* 视界半径平滑过渡 */
  const spd = bh.charging ? 14 : 7;
  bh.R += (bh.targetR - bh.R) * Math.min(1, dt * spd);
  if (bh.R < 0.2) bh.R = 0.2;
}

/* ============================================================
 * 21. 粒子渲染
 * ============================================================ */
function drawParticles(s) {
  const ctx = s.ctx;
  const bh = s.bh;
  const particles = s.particles;

  for (let i = 0; i < MAXP; i++) {
    const p = particles[i];
    if (!p.active) continue;

    const lt = p.life / p.maxLife;
    let a = p.alpha;
    if (p.life < 0.14) a *= p.life / 0.14;
    if (lt > 0.7) a *= (1 - lt) / 0.3;
    if (a <= 0.012) continue;

    const cr = p.cr | 0, cg = p.cg | 0, cb = p.cb | 0;

    /* ---- 潮汐面条：沿径向拉长的细长曲线 ---- */
    if (p.stretch > 2 && (p.kind === K_DISK || p.kind === K_FRAG)) {
      const dx = p.x - bh.x;
      const dy = p.y - bh.y;
      const d = Math.hypot(dx, dy) || 1;
      const ux = dx / d, uy = dy / d;
      const hl = p.stretch * 0.5;

      ctx.strokeStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',' + (a * 0.9) + ')';
      ctx.lineWidth = p.size * 0.85;
      ctx.beginPath();
      ctx.moveTo(p.x - ux * hl, p.y - uy * hl);
      ctx.lineTo(p.x + ux * hl, p.y + uy * hl);
      ctx.stroke();

      /* 端部亮点 */
      ctx.fillStyle = 'rgba(255,255,255,' + (a * 0.5) + ')';
      ctx.beginPath();
      ctx.arc(p.x + ux * hl * 0.6, p.y + uy * hl * 0.6, p.size * 0.7, 0, TAU);
      ctx.fill();
      continue;
    }

    /* ---- 吸积盘粒子：切向拖尾 + 多普勒增亮 ---- */
    if (p.kind === K_DISK) {
      const tl = p.trail;

      /* 切向单位向量（屏幕空间） */
      const sgn = p.omega >= 0 ? 1 : -1;
      let tx = -Math.sin(p.theta) * sgn;
      let ty = Math.cos(p.theta) * CONFIG.diskFlatten * sgn;
      const tlm = Math.hypot(tx, ty) || 1;
      tx /= tlm; ty /= tlm;

      /* 多普勒增亮：左侧（cosθ<0）朝观察者运动 → 亮 2 倍；右侧暗 0.6 倍 */
      const dop = 1.25 - 0.72 * Math.cos(p.theta);
      const near = Math.sin(p.theta) > 0 ? 1.12 : 0.94;

      const alpha = a * clamp(dop, 0.35, 2) * near;
      const rr = p.size * (0.85 + dop * 0.35);

      /* 拖尾（沿运动反向） */
      ctx.strokeStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',' + clamp(alpha * 0.55, 0, 1) + ')';
      ctx.lineWidth = rr * 0.9;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - tx * tl, p.y - ty * tl);
      ctx.stroke();

      /* 内圈多普勒偏白 */
      const whiteMix = clamp(dop - 1, 0, 1);
      const fr = lerp(cr, 255, whiteMix) | 0;
      const fg = lerp(cg, 255, whiteMix) | 0;
      const fb = lerp(cb, 255, whiteMix) | 0;

      ctx.fillStyle = 'rgba(' + fr + ',' + fg + ',' + fb + ',' + clamp(alpha, 0, 1) + ')';
      ctx.beginPath();
      ctx.arc(p.x, p.y, rr, 0, TAU);
      ctx.fill();

      /* 高亮粒子的软光斑 */
      if (dop > 1.3 && p.size > 1.8) {
        drawGlow(ctx, s.glow.white, p.x, p.y, rr * 9, clamp(alpha * 0.18, 0, 0.4));
      }
      continue;
    }

    /* ---- 喷流粒子 ---- */
    if (p.kind === K_JET) {
      const d = Math.hypot(p.x - bh.x, p.y - bh.y);
      const tt = clamp(d / (CONFIG.jetMaxLength + 120), 0, 1);

      /* 根部炽白 → 中段冰蓝 → 末端品红/透明 */
      let jr, jg, jb;
      if (tt < 0.55) {
        const u = tt / 0.55;
        jr = lerp(255, 168, u); jg = lerp(255, 216, u); jb = lerp(255, 255, u);
      } else {
        const u = (tt - 0.55) / 0.45;
        jr = lerp(168, 255, u); jg = lerp(216, 79, u); jb = lerp(255, 216, u);
      }

      const fa = a * (1 - tt * 0.55);
      if (fa <= 0.01) continue;

      drawGlow(ctx, s.glow.ice, p.x, p.y, p.size * 10, fa * 0.22);

      ctx.strokeStyle = 'rgba(' + (jr | 0) + ',' + (jg | 0) + ',' + (jb | 0) + ',' + (fa * 0.85) + ')';
      ctx.lineWidth = p.size * 0.9;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x, p.y - (p.vy > 0 ? 12 : -12));
      ctx.stroke();

      ctx.fillStyle = 'rgba(' + (jr | 0) + ',' + (jg | 0) + ',' + (jb | 0) + ',' + fa + ')';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, TAU);
      ctx.fill();
      continue;
    }

    /* ---- 闪光 ---- */
    if (p.kind === K_FLASH) {
      drawGlow(ctx, p.tex, p.x, p.y, p.size * 7, a * 0.9);
      ctx.fillStyle = 'rgba(255,255,255,' + (a * 0.95) + ')';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * 0.55, 0, TAU);
      ctx.fill();
      continue;
    }

    /* ---- 虚粒子涨落 ---- */
    if (p.kind === K_VIRT) {
      ctx.fillStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',' + (a * 0.8) + ')';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, TAU);
      ctx.fill();
      continue;
    }

    /* ---- 霍金辐射粒子（带短拖尾） ---- */
    if (p.kind === K_HAWK) {
      const vlen = Math.hypot(p.vx, p.vy) || 1;
      const tl = 8;
      ctx.strokeStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',' + (a * 0.6) + ')';
      ctx.lineWidth = p.size * 0.85;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.vx / vlen * tl, p.y - p.vy / vlen * tl);
      ctx.stroke();

      drawGlow(ctx, p.tex, p.x, p.y, p.size * 8, a * 0.35);
      ctx.fillStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',' + a + ')';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, TAU);
      ctx.fill();
      continue;
    }

    /* ---- 自由粒子 / 碎片（带运动拖尾） ---- */
    const vlen = Math.hypot(p.vx, p.vy) || 1;
    const spd = vlen;
    const tl = clamp(spd * 0.045, 2, 26);

    ctx.strokeStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',' + (a * 0.5) + ')';
    ctx.lineWidth = p.size * 0.8;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x - p.vx / vlen * tl, p.y - p.vy / vlen * tl);
    ctx.stroke();

    if (p.size > 1.4) {
      drawGlow(ctx, p.tex, p.x, p.y, p.size * 8, a * 0.28);
    }

    ctx.fillStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',' + a + ')';
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, TAU);
    ctx.fill();
  }
}

/* ============================================================
 * 22. 事件视界渲染
 * ============================================================ */
function drawHorizon(s) {
  const ctx = s.ctx;
  const bh = s.bh;

  /* 只有活跃状态下才绘制实体黑洞（禁止常驻黑洞装饰） */
  const active = bh.charging || (s.burst && s.burst.t < 0.9) || bh.overexpose > 0;
  if (!active || bh.R < 0.6) return;

  ctx.fillStyle = bh.mode === 'evaporate'
    ? CONFIG.evaporateColors.horizon
    : CONFIG.collapseColors.horizon;

  ctx.beginPath();
  ctx.arc(bh.x, bh.y, bh.R, 0, TAU);
  ctx.fill();

  /* 蒸发中：视界边缘带微弱青蓝色（黑洞在发光） */
  if (bh.mode === 'evaporate' && bh.photon > 0.1) {
    ctx.strokeStyle = 'rgba(168,232,255,' + (bh.photon * 0.28) + ')';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(bh.x, bh.y, bh.R - 0.6, 0, TAU);
    ctx.stroke();
  }
}

/* ============================================================
 * 23. 组件
 * ============================================================ */
export class CursorHole extends CursorEffectElement {
  /**
   * 滚轮动效：暗紫粒子先向外抛再被拉回，像被黑洞吸住。
   */
  wheelTheme() {
    return {
      style: 'ink',
      color:  [176, 124, 255],
      color2: [90, 50, 150],
      sizeMin: 2.5, sizeMax: 6,
      lifeMin: 0.6, lifeMax: 1.3,
      upSpeed: 380,
      downSpeed: 340,
      spread: 130,
      gravity: 480,          // 强引力，抛出后回落
      drag: 1.6,
      turbulence: 18,
      grow: 5,
      jitter: 9
    };
  }

  /** 主题光标：暗紫描边 + 墨点装饰 */
  cursorTheme() {
    return {
      edge: '#b07cff',
      fill: 'rgba(14, 8, 24, .92)',
      glow: '#7a3fd0',
      deco: { color: [176, 124, 255], style: 'ink', rate: 14, speedGain: 0.22 }
    };
  }

  // 原型用的是 mousemove / mousedown / mouseup（第 826-828 行），不是 pointer 事件族，
  // 不声明这一行，基类会去监听 pointermove，动效将完全收不到鼠标输入。
  inputFamily = 'mouse';

  /* ============================================================
   * 初始化
   * ============================================================ */
  // 只建池与状态，不注册任何监听（监听、DPR 缩放、rAF 全归基类）
  setup({ canvas, ctx, width, height, input }) {
    // 与原型一致：初始光标位置取视口中心（原型第 281-283 行），
    // 否则首帧位移会按「从左上角跳过来」计算，速度与拖尾生成量都和原型不同。
    input.x = input.lx = width * 0.5;
    input.y = input.ly = height * 0.5;

    const particles = new Array(MAXP);
    for (let i = 0; i < MAXP; i++) particles[i] = makeParticle();

    const doc = canvas.ownerDocument;

    // 原型在 resize() 里设置线帽/线接（第 152-153 行）；
    // 画布尺寸变化会重置上下文状态，所以 onResize 里还要再设一次。
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    return {
      // 本实例的画布上下文（已按 DPR 缩放过，统一使用 CSS 像素坐标）
      ctx,

      // 画布尺寸（CSS 像素），由基类 onResize 同步
      W: width,
      H: height,

      input,

      // 离屏光斑纹理的创建者：用元素自身的 ownerDocument，不碰全局对象，也绝不挂进 DOM
      doc,
      glow: makeGlowSet(doc),

      // 粒子池：环形游标复用空闲槽
      particles,
      poolCursor: 0,

      // 全局状态：黑洞本体与交互状态机
      bh: {
        x: input.x, y: input.y,
        R: CONFIG.horizonIdle,
        targetR: CONFIG.horizonIdle,
        mode: 'idle',        // idle | collapse | evaporate
        charging: false,
        charge: 0,
        photon: 0,           // 光子环亮度 0..1
        pulseT: 0,           // 光子环脉动相位
        frozen: 0,           // 冻结帧计时
        overexpose: 0        // 光子环过曝（爆发瞬间）
      },

      // 引力透镜脉冲（交互三）
      lensPulse: { t: 0, dur: 0.4, radius: 300 },

      // 爆发状态机
      burst: null,

      // 辅助渲染数组（独立于粒子池，数量少）
      waves: [],       // 引力波 / 量子蒸发波 / 时空涟漪
      arcs: [],        // 透镜光弧
      afterimages: [], // 视界残影

      // 各类生成累加器
      jetAccum: 0,
      vpAccum: 0,
      trailAccum: 0,
      foamAccum: 0,

      // 原型口径的鼠标速度：最后一次 mousemove 的像素位移（未除 dt、未平滑）
      rawVx: 0,
      rawVy: 0
    };
  }

  /* ============================================================
   * 输入（按键）—— 鼠标位移由基类写入 this.input，原始速度在 update() 里算好存入 state，
   * 这里只处理左右键交互
   * ============================================================ */
  onPointerDown(e) {
    const s = this.state;
    if (!s) return;

    // 原型在 mousedown 里把 mouse.x / mouse.y 对齐到事件坐标（第 868-869 行），
    // 再用它作为黑洞与脉冲的原点。这里直接用事件坐标，
    // 不回写 input（回写会凭空造出一段帧位移，下一帧多出一串拖尾粒子）。
    const bh = s.bh;
    const x = e.clientX, y = e.clientY;

    if (e.button === 0) {
      if (bh.charging) return;
      bh.charging = true;
      bh.charge = 0;
      bh.mode = 'collapse';
      bh.x = x;
      bh.y = y;
      bh.targetR = 6;
      /* 交互二：单击引力脉冲 */
      doClickPulse(s, x, y);
      /* 交互三：引力透镜脉冲 */
      doLensPulse(s);
    } else if (e.button === 2) {
      if (bh.charging) return;
      bh.charging = true;
      bh.charge = 0;
      bh.mode = 'evaporate';
      bh.x = x;
      bh.y = y;
      bh.targetR = CONFIG.horizonMax;
      doRightPulse(s, x, y);
    }
  }

  onPointerUp(e) {
    const s = this.state;
    if (!s) return;

    const bh = s.bh;
    if (!bh.charging) return;

    const t = bh.charge;
    const power = Math.pow(clamp(t, 0, CONFIG.chargeMax) / CONFIG.chargeMax, 1.6);

    if (bh.mode === 'collapse') {
      if (t < CONFIG.clickThreshold) {
        /* 蓄力不足 → 只是普通单击，已在前置脉冲处理 */
      } else {
        doCollapseBurst(s, power);
      }
    } else if (bh.mode === 'evaporate') {
      if (t < CONFIG.clickThreshold) {
        // 原型用的是 mouse.x / mouse.y（第 1113 行），它等于最近一次 mousemove 或
        // mousedown 的坐标；短按时与 mouseup 坐标一致，这里直接用事件坐标更稳。
        doSmallEvaporation(s, e.clientX, e.clientY);
      } else {
        doEvaporationBurst(s, power);
      }
    }

    bh.charging = false;
    bh.charge = 0;
    bh.mode = 'idle';
    if (!s.burst) bh.targetR = CONFIG.horizonIdle;
  }

  // 失焦：清理蓄力状态（原型 window blur 的行为，第 832-841 行）
  onBlur() {
    const s = this.state;
    if (!s) return;

    const bh = s.bh;
    bh.charging = false;
    bh.charge = 0;
    bh.mode = 'idle';
    bh.targetR = CONFIG.horizonIdle;
    bh.photon = 0;
    s.burst = null;
    s.lensPulse.t = 0;
  }

  /* ============================================================
   * 尺寸 —— 只同步动效自己的 W / H，画布尺寸与 DPR 由基类维护
   * ============================================================ */
  onResize(width, height) {
    const s = this.state;
    if (!s) return;
    s.W = width;
    s.H = height;

    // 基类重设画布缓冲时会重置上下文状态，与原型 resize() 一样重新设置线帽/线接
    s.ctx.lineCap = 'round';
    s.ctx.lineJoin = 'round';
  }

  /* ============================================================
   * 更新
   * ============================================================ */
  update(dt, s) {
    if (!s) return;
    const M = s.input;

    // —— 鼠标原始速度 ——
    // 原型口径：最后一次 mousemove 事件的像素位移（未除 dt、未平滑、无钳制）。
    // 基类的 input.vx / vy 是 1-exp(-25dt) 平滑值且带「>300px 归零 / 6000 封顶」，
    // 与原型不符；这里用事件级锚点（input.lx / ly）复算原值，供拖尾粒子继承。
    s.rawVx = M.x - M.lx;
    s.rawVy = M.y - M.ly;

    // —— 拖尾（原型在 mousemove 回调里生成，见文件头说明）——
    emitTrail(s);

    /* 冻结帧（松开瞬间的静止一帧）：只推进蓄力与绘制，跳过其余更新 */
    if (s.bh.frozen > 0) {
      s.bh.frozen -= dt;
      updateCharge(s, 0);
      return;
    }

    updateCharge(s, dt);
    updateLensPulse(s, dt);
    updateBurst(s, dt);
    updateParticles(s, dt);
    updateWaves(s, dt);
    updateArcs(s, dt);
    updateAfterimages(s, dt);
  }

  /* ============================================================
   * 渲染
   * ============================================================ */
  render(s) {
    if (!s) return;
    const ctx = s.ctx;

    /* --- 拖尾衰减（保持画布透明，仅擦除已有像素的 alpha） ---
       destination-out 的整屏 fillRect 是拖影衰减，不是不透明铺底：必须保留。
       删掉它拖尾会变成永久残影。 */
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(0, 0, s.W, s.H);

    /* --- 加色绘制层 --- */
    ctx.globalCompositeOperation = 'lighter';

    drawParticles(s);
    drawWaves(s);
    drawArcs(s);

    /* --- 事件视界（纯黑不透明，覆盖后方一切） --- */
    ctx.globalCompositeOperation = 'source-over';
    drawAfterimages(s);
    drawHorizon(s);

    /* --- 光子环（视界边缘的炽白细环） --- */
    ctx.globalCompositeOperation = 'lighter';
    drawPhotonRing(s);

    ctx.globalCompositeOperation = 'source-over';
  }
}

if (!customElements.get('cursor-hole')) {
  customElements.define('cursor-hole', CursorHole);
}

export default CursorHole;
