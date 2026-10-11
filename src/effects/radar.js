/**
 * cursor-radar —— 鼠标光标雷达动效（左键定向波束 / 右键全向脉冲）。
 *
 * 由 html/雷达.html 原型移植：算法流程、数值、视觉表现与原文件一一对应。
 * 作为光标层组件，原型页面自身的行为已剔除：
 *   - 原型的深色底 #03070c 写在 CSS 的 html,body 上，不是画布填充；
 *     原型 render()（第 1508-1509 行）本来就是 clearRect，绘制中没有任何整屏铺底，
 *     移植后同样只清屏，绝不覆盖宿主页面；
 *   - 不拦截 contextmenu（原型第 734 行），宿主页面的右键菜单不受影响；
 *   - 画布创建、DPR 适配（封顶 2）、尺寸同步、window resize（原型第 194-205 行）、
 *     监听注册、rAF 循环（原型第 1557-1576 行）全部由基类负责；
 *   - 鼠标速度：原型全程不使用速度大小，只用到「最后一段位移的归一化方向」
 *     （第 547-549 行的 mouse.dirX / mouse.dirY），因此既不取基类的平滑速度，
 *     也不需要另算原始逐帧速度；
 *   - 锚点：原型对「方向」与「拖尾距离」用的是两种口径，移植后分别对应两套锚点
 *     （详见 _syncDir / _emitTrail）：
 *       方向 —— 原型在 mousemove 回调里按「上一事件位置 → 当前位置」归一化
 *               （第 543-549 行），并在回调内推进锚点（第 567-568 行 mouse.x = nx），
 *               属事件级口径 → 用 input.lx / input.ly（一帧内取最后一段，与原型一致）；
 *       拖尾 —— 原型把每个事件的距离累加进 mouse.trailAcc（第 552 行），
 *               一帧内所有事件之和即整帧位移，属帧级口径。
 *               基类的 frameLx / frameLy 在 update() 时刻等于 lx / ly
 *               （base.js 第 335 行取 inp.lx，而 _onPointerMove 第 240 行是逐事件推进 lx），
 *               一帧内出现多个移动事件时它只能给出最后一段位移；
 *               因此这里在 state 上自持一个「上一帧位置」锚点（s.trailFromX / trailFromY），
 *               语义正是帧级口径，且不依赖基类锚点的实现细节。
 *     实测（每帧总位移相同）：若拖尾也只用事件级锚点，125Hz 鼠标密度剩 48%、
 *     500Hz 剩 12%、1000Hz 剩 6%；改用帧级口径后为 99%~100%。
 *
 * 原型监听 mousemove / mousedown / mouseup（第 731-733 行），因此声明 inputFamily = 'mouse'。
 * 所有运行状态（光点池、特效容器、蓄力状态、离屏贴图）都放在 setup() 返回的 state 上，
 * 多实例互不干扰。
 */

import { CursorEffectElement } from '../core/base.js';
import { TAU, clamp, lerp, rand, randInt } from '../core/utils.js';

/* =========================================================================
   顶部 CONFIG —— 所有可调参数集中于此（与原型第 21-96 行逐值一致）
   ========================================================================= */
const CONFIG = {
  /* --- 光点池 --- */
  maxPoints: 1800,              // 光点对象池上限
  pointLifeMin: 2.0,            // 光点寿命下限（秒）
  pointLifeMax: 4.0,            // 光点寿命上限（秒）
  pointSpeedMin: 10,            // 漂移速度下限 px/s
  pointSpeedMax: 30,            // 漂移速度上限 px/s
  pointRadiusMin: 1.5,          // 光点半径下限 px
  pointRadiusMax: 3.0,          // 光点半径上限 px
  idleAlpha: 0.30,              // 待扫描状态基础亮度

  /* --- 拖尾生成 --- */
  trailSpawnDist: 7,            // 鼠标每移动多少 px 生成一个待扫描光点
  trailMaxPerFrame: 14,         // 单帧拖尾生成上限

  /* --- 两组配色 --- */
  cold: {                       // 左键：定向波束（冷青组）
    main: '#4FE3FF',            // 冰青（主色）
    bright: '#FFFFFF',          // 锐白（回波亮）
    dim: '#1A4A3A',             // 深绿（背景刻度）
    lock: '#3DFF7A',            // 翠绿（锁定成功）
    warn: '#FF3D3D'             // 警示红
  },
  warm: {                       // 右键：全向脉冲（暖橙组）
    main: '#FF8C1A',            // 橙（主色）
    bright: '#FFD24A',          // 琥珀（回波亮）
    dim: '#1A2A4A',             // 深蓝（背景刻度）
    pulse: '#FFFFFF',           // 炽白（脉冲波前）
    magenta: '#FF4FD8'          // 品红（高能量回波）
  },

  /* --- 扫描系统 --- */
  scanRange: 260,               // 左键波束基础扫描半径
  scanRangeRight: 400,          // 右键全向扫描半径
  echoAngleTol: 0.065,          // 扫描线角度判定容差（弧度）
  echoDecayTime: 0.34,          // 回波亮度回落时间（秒）
  echoRingLife: 0.15,           // 回波扩散圈寿命（秒）
  echoRingFrom: 3,              // 回波扩散圈起始半径
  echoRingTo: 8,                // 回波扩散圈基础结束半径

  /* --- 距离圈系统 --- */
  ringRadii: [50, 100, 150, 200, 250], // 距离圈半径序列
  ringMinCount: 3,              // 蓄力起始圈数
  ringMaxCount: 5,              // 蓄满圈数
  ringTickStep: 15,             // 刻度间隔（度）
  ringAzimuthStep: 30,          // 方位角标记间隔（度）

  /* --- 蓄力 / 锁定 --- */
  chargeMax: 2.5,               // 蓄力满值（秒）
  clickThreshold: 0.12,         // 低于此值视为普通单击（秒）
  lockHoldTime: 0.5,            // 波束内停留多久触发锁定（秒）
  lockPulseInterval: 0.3,       // 锁定目标回波间隔（秒）

  /* --- 左键：定向波束 --- */
  beamSpreadStart: Math.PI * 2 / 3,   // 初始张角 120°
  beamSpreadEnd: Math.PI / 12,        // 蓄满张角 15°
  beamSweepPeriodStart: 0.8,          // 初始扫描周期（秒）
  beamSweepPeriodEnd: 0.2,            // 蓄满扫描周期（秒）
  beamFireSpeed: 2000,                // 发射波束飞行速度 px/s
  beamFireHalfAngle: 4 * Math.PI / 180, // 发射锥形半角 4°（总 8°）
  beamFireLenBase: 400,               // 发射长度基础值
  beamFireLenAdd: 600,                // 发射长度随 power 增量

  /* --- 右键：全向脉冲 --- */
  spinStart: 0.5,               // 初始旋转速度（圈/秒）
  spinEnd: 3.0,                 // 蓄满旋转速度（圈/秒）
  pulseSpeedBase: 1000,         // 脉冲扩散基础速度 px/s
  pulseSpeedAdd: 500,           // 脉冲速度随 power 增量
  pulseMaxRadius: 900,          // 脉冲最大半径

  /* --- 单击 --- */
  clickPulseRadius: 120,        // 单击探测脉冲扩散半径
  clickPulseLife: 0.4,          // 单击探测脉冲寿命（秒）
  lockScanRadius: 200,          // 单击锁定扫描半径
  lockScanTime: 0.3             // 单击锁定扫描一圈用时（秒）
};

/* =========================================================================
   工具函数
   （TAU / rand / randInt / clamp / lerp 来自 core/utils.js，此处不再重复定义）
   ========================================================================= */
function normAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
function lerpAngle(a, b, t) { return a + normAngle(b - a) * t; }

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgba(hex, a) {
  const c = hexToRgb(hex);
  return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
}
/* 判断角度 a 是否落在 from→to 扫过的弧内（走最短路径） */
function inArc(a, from, to) {
  const delta = normAngle(to - from);
  const da = normAngle(a - from);
  if (delta >= 0) return da >= 0 && da <= delta;
  return da <= 0 && da >= delta;
}
/* 带容差的扫描命中判定 */
function sweepHit(a, from, to, tol) {
  return inArc(a, from - tol, to + tol);
}

/* =========================================================================
   离屏纹理预渲染 —— 5 种形态 × 3 种尺寸档 × 多色
   原型用全局 document 预渲染并全局缓存；移植后改用元素自身的 ownerDocument
   创建、缓存挂到 state 上，多实例互不干扰。
   这里的 createElement / width / height / getContext 只作用于离屏贴图画布，
   与主画布无关，也绝不挂进 DOM。
   ========================================================================= */
const TEX_SIZES = [8, 16, 32];
const COLOR_HEX = {
  cyan:    CONFIG.cold.main,
  white:   '#FFFFFF',
  green:   CONFIG.cold.lock,
  red:     CONFIG.cold.warn,
  orange:  CONFIG.warm.main,
  amber:   CONFIG.warm.bright,
  magenta: CONFIG.warm.magenta
};

/* 生成一张径向渐变软边圆纹理
   coreWhite = true  → 中心纯白（回波点 / 锁定 / 光核）
   coreWhite = false → 中心即主色（待扫描暗点 / 扫描光斑） */
function makeTex(doc, size, color, coreWhite) {
  const c = doc.createElement('canvas');
  c.width = size; c.height = size;
  const g = c.getContext('2d');
  const r = size / 2;
  const rgb = hexToRgb(color);
  const R = rgb[0], G = rgb[1], B = rgb[2];
  const grd = g.createRadialGradient(r, r, 0, r, r, r);
  if (coreWhite) {
    grd.addColorStop(0.00, 'rgba(255,255,255,1)');
    grd.addColorStop(0.16, 'rgba(255,255,255,0.94)');
    grd.addColorStop(0.34, 'rgba(' + R + ',' + G + ',' + B + ',0.55)');
    grd.addColorStop(0.64, 'rgba(' + R + ',' + G + ',' + B + ',0.16)');
    grd.addColorStop(1.00, 'rgba(' + R + ',' + G + ',' + B + ',0)');
  } else {
    grd.addColorStop(0.00, 'rgba(' + R + ',' + G + ',' + B + ',0.85)');
    grd.addColorStop(0.35, 'rgba(' + R + ',' + G + ',' + B + ',0.34)');
    grd.addColorStop(0.70, 'rgba(' + R + ',' + G + ',' + B + ',0.09)');
    grd.addColorStop(1.00, 'rgba(' + R + ',' + G + ',' + B + ',0)');
  }
  g.fillStyle = grd;
  // 贴图自身的整块填充：它落在离屏画布上，不是视口铺底，必须保留
  g.fillRect(0, 0, size, size);
  return c;
}

/* 预烘焙全部贴图（原型第 177-185 行的模块级 IIFE，移植后按实例执行） */
function prebakeTextures(doc) {
  const tex = {};
  for (const name in COLOR_HEX) {
    for (let i = 0; i < TEX_SIZES.length; i++) {
      const s = TEX_SIZES[i];
      tex[name + '_c_' + s] = makeTex(doc, s, COLOR_HEX[name], true);
      tex[name + '_s_' + s] = makeTex(doc, s, COLOR_HEX[name], false);
    }
  }
  return tex;
}

/* =========================================================================
   分区一：光点池
   ========================================================================= */
function createPoint() {
  return {
    x: 0, y: 0, vx: 0, vy: 0,
    size: 2,
    life: 0, maxLife: 1,
    rot: 0, rotSpd: 0,
    /* 回波 */
    echo: 0, echoPow: 2, echoCol: 'cyan',
    ringT: 0, ringMax: 8, ringCol: 'cyan',
    /* 扫描 / 锁定 */
    inBeam: 0,
    lockTimer: 0,
    lockRot: 0,
    mark: 0,
    /* 二次回波 */
    secondT: 0, secondPow: 1.5, secondCol: 'cyan'
  };
}

function initPoint(p, x, y) {
  p.x = x; p.y = y;
  const a = Math.random() * TAU;
  const sp = rand(CONFIG.pointSpeedMin, CONFIG.pointSpeedMax);
  p.vx = Math.cos(a) * sp;
  p.vy = Math.sin(a) * sp;
  p.size = rand(CONFIG.pointRadiusMin, CONFIG.pointRadiusMax);
  p.maxLife = rand(CONFIG.pointLifeMin, CONFIG.pointLifeMax);
  p.life = p.maxLife;
  p.rot = Math.random() * TAU;
  p.rotSpd = rand(-0.7, 0.7);
  p.echo = 0; p.echoPow = 2; p.echoCol = 'cyan';
  p.ringT = 0; p.ringMax = CONFIG.echoRingTo; p.ringCol = 'cyan';
  p.inBeam = 0;
  p.lockTimer = 0;
  p.lockRot = Math.random() * TAU;
  p.mark = 0;
  p.secondT = 0; p.secondPow = 1.5; p.secondCol = 'cyan';
}

function spawnPoint(s, x, y) {
  let p = null;
  if (s.pool.length > 0) {
    p = s.pool.pop();
  } else if (s.points.length > 0) {
    p = s.points.shift();
    if (s.charge.locked === p) s.charge.locked = null;
  } else {
    return null;
  }
  initPoint(p, x, y);
  s.points.push(p);
  return p;
}

/* 触发一次回波：亮度提升 + 扩散圈 */
function triggerEcho(p, power, col, ringMax) {
  p.echo = 1;
  p.echoPow = power;
  p.echoCol = col;
  p.ringT = CONFIG.echoRingLife;
  p.ringMax = ringMax;
  p.ringCol = col;
}

/* =========================================================================
   分区二：特效容器（扩散圈 / 射线 / 脉冲 / 波束 / 螺旋）
   ========================================================================= */
function later(s, t, fn) { s.deferred.push({ t: t, fn: fn }); }

/* 距离圈爆散 */
function burstRangeRings(s) {
  const charge = s.charge;
  const count = Math.round(lerp(CONFIG.ringMinCount, CONFIG.ringMaxCount, charge.power));
  const col = charge.mode === 0 ? CONFIG.cold.main : CONFIG.warm.main;
  for (let i = 0; i < count && i < CONFIG.ringRadii.length; i++) {
    s.rings.push({
      x: s.originX, y: s.originY,
      r0: CONFIG.ringRadii[i],
      rMax: CONFIG.ringRadii[i] * 1.5,
      life: 0.4, maxLife: 0.4,
      color: col, lw: 1, alpha: 0.6,
      scan: false, hit: null
    });
  }
}

/* =========================================================================
   分区三：扫描系统
   ========================================================================= */

/* ---- 左键：定向波束的扫描 ---- */
function updateLeftBeam(s, dt, p) {
  const charge = s.charge;
  const mouse = s.mouse;

  /* 波束方向平滑跟随鼠标移动方向 */
  const target = Math.atan2(mouse.dirY, mouse.dirX);
  charge.baseAngle = lerpAngle(charge.baseAngle, target, 1 - Math.exp(-dt * 4));

  /* 张角从 120° 收窄到 15° */
  const half = lerp(CONFIG.beamSpreadStart * 0.5, CONFIG.beamSpreadEnd * 0.5, p);
  charge.spread = half;

  /* 扫描周期从 0.8s 缩短到 0.2s */
  const period = lerp(CONFIG.beamSweepPeriodStart, CONFIG.beamSweepPeriodEnd, p);
  const prevSweep = charge.sweepAngle;
  charge.sweepPhase += dt / period;
  charge.sweepAngle = charge.baseAngle + half * Math.sin(charge.sweepPhase * TAU);

  const range = CONFIG.scanRange + p * 60;
  const echoPow = lerp(2, 4, p);
  const echoRing = lerp(CONFIG.echoRingTo, 20, p);
  const echoCol = p < 0.4 ? 'cyan' : (p < 0.78 ? 'white' : 'green');

  let best = null, bestD = Infinity;
  const locked = charge.locked;
  const hasLock = !!(locked && locked.lockTimer > 0);

  for (let i = 0; i < s.points.length; i++) {
    const pt = s.points[i];
    const dx = pt.x - s.originX, dy = pt.y - s.originY;
    const d2 = dx * dx + dy * dy;
    if (d2 > range * range || d2 < 25) {
      pt.inBeam = 0;
      continue;
    }
    const a = Math.atan2(dy, dx);
    if (Math.abs(normAngle(a - charge.baseAngle)) > half) {
      pt.inBeam = 0;
      continue;
    }
    pt.inBeam += dt;

    /* 扫描线命中 → 回波 */
    if (sweepHit(a, prevSweep, charge.sweepAngle, CONFIG.echoAngleTol)) {
      triggerEcho(pt, echoPow, echoCol, echoRing);
    }

    /* 锁定候选（距离最近的优先） */
    if (!hasLock && pt.inBeam >= CONFIG.lockHoldTime) {
      const d = Math.sqrt(d2);
      if (d < bestD) { bestD = d; best = pt; }
    }
  }

  if (best) lockBeamTarget(s, best);

  /* 已锁定目标持续闪回波 */
  if (hasLock) {
    locked.lockTimer = Math.max(locked.lockTimer, 0.45);
    charge.lockPulse -= dt;
    if (charge.lockPulse <= 0) {
      charge.lockPulse = CONFIG.lockPulseInterval;
      triggerEcho(locked, 3, 'green', 13);
    }
  }
}

/* 锁定一个目标 */
function lockBeamTarget(s, pt) {
  const charge = s.charge;
  charge.locked = pt;
  charge.lockPulse = 0;
  pt.lockTimer = 0.6;
  pt.echo = 1;
  pt.echoPow = 4;
  pt.echoCol = 'green';
  pt.ringT = CONFIG.echoRingLife;
  pt.ringMax = 20;
  pt.ringCol = 'green';
  s.rays.push({
    x1: s.originX, y1: s.originY, x2: pt.x, y2: pt.y,
    life: 0.35, maxLife: 0.35,
    color: CONFIG.cold.lock, lw: 1, alpha: 0.8
  });
}

/* ---- 右键：全向扫描 ---- */
function updateRightPulse(s, dt, p) {
  const charge = s.charge;
  const spin = lerp(CONFIG.spinStart, CONFIG.spinEnd, p);
  const prev = charge.sweepAngle;
  charge.sweepAngle = (charge.sweepAngle + spin * TAU * dt) % TAU;

  const range = CONFIG.scanRangeRight;
  const echoPow = lerp(2, 4, p);
  const echoRing = lerp(CONFIG.echoRingTo, 20, p);
  const echoCol = p < 0.55 ? 'amber' : 'magenta';

  for (let i = 0; i < s.points.length; i++) {
    const pt = s.points[i];
    const dx = pt.x - s.originX, dy = pt.y - s.originY;
    const d2 = dx * dx + dy * dy;
    if (d2 > range * range || d2 < 16) continue;
    const a = Math.atan2(dy, dx);
    if (sweepHit(a, prev, charge.sweepAngle, CONFIG.echoAngleTol)) {
      triggerEcho(pt, echoPow, echoCol, echoRing);
    }
  }
}

/* =========================================================================
   分区四：回波系统（二次回波 / 探测脉冲扫描）
   ========================================================================= */

/* 单击探测脉冲：依次点亮（按半径扩张命中） */
function updateScanRings(s) {
  for (let i = 0; i < s.rings.length; i++) {
    const r = s.rings[i];
    if (!r.scan) continue;
    const k = 1 - r.life / r.maxLife;
    const rr = lerp(r.r0, r.rMax, k);
    for (let j = 0; j < s.points.length; j++) {
      const pt = s.points[j];
      if (r.hit.indexOf(pt) !== -1) continue;
      const dx = pt.x - r.x, dy = pt.y - r.y;
      if (dx * dx + dy * dy <= rr * rr) {
        r.hit.push(pt);
        triggerEcho(pt, 2, 'cyan', 10);
      }
    }
  }
}

/* =========================================================================
   分区五：距离圈系统
   ========================================================================= */
function drawRangeRings(s, count, pal, p) {
  const ctx = s.ctx;
  const cx = s.originX, cy = s.originY;
  const mainCol = pal.main;
  const baseAlpha = 0.16 + p * 0.14;

  ctx.lineWidth = 1;

  /* 同心圆 */
  for (let i = 0; i < count && i < CONFIG.ringRadii.length; i++) {
    ctx.globalAlpha = baseAlpha * (0.75 + i * 0.1);
    ctx.strokeStyle = mainCol;
    ctx.beginPath();
    ctx.arc(cx, cy, CONFIG.ringRadii[i], 0, TAU);
    ctx.stroke();
  }

  /* 刻度线：每 15° 从圈向内延伸 4px */
  ctx.globalAlpha = baseAlpha * 0.85;
  ctx.strokeStyle = mainCol;
  ctx.beginPath();
  for (let i = 0; i < count && i < CONFIG.ringRadii.length; i++) {
    const R = CONFIG.ringRadii[i];
    for (let a = 0; a < 360; a += CONFIG.ringTickStep) {
      const rad = a * Math.PI / 180;
      const c = Math.cos(rad), s2 = Math.sin(rad);
      ctx.moveTo(cx + c * R, cy + s2 * R);
      ctx.lineTo(cx + c * (R - 4), cy + s2 * (R - 4));
    }
  }
  ctx.stroke();

  /* 方位角标记：最外圈每 30° 向外延伸 6px */
  const lastIdx = Math.min(count, CONFIG.ringRadii.length) - 1;
  if (lastIdx >= 0) {
    const Ro = CONFIG.ringRadii[lastIdx];
    ctx.globalAlpha = baseAlpha * 1.1;
    ctx.beginPath();
    for (let a = 0; a < 360; a += CONFIG.ringAzimuthStep) {
      const rad = a * Math.PI / 180;
      const c = Math.cos(rad), s2 = Math.sin(rad);
      ctx.moveTo(cx + c * Ro, cy + s2 * Ro);
      ctx.lineTo(cx + c * (Ro + 6), cy + s2 * (Ro + 6));
    }
    ctx.stroke();
  }
}

/* =========================================================================
   分区六：锁定系统（渲染侧）
   ========================================================================= */
function drawLockBox(s, p) {
  const ctx = s.ctx;
  const h = 9, L = 5;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.lockRot);
  ctx.globalAlpha = 0.95;
  ctx.strokeStyle = CONFIG.cold.lock;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  /* 4 个 L 形角标记 */
  ctx.moveTo(-h, -h + L); ctx.lineTo(-h, -h); ctx.lineTo(-h + L, -h);
  ctx.moveTo(h - L, -h);  ctx.lineTo(h, -h);  ctx.lineTo(h, -h + L);
  ctx.moveTo(h, h - L);   ctx.lineTo(h, h);   ctx.lineTo(h - L, h);
  ctx.moveTo(-h + L, h);  ctx.lineTo(-h, h);  ctx.lineTo(-h, h - L);
  ctx.stroke();
  ctx.restore();
}

/* =========================================================================
   分区七（模块侧）：单击探测脉冲 + 扫描锁定
   原型第 542-735 行的鼠标监听改为类方法（见 CursorRadar），
   这里保留与监听无关的处理逻辑。
   ========================================================================= */
function doClickDetect(s, cx, cy) {
  /* 1. 短促探测脉冲（依次点亮） */
  s.rings.push({
    x: cx, y: cy,
    r0: 5, rMax: CONFIG.clickPulseRadius,
    life: CONFIG.clickPulseLife, maxLife: CONFIG.clickPulseLife,
    color: CONFIG.cold.main, lw: 2, alpha: 0.45,
    scan: true, hit: []
  });

  /* 2. 生成 8~14 个新回波点 */
  const n = randInt(8, 14);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU;
    const d = rand(30, 80);
    const pt = spawnPoint(s, cx + Math.cos(a) * d, cy + Math.sin(a) * d);
    if (pt) triggerEcho(pt, 2, 'cyan', 9);
  }

  /* 3. 短促扫描线残影 */
  const sa = Math.random() * TAU;
  s.rays.push({
    x1: cx, y1: cy,
    x2: cx + Math.cos(sa) * 80,
    y2: cy + Math.sin(sa) * 80,
    life: 0.25, maxLife: 0.25,
    color: 'white', lw: 2, alpha: 0.5
  });

  /* 4. 扫描锁定：一条白色强扫描线 0.3s 扫过 360° */
  const ls = s.lockScan;
  ls.active = true;
  ls.x = cx; ls.y = cy;
  ls.prev = 0;
  ls.angle = 0;
  ls.life = CONFIG.lockScanTime;
  ls.maxLife = CONFIG.lockScanTime;
  ls.hit = [];
}

function updateLockScan(s, dt) {
  const lockScan = s.lockScan;
  if (!lockScan.active) return;
  lockScan.life -= dt;
  const progress = clamp(1 - lockScan.life / lockScan.maxLife, 0, 1);
  lockScan.prev = lockScan.angle;
  lockScan.angle = progress * TAU;

  const from = lockScan.prev, to = lockScan.angle;
  for (let i = 0; i < s.points.length; i++) {
    const pt = s.points[i];
    if (lockScan.hit.indexOf(pt) !== -1) continue;
    const dx = pt.x - lockScan.x, dy = pt.y - lockScan.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > CONFIG.lockScanRadius * CONFIG.lockScanRadius) continue;
    let a = Math.atan2(dy, dx);
    a = ((a % TAU) + TAU) % TAU;
    while (a < from) a += TAU;
    if (a > to) continue;

    lockScan.hit.push(pt);
    /* 锁定回波：亮度 3 倍 + 绿色锁定框 + 标记点 */
    triggerEcho(pt, 3, 'green', 14);
    pt.lockTimer = 0.8;
    pt.mark = 0.8;
    pt.lockRot = Math.random() * TAU;
  }

  if (lockScan.life <= 0) {
    lockScan.active = false;
    /* 生成 6~10 条锁定射线 */
    const list = lockScan.hit;
    if (list.length > 0) {
      const count = Math.min(10, Math.max(6, Math.floor(list.length * 0.6)));
      for (let i = 0; i < count; i++) {
        const pt = list[Math.floor(i * list.length / count)];
        if (!pt) continue;
        s.rays.push({
          x1: lockScan.x, y1: lockScan.y,
          x2: pt.x, y2: pt.y,
          life: 0.3, maxLife: 0.3,
          color: CONFIG.cold.lock, lw: 1, alpha: 0.5
        });
      }
    }
    /* 全部被锁定光点同时闪一下 */
    for (let i = 0; i < list.length; i++) {
      triggerEcho(list[i], 3.4, 'white', 16);
    }
  }
}

/* =========================================================================
   分区八：左键定向波束 —— 松开爆发
   ========================================================================= */
function fireBeam(s, power) {
  const charge = s.charge;
  const M = s.input;
  const cx = s.originX, cy = s.originY;
  const angle = charge.sweepAngle;
  const len = CONFIG.beamFireLenBase + CONFIG.beamFireLenAdd * power;

  s.beams.push({
    x: cx, y: cy,
    angle: angle,
    len: len,
    traveled: 0,
    speed: CONFIG.beamFireSpeed,
    life: 0.55, maxLife: 0.55,
    power: power,
    halfAngle: CONFIG.beamFireHalfAngle,
    target: (charge.locked && charge.locked.lockTimer > 0) ? charge.locked : null,
    trailLife: 0.5
  });

  /* 波束过曝 */
  charge.overexpose = 0.05;

  /* 距离圈爆散 */
  burstRangeRings(s);

  /* 余韵：1s 内随机扫描线残影 */
  /* 局部常量，非动效状态：原型第 765 行，第 775 行用它选色，原样保留 */
  const mode = 0;
  for (let i = 0; i < 5; i++) {
    later(s, 0.12 + i * 0.18, function () {
      const a = Math.random() * TAU;
      const l = rand(60, 120);
      s.rays.push({
        x1: M.x, y1: M.y,
        x2: M.x + Math.cos(a) * l,
        y2: M.y + Math.sin(a) * l,
        life: 0.22, maxLife: 0.22,
        color: mode === 0 ? CONFIG.cold.main : CONFIG.warm.main,
        lw: 1, alpha: 0.35
      });
    });
  }
}

/* =========================================================================
   分区九：右键全向脉冲 —— 松开爆发
   ========================================================================= */
function firePulse(s, power, small) {
  const M = s.input;
  const cx = s.originX, cy = s.originY;
  const isSmall = !!small;

  /* 光核过曝 */
  s.rings.push({
    x: cx, y: cy, r0: 0, rMax: 70 + 90 * power,
    life: 0.28, maxLife: 0.28,
    color: 'white', lw: 6, alpha: 0.9,
    scan: false, hit: null
  });

  /* 全向脉冲波前 */
  s.pulses.push({
    x: cx, y: cy, r: 0,
    speed: CONFIG.pulseSpeedBase + CONFIG.pulseSpeedAdd * power,
    maxR: CONFIG.pulseMaxRadius,
    life: 1.1, maxLife: 1.1,
    power: power,
    lw: 4 + 4 * power,
    hit: []
  });

  /* 电离环 */
  const ionCount = isSmall ? 2 : 2 + Math.round(power);
  for (let i = 0; i < ionCount; i++) {
    s.rings.push({
      x: cx, y: cy, r0: 10, rMax: 200 + 500 * power,
      life: 0.8 + i * 0.1, maxLife: 0.8 + i * 0.1,
      color: i % 2 === 0 ? 'magenta' : 'white',
      lw: 2, alpha: 0.35,
      scan: false, hit: null
    });
  }

  /* 扫描线爆散成螺旋射线 */
  if (!isSmall) {
    const n = randInt(8, 16);
    for (let i = 0; i < n; i++) {
      s.spirals.push({
        x: cx, y: cy,
        angle: (i / n) * TAU + Math.random() * 0.4,
        r: 10,
        speed: rand(300, 600),
        rotSpd: rand(2, 5) * (Math.random() < 0.5 ? -1 : 1),
        life: 0.6, maxLife: 0.6,
        power: power
      });
    }
  }

  /* 距离圈爆散 */
  burstRangeRings(s);

  /* 余韵：1.5s 内小脉冲 */
  const pulseCount = isSmall ? 2 : 5;
  for (let i = 0; i < pulseCount; i++) {
    later(s, 0.3 + i * 0.3, function () {
      s.rings.push({
        x: M.x, y: M.y, r0: 5, rMax: 20,
        life: 0.35, maxLife: 0.35,
        color: CONFIG.warm.main, lw: 1.5, alpha: 0.5,
        scan: false, hit: null
      });
    });
  }
}

/* =========================================================================
   分区十：更新
   ========================================================================= */

/* 光点更新 */
function updatePoints(s, dt) {
  const charge = s.charge;
  for (let i = s.points.length - 1; i >= 0; i--) {
    const p = s.points[i];

    p.life -= dt;
    if (p.life <= 0) {
      if (charge.locked === p) charge.locked = null;
      s.points.splice(i, 1);
      s.pool.push(p);
      continue;
    }

    /* 漂移 + 阻尼 */
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    const damp = Math.exp(-dt * 0.7);
    p.vx *= damp;
    p.vy *= damp;

    /* 自转 */
    p.rot += p.rotSpd * dt;

    /* 回波回落 */
    if (p.echo > 0) {
      p.echo -= dt / CONFIG.echoDecayTime;
      if (p.echo < 0) p.echo = 0;
    }

    /* 扩散圈 */
    if (p.ringT > 0) p.ringT -= dt;

    /* 锁定计时 */
    if (p.lockTimer > 0) {
      p.lockTimer -= dt;
      p.lockRot += dt * 2.6;
      if (p.lockTimer <= 0) p.lockTimer = 0;
    }

    /* 标记点 */
    if (p.mark > 0) p.mark -= dt;

    /* 二次回波 */
    if (p.secondT > 0) {
      p.secondT -= dt;
      if (p.secondT <= 0) {
        triggerEcho(p, p.secondPow, p.secondCol, 12);
      }
    }
  }
}

/* 特效更新 */
function updateEffects(s, dt) {
  /* 扩散圈 */
  for (let i = s.rings.length - 1; i >= 0; i--) {
    const r = s.rings[i];
    r.life -= dt;
    if (r.life <= 0) s.rings.splice(i, 1);
  }

  /* 短射线 */
  for (let i = s.rays.length - 1; i >= 0; i--) {
    const r = s.rays[i];
    r.life -= dt;
    if (r.life <= 0) s.rays.splice(i, 1);
  }

  /* 定向波束 */
  for (let i = s.beams.length - 1; i >= 0; i--) {
    const b = s.beams[i];
    const prevT = b.traveled;
    b.traveled += b.speed * dt;
    if (b.traveled >= b.len) {
      b.traveled = b.len;
      b.life -= dt;
    }

    const halfA = b.halfAngle + 0.06;

    /* 打击链：沿途光点依次回波 */
    for (let j = 0; j < s.points.length; j++) {
      const pt = s.points[j];
      const dx = pt.x - b.x, dy = pt.y - b.y;
      const d = Math.hypot(dx, dy);
      if (d < prevT || d > b.traveled) continue;
      const a = Math.atan2(dy, dx);
      if (Math.abs(normAngle(a - b.angle)) > halfA) continue;

      /* 过曝为纯白 + 大尺寸回波扩散圈 */
      pt.echo = 1;
      pt.echoPow = 4;
      pt.echoCol = 'white';
      pt.ringT = 0.2;
      pt.ringMax = 30;
      pt.ringCol = 'white';
      /* 二次回波 */
      pt.secondT = 0.3;
      pt.secondPow = 1.5;
      pt.secondCol = b.power > 0.5 ? 'green' : 'cyan';
    }

    /* 锁定爆发：被锁目标炸开 */
    if (b.target && b.target.lockTimer > 0) {
      const dx = b.target.x - b.x, dy = b.target.y - b.y;
      const d = Math.hypot(dx, dy);
      if (d <= b.traveled) {
        explodeTarget(s, b.target, b.power);
        b.target = null;
      }
    }

    if (b.life <= 0 && b.traveled >= b.len) s.beams.splice(i, 1);
  }

  /* 全向脉冲 */
  for (let i = s.pulses.length - 1; i >= 0; i--) {
    const pu = s.pulses[i];
    const prevR = pu.r;
    pu.r += pu.speed * dt;
    pu.life -= dt;

    for (let j = 0; j < s.points.length; j++) {
      const pt = s.points[j];
      if (pu.hit.indexOf(pt) !== -1) continue;
      const dx = pt.x - pu.x, dy = pt.y - pu.y;
      const d = Math.hypot(dx, dy);
      if (d > pu.r || d < prevR - 50) continue;
      pu.hit.push(pt);

      /* 同时点亮全部被扫光点 */
      pt.echo = 1;
      pt.echoPow = 4;
      pt.echoCol = 'white';
      pt.ringT = 0.22;
      pt.ringMax = 30;
      pt.ringCol = 'magenta';
      pt.secondT = 0.3;
      pt.secondPow = 1.5;
      pt.secondCol = 'amber';

      /* 光点向外飞出 */
      const nx = d > 0.001 ? dx / d : Math.cos(Math.random() * TAU);
      const ny = d > 0.001 ? dy / d : Math.sin(Math.random() * TAU);
      const sp = 200 + 400 * pu.power;
      pt.vx += nx * sp;
      pt.vy += ny * sp;
    }

    if (pu.life <= 0 || pu.r > pu.maxR) s.pulses.splice(i, 1);
  }

  /* 螺旋射线 */
  for (let i = s.spirals.length - 1; i >= 0; i--) {
    const sp = s.spirals[i];
    sp.life -= dt;
    sp.r += sp.speed * dt;
    sp.angle += sp.rotSpd * dt;
    if (sp.life <= 0) s.spirals.splice(i, 1);
  }

  /* 延迟任务 */
  for (let i = s.deferred.length - 1; i >= 0; i--) {
    const d = s.deferred[i];
    d.t -= dt;
    if (d.t <= 0) {
      const fn = d.fn;
      s.deferred.splice(i, 1);
      fn();
    }
  }
}

/* 锁定目标炸开 */
function explodeTarget(s, pt, power) {
  const cx = pt.x, cy = pt.y;
  const n = randInt(20, 40);
  const spdBase = 200 + 300 * power;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU;
    const sp = rand(spdBase * 0.6, spdBase * 1.6);
    const np = spawnPoint(s, cx + rand(-3, 3), cy + rand(-3, 3));
    if (!np) break;
    np.vx = Math.cos(a) * sp;
    np.vy = Math.sin(a) * sp;
    np.echo = 1;
    np.echoPow = 3;
    np.echoCol = 'green';
    np.ringT = CONFIG.echoRingLife;
    np.ringMax = 18;
    np.ringCol = 'green';
    np.lockTimer = rand(0.25, 0.5);
    np.lockRot = Math.random() * TAU;
  }
  /* 爆炸核心闪光 */
  s.rings.push({
    x: cx, y: cy, r0: 4, rMax: 40 + 40 * power,
    life: 0.35, maxLife: 0.35,
    color: CONFIG.cold.lock, lw: 3, alpha: 0.8,
    scan: false, hit: null
  });
}

/* 蓄力状态更新 */
function updateCharge(s, dt) {
  const charge = s.charge;
  const M = s.input;

  /* 微震衰减 */
  charge.shakeX *= Math.exp(-dt * 14);
  charge.shakeY *= Math.exp(-dt * 14);

  if (!charge.active) {
    s.originX = M.x;
    s.originY = M.y;
    return;
  }

  charge.t += dt;
  const t = Math.min(charge.t, CONFIG.chargeMax);
  const p = t / CONFIG.chargeMax;
  charge.power = Math.pow(clamp(t, 0, CONFIG.chargeMax) / CONFIG.chargeMax, 1.6);

  /* 微震：蓄力超过 55% 后光标 1~3px 高频抖动 */
  if (p > 0.55) {
    const amp = 1 + (p - 0.55) / 0.45 * 2;
    const tt = s.time * 62;
    charge.shakeX = Math.sin(tt) * amp;
    charge.shakeY = Math.cos(tt * 1.27) * amp;
  }

  s.originX = M.x + charge.shakeX;
  s.originY = M.y + charge.shakeY;

  if (charge.overexpose > 0) charge.overexpose -= dt;

  if (charge.mode === 0) updateLeftBeam(s, dt, p);
  else updateRightPulse(s, dt, p);
}

/* =========================================================================
   分区十一：渲染
   ========================================================================= */
function drawTex(s, colorName, variant, x, y, size, alpha) {
  const t = s.tex[colorName + '_' + variant + '_32'];
  if (!t || alpha <= 0.003) return;
  const ctx = s.ctx;
  ctx.globalAlpha = alpha > 1 ? 1 : alpha;
  const h = size * 0.5;
  ctx.drawImage(t, x - h, y - h, size, size);
}

/* 光点渲染 */
function drawPoints(s) {
  const ctx = s.ctx;

  for (let i = 0; i < s.points.length; i++) {
    const p = s.points[i];
    const lifeFrac = p.life / p.maxLife;

    /* 生命淡出 */
    let fade = 1;
    if (lifeFrac < 0.22) fade = lifeFrac / 0.22;

    const echo = p.echo;
    let col, variant, alpha;

    if (echo > 0.01) {
      col = p.echoCol;
      variant = 'c';
      alpha = CONFIG.idleAlpha + echo * (p.echoPow * 0.2);
      if (alpha > 1) alpha = 1;
    } else {
      col = 'cyan';
      variant = 's';
      alpha = CONFIG.idleAlpha;
    }
    alpha *= fade;

    const size = p.size * (echo > 0.01 ? lerp(4.5, 8.2, echo) : 4.5);
    drawTex(s, col, variant, p.x, p.y, size, alpha);

    /* 回波扩散圈 */
    if (p.ringT > 0) {
      const k = 1 - p.ringT / CONFIG.echoRingLife;
      const rr = lerp(CONFIG.echoRingFrom, p.ringMax, k);
      ctx.globalAlpha = (1 - k) * 0.85;
      ctx.strokeStyle = COLOR_HEX[p.ringCol] || '#FFFFFF';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, rr, 0, TAU);
      ctx.stroke();
    }

    /* 锁定框 */
    if (p.lockTimer > 0) {
      drawLockBox(s, p);
    }

    /* 标记点（小十字） */
    if (p.mark > 0) {
      const k = p.mark / 0.8;
      const sm = 5;
      ctx.globalAlpha = k * 0.9;
      ctx.strokeStyle = CONFIG.cold.lock;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.x - sm, p.y); ctx.lineTo(p.x + sm, p.y);
      ctx.moveTo(p.x, p.y - sm); ctx.lineTo(p.x, p.y + sm);
      ctx.stroke();
    }
  }
}

/* 左键波束渲染 */
function drawLeftBeam(s, p) {
  const ctx = s.ctx;
  const charge = s.charge;
  const cx = s.originX, cy = s.originY;
  const half = charge.spread;
  const base = charge.baseAngle;
  const R = CONFIG.scanRange + p * 60;

  /* 低频亮度脉动 ~1Hz */
  const pulse = 0.78 + 0.22 * Math.sin(s.time * TAU);

  /* 过曝 */
  const over = charge.overexpose > 0;

  /* 扇区填充 */
  const fillA = (0.08 + 0.07 * p) * pulse * (over ? 4 : 1);
  ctx.globalAlpha = 1;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, R, base - half, base + half);
  ctx.closePath();
  ctx.fillStyle = over
    ? rgba('#FFFFFF', Math.min(0.9, fillA))
    : rgba(CONFIG.cold.main, fillA);
  ctx.fill();

  /* 扇区网格线 */
  ctx.globalAlpha = Math.min(1, fillA * 2.4);
  ctx.strokeStyle = rgba(CONFIG.cold.main, 0.45);
  ctx.lineWidth = 1;
  ctx.beginPath();
  const segs = 8;
  for (let i = 0; i <= segs; i++) {
    const a = base - half + (2 * half) * (i / segs);
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
  }
  ctx.stroke();

  /* 两条边界线 */
  ctx.globalAlpha = over ? 1 : 0.6;
  ctx.strokeStyle = over ? '#FFFFFF' : CONFIG.cold.main;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(base - half) * R, cy + Math.sin(base - half) * R);
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(base + half) * R, cy + Math.sin(base + half) * R);
  ctx.stroke();

  /* 中心扫描线 */
  const sweepA = charge.sweepAngle;
  const lw = p > 0.6 ? 4 : 2;
  ctx.globalAlpha = Math.min(1, 0.9 * pulse + (over ? 0.5 : 0));
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = over ? lw * 1.6 : lw;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(sweepA) * R, cy + Math.sin(sweepA) * R);
  ctx.stroke();

  /* 沿扫描线的扫描光斑（扫描线厚度） */
  for (let i = 1; i <= 10; i++) {
    const d = (i / 10) * R;
    const x = cx + Math.cos(sweepA) * d;
    const y = cy + Math.sin(sweepA) * d;
    const sz = (6 + 5 * (1 - i / 10)) * (1 + p * 0.5);
    drawTex(s, 'white', 's', x, y, sz * 2, 0.22 * pulse);
  }

  /* 蓄力超过 1.5s：边界电离感 */
  if (p > 0.6 && !over) {
    const ion = (p - 0.6) / 0.4;
    for (let sgn = -1; sgn <= 1; sgn += 2) {
      const a = base + sgn * half;
      for (let i = 1; i <= 6; i++) {
        const d = (i / 6) * R;
        const jx = (Math.random() - 0.5) * 6 * ion;
        const jy = (Math.random() - 0.5) * 6 * ion;
        drawTex(s, 'cyan', 's',
          cx + Math.cos(a) * d + jx,
          cy + Math.sin(a) * d + jy,
          14, 0.09 * ion * pulse);
      }
    }
  }
}

/* 右键全向扫描渲染 */
function drawRightScan(s, p) {
  const ctx = s.ctx;
  const cx = s.originX, cy = s.originY;
  const R = CONFIG.scanRangeRight;
  const a = s.charge.sweepAngle;
  const pulse = 0.8 + 0.2 * Math.sin(s.time * TAU);

  /* 扫描余晖扇区（向后 30°，alpha 0.15 → 0，0.5s 衰减） */
  const segs = 15;
  const segW = (30 * Math.PI / 180) / segs;
  for (let i = 0; i < segs; i++) {
    const a0 = a - (i + 1) * segW;
    const a1 = a - i * segW;
    const k = 1 - i / segs;
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, a0, a1);
    ctx.closePath();
    ctx.fillStyle = rgba(CONFIG.warm.main, 0.15 * k * k);
    ctx.fill();
  }

  /* 扫描线 */
  ctx.globalAlpha = 0.9 * pulse;
  ctx.strokeStyle = CONFIG.warm.main;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
  ctx.stroke();

  /* 沿线扫描光斑 */
  for (let i = 1; i <= 12; i++) {
    const d = (i / 12) * R;
    const x = cx + Math.cos(a) * d;
    const y = cy + Math.sin(a) * d;
    const sz = (6 + 5 * (1 - i / 12)) * (1 + p * 0.5);
    drawTex(s, 'amber', 's', x, y, sz * 2, 0.2 * pulse);
  }

  /* 中心光核 */
  const coreR = lerp(5, 20, p);
  const coreFreq = 6 + p * 18;
  const pulseF = 1 + 0.1 * Math.sin(s.time * coreFreq * TAU);
  const csz = coreR * 2 * pulseF;
  drawTex(s, 'orange', 'c', cx, cy, csz * 2.6, 0.42 + 0.2 * p);
  drawTex(s, 'amber', 'c', cx, cy, csz * 1.7, 0.6 + 0.2 * p);
  drawTex(s, 'white', 'c', cx, cy, csz * 0.95, 0.85);

  /* 能量射线 */
  const rayCount = Math.round(lerp(8, 16, p));
  const rot = s.time * 0.6;
  ctx.lineWidth = 1;
  ctx.strokeStyle = p > 0.6 ? CONFIG.warm.magenta : CONFIG.warm.main;
  ctx.globalAlpha = 0.22 + 0.28 * p;
  ctx.beginPath();
  for (let i = 0; i < rayCount; i++) {
    const ang = (i / rayCount) * TAU + rot;
    const len = lerp(15, 40, p) * (0.72 + 0.28 * Math.sin(s.time * 3 + i * 1.7));
    const r0 = coreR * 0.85;
    const r1 = coreR * 0.85 + len;
    ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
    ctx.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
  }
  ctx.stroke();

  /* 蓄力超过 1.5s：光核电离感 */
  if (p > 0.6) {
    const ion = (p - 0.6) / 0.4;
    for (let i = 0; i < 6; i++) {
      const ang = Math.random() * TAU;
      const d = coreR * rand(1.1, 2.2);
      drawTex(s, 'magenta', 's',
        cx + Math.cos(ang) * d,
        cy + Math.sin(ang) * d,
        26, 0.10 * ion);
    }
  }
}

/* 特效渲染 */
function drawEffects(s) {
  const ctx = s.ctx;

  /* --- 扩散圈 --- */
  for (let i = 0; i < s.rings.length; i++) {
    const r = s.rings[i];
    const k = 1 - r.life / r.maxLife;
    const rr = lerp(r.r0, r.rMax, k);
    const a = (1 - k) * (r.alpha || 0.6);
    if (a <= 0.003) continue;
    ctx.globalAlpha = a;
    ctx.strokeStyle = COLOR_HEX[r.color] || r.color;
    ctx.lineWidth = r.lw || 1;
    ctx.beginPath();
    ctx.arc(r.x, r.y, rr, 0, TAU);
    ctx.stroke();
  }

  /* --- 短射线 --- */
  for (let i = 0; i < s.rays.length; i++) {
    const r = s.rays[i];
    const k = r.life / r.maxLife;
    ctx.globalAlpha = k * (r.alpha || 0.5);
    ctx.strokeStyle = COLOR_HEX[r.color] || r.color;
    ctx.lineWidth = r.lw || 1;
    ctx.beginPath();
    ctx.moveTo(r.x1, r.y1);
    ctx.lineTo(r.x2, r.y2);
    ctx.stroke();
  }

  /* --- 定向波束 --- */
  for (let i = 0; i < s.beams.length; i++) {
    const b = s.beams[i];
    const k = clamp(b.life / b.maxLife, 0, 1);
    const ca = Math.cos(b.angle), sa = Math.sin(b.angle);
    const ex = b.x + ca * b.traveled;
    const ey = b.y + sa * b.traveled;
    const w = b.traveled * Math.tan(b.halfAngle) + 3;

    /* 锥形主体 */
    ctx.globalAlpha = 1;
    const grd = ctx.createLinearGradient(b.x, b.y, ex, ey);
    grd.addColorStop(0, rgba('#FFFFFF', 0.75 * (0.4 + 0.6 * k)));
    grd.addColorStop(0.35, rgba(CONFIG.cold.main, 0.5 * (0.4 + 0.6 * k)));
    grd.addColorStop(1, rgba(CONFIG.cold.main, 0.05));
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(ex - sa * w, ey + ca * w);
    ctx.lineTo(ex + sa * w, ey - ca * w);
    ctx.closePath();
    ctx.fill();

    /* 波束中心线 */
    ctx.globalAlpha = 0.9 * (0.4 + 0.6 * k);
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    /* 密集扫描光斑 */
    const steps = Math.max(2, Math.floor(b.traveled / 26));
    for (let st = 0; st <= steps; st++) {
      const d = (st / steps) * b.traveled;
      const jitter = (Math.random() - 0.5) * w * 1.2;
      const x = b.x + ca * d - sa * jitter;
      const y = b.y + sa * d + ca * jitter;
      const sz = 10 + 14 * (1 - st / steps) * (1 + b.power);
      drawTex(s, st % 3 === 0 ? 'white' : 'cyan', 's', x, y, sz, 0.28 * k);
    }

    /* 波束残影 */
    ctx.globalAlpha = 0.28 * k;
    ctx.strokeStyle = CONFIG.cold.main;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  }

  /* --- 全向脉冲波前 --- */
  for (let i = 0; i < s.pulses.length; i++) {
    const pu = s.pulses[i];
    const k = clamp(pu.life / pu.maxLife, 0, 1);
    const lw = pu.lw * k;

    /* 外层辉光 */
    ctx.globalAlpha = 0.25 * k;
    ctx.strokeStyle = CONFIG.warm.main;
    ctx.lineWidth = lw * 3;
    ctx.beginPath();
    ctx.arc(pu.x, pu.y, pu.r, 0, TAU);
    ctx.stroke();

    /* 炽白波前 */
    ctx.globalAlpha = 0.85 * k;
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = Math.max(1, lw);
    ctx.beginPath();
    ctx.arc(pu.x, pu.y, pu.r, 0, TAU);
    ctx.stroke();

    /* 品红内环 */
    if (pu.power > 0.35) {
      ctx.globalAlpha = 0.3 * k;
      ctx.strokeStyle = CONFIG.warm.magenta;
      ctx.lineWidth = Math.max(1, lw * 0.6);
      ctx.beginPath();
      ctx.arc(pu.x, pu.y, pu.r * 0.85, 0, TAU);
      ctx.stroke();
    }
  }

  /* --- 螺旋爆散射线 --- */
  for (let i = 0; i < s.spirals.length; i++) {
    const sp = s.spirals[i];
    const k = clamp(sp.life / sp.maxLife, 0, 1);
    const ca = Math.cos(sp.angle), sa = Math.sin(sp.angle);
    const segLen = 46;
    const steps = 5;
    for (let j = 0; j < steps; j++) {
      const d = sp.r + (j / steps) * segLen;
      const x = sp.x + ca * d;
      const y = sp.y + sa * d;
      const al = 0.35 * k * (1 - j / steps);
      drawTex(s, 'white', 's', x, y, 16, al);
    }
    ctx.globalAlpha = 0.4 * k;
    ctx.strokeStyle = CONFIG.warm.bright;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(sp.x + ca * sp.r, sp.y + sa * sp.r);
    ctx.lineTo(sp.x + ca * (sp.r + segLen), sp.y + sa * (sp.r + segLen));
    ctx.stroke();
  }

  /* --- 单击锁定扫描线 --- */
  const lockScan = s.lockScan;
  if (lockScan.active) {
    const k = clamp(lockScan.life / lockScan.maxLife, 0, 1);
    const a = lockScan.angle;
    const cx = lockScan.x, cy = lockScan.y;
    const R = CONFIG.lockScanRadius;
    ctx.globalAlpha = 0.9 * k;
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    ctx.stroke();

    /* 弧线余晖 */
    ctx.globalAlpha = 0.35 * k;
    ctx.strokeStyle = CONFIG.cold.lock;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.86, Math.max(0, a - 0.9), a);
    ctx.stroke();

    /* 沿线光斑 */
    for (let i = 1; i <= 8; i++) {
      const d = (i / 8) * R;
      drawTex(s, 'white', 's',
        cx + Math.cos(a) * d,
        cy + Math.sin(a) * d,
        14, 0.25 * k);
    }
  }
}

/* 主渲染（原型 render()，第 1508-1552 行） */
function renderScene(s) {
  const ctx = s.ctx;
  const charge = s.charge;

  // 清屏：原型就是 clearRect，绘制中没有任何整屏铺底，不会遮住宿主页面
  ctx.clearRect(0, 0, s.W, s.H);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  const p = charge.active
    ? Math.min(charge.t, CONFIG.chargeMax) / CONFIG.chargeMax
    : 0;

  /* 距离圈：仅蓄力时绘制 */
  if (charge.active) {
    const count = Math.round(lerp(CONFIG.ringMinCount, CONFIG.ringMaxCount, p));
    drawRangeRings(s, count, charge.mode === 0 ? CONFIG.cold : CONFIG.warm, p);
  }

  /* 扫描可视化 */
  if (charge.active && charge.overexpose <= 0) {
    if (charge.mode === 0) drawLeftBeam(s, p);
    else drawRightScan(s, p);
  } else if (charge.active && charge.overexpose > 0) {
    /* 过曝一帧：整体变白 */
    if (charge.mode === 0) {
      ctx.globalAlpha = 0.8;
      const cx = s.originX, cy = s.originY;
      const R = CONFIG.scanRange + 60;
      const half = charge.spread;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, charge.baseAngle - half, charge.baseAngle + half);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fill();
    } else {
      drawTex(s, 'white', 'c', s.originX, s.originY, 120, 0.85);
    }
  }

  /* 光点 */
  drawPoints(s);

  /* 特效 */
  drawEffects(s);

  ctx.restore();
}

export class CursorRadar extends CursorEffectElement {
  // 原型用的是 mousemove / mousedown / mouseup（第 731-733 行），不是 pointer 事件族，
  // 不声明这一行，基类会去监听 pointermove，动效将完全收不到鼠标输入。
  inputFamily = 'mouse';

  /* =========================================================================
     初始化
     ========================================================================= */
  // 只建池与状态，不注册任何监听（监听、DPR 缩放、rAF 全归基类）
  setup({ canvas, ctx, width, height, input }) {
    // 与原型一致：初始光标位置取视口中心（原型第 214 行）。
    // 基类的 input 从 (0, 0) 起算，若不在这里对齐，首帧的位移会按「从左上角跳过来」计算，
    // 拖尾生成量会和原型不同。trailFromX / trailFromY 一并对齐，首帧就不会凭空生成一段拖尾。
    input.x = input.lx = width * 0.5;
    input.y = input.ly = height * 0.5;

    const doc = canvas.ownerDocument;

    const points = [];
    const pool = [];
    for (let i = 0; i < CONFIG.maxPoints; i++) pool.push(createPoint());

    return {
      // 本实例的画布上下文（已按 DPR 缩放过，统一使用 CSS 像素坐标）
      ctx,

      // 画布尺寸（CSS 像素），由基类 onResize 同步
      W: width,
      H: height,

      input,

      // 离屏贴图的创建者：用元素自身的 ownerDocument，不碰全局对象，也绝不挂进 DOM
      doc,

      // 预烘焙贴图（原型的模块级 TEX，移植后每实例一份）
      tex: prebakeTextures(doc),

      /* 全局状态（原型第 210-233 行） */
      time: 0,
      originX: 0,
      originY: 0,

      // 光标方向 + 拖尾累加器（原型 mouse 对象中动效真正用到的两项）。
      // 位置一律取基类的 input.x / input.y，不再另存一份，避免按键回调读到上一帧的旧值。
      mouse: {
        dirX: 1, dirY: 0,
        trailAcc: 0
      },

      // 拖尾的帧级锚点：上一次生成拖尾时的光标位置（等价于「本帧开始位置」）。
      // 用基类的 frameLx / frameLy 无法在多事件帧里拿到整帧位移，故自持一份。
      trailFromX: width * 0.5,
      trailFromY: height * 0.5,

      charge: {
        active: false,
        mode: 0,              // 0 = 左键定向波束，2 = 右键全向脉冲
        t: 0,
        power: 0,
        spread: Math.PI / 3,  // 波束半角
        baseAngle: 0,         // 波束中心方向
        sweepAngle: 0,        // 当前扫描线角度
        sweepPhase: 0,        // 扫描相位
        locked: null,         // 当前锁定的光点
        lockPulse: 0,
        overexpose: 0,        // 松开瞬间过曝计时
        shakeX: 0,
        shakeY: 0
      },

      /* 分区一：光点池 */
      points,
      pool,

      /* 分区二：特效容器 */
      rings: [],       // 通用扩散圆环 {x,y,r0,rMax,life,maxLife,color,lw,alpha,scan,hit}
      rays: [],        // 短线段 {x1,y1,x2,y2,life,maxLife,color,lw,alpha}
      beams: [],       // 定向波束
      pulses: [],      // 全向脉冲波前
      spirals: [],     // 螺旋爆散射线
      deferred: [],    // 延迟任务

      /* 分区四：单击锁定扫描（原型第 611-617 行） */
      lockScan: {
        active: false,
        x: 0, y: 0,
        prev: 0, angle: 0,
        life: 0, maxLife: 0.3,
        hit: []
      }
    };
  }

  /* =========================================================================
     分区七：鼠标输入（原型第 542-735 行）
     —— 方向取事件级锚点 lx/ly、拖尾距离取 state 自持的帧级锚点
        （trailFromX / trailFromY），其余处理逻辑与原型逐行对应
     ========================================================================= */

  /* 原型在 mousemove 回调里更新方向（第 547-549 行）：
     d > 0.01 时按「上一事件位置 → 当前位置」归一化，否则保留上一次方向。
     基类的 input.lx / ly 就是上一事件位置（原型第 567-568 行在回调内推进锚点），
     因此一帧内取到的正是原型最后一次 mousemove 的那一段位移，口径完全一致。 */
  _syncDir(s) {
    const M = s.input;
    const dx = M.x - M.lx, dy = M.y - M.ly;
    const d = Math.hypot(dx, dy);
    if (d > 0.01) {
      s.mouse.dirX = dx / d;
      s.mouse.dirY = dy / d;
    }
  }

  /* 原型在 mousemove 里沿轨迹生成「待扫描」暗点（第 551-564 行） */
  _emitTrail(s) {
    const M = s.input;
    this._syncDir(s);

    /* 拖尾距离用帧级锚点：原型对每个移动事件都执行 mouse.trailAcc += d（第 552 行），
       一帧内全部事件的距离之和就是整帧位移。锚点自持在 state 上（trailFromX / trailFromY）：
       基类的 frameLx / frameLy 在 update() 时刻等于 lx / ly，多事件帧只能给到最后一段位移。
       生成点沿「上一帧位置 → 当前位置」这段铺开，与原型沿事件轨迹铺开等价。 */
    const fromX = s.trailFromX, fromY = s.trailFromY;
    const dx = M.x - fromX, dy = M.y - fromY;
    const d = Math.hypot(dx, dy);
    /* 锚点每帧推进：原型里 d <= 0.01 的事件不累加距离，但 mouse.x 照常前进（第 567-568 行） */
    s.trailFromX = M.x;
    s.trailFromY = M.y;
    if (!(d > 0.01)) return;

    const mouse = s.mouse;
    mouse.trailAcc += d;
    const step = CONFIG.trailSpawnDist;
    if (mouse.trailAcc >= step) {
      let n = Math.floor(mouse.trailAcc / step);
      mouse.trailAcc -= n * step;
      if (n > CONFIG.trailMaxPerFrame) n = CONFIG.trailMaxPerFrame;
      for (let i = 1; i <= n; i++) {
        const t = i / (n + 1);
        const x = fromX + dx * t + rand(-2.5, 2.5);
        const y = fromY + dy * t + rand(-2.5, 2.5);
        spawnPoint(s, x, y);
      }
    }
  }

  onPointerDown(e) {
    const s = this.state;
    if (!s) return;
    const charge = s.charge;

    // 原型的按下原点与探测中心取的是最后一次 mousemove 的位置（mouse.x / mouse.y），
    // 这里用基类的 input.x / input.y（同样由移动事件写入，语义一致）
    if (e.button === 0) {
      /* 左键：单击探测 + 扫描锁定 */
      doClickDetect(s, s.input.x, s.input.y);

      /* 进入定向波束蓄力 */
      this._syncDir(s);
      charge.active = true;
      charge.mode = 0;
      charge.t = 0;
      charge.power = 0;
      charge.baseAngle = Math.atan2(s.mouse.dirY, s.mouse.dirX);
      charge.sweepAngle = charge.baseAngle;
      charge.sweepPhase = 0;
      charge.spread = CONFIG.beamSpreadStart * 0.5;
      charge.locked = null;
      charge.lockPulse = 0;
      charge.overexpose = 0;
    } else if (e.button === 2) {
      charge.active = true;
      charge.mode = 2;
      charge.t = 0;
      charge.power = 0;
      charge.sweepAngle = 0;
      charge.locked = null;
      charge.overexpose = 0;
    }
  }

  onPointerUp(e) {
    const s = this.state;
    if (!s) return;
    const charge = s.charge;
    if (!charge.active) return;
    if ((e.button === 0 && charge.mode !== 0) || (e.button === 2 && charge.mode !== 2)) return;

    const t = charge.t;
    const power = charge.power;

    if (t < CONFIG.clickThreshold) {
      /* 视为普通单击 */
      if (charge.mode === 2) firePulse(s, 0.12, true);
    } else {
      if (charge.mode === 0) fireBeam(s, power);
      else firePulse(s, power, false);
    }

    charge.active = false;
    charge.locked = null;
    charge.overexpose = 0;
    for (let i = 0; i < s.points.length; i++) s.points[i].inBeam = 0;
  }

  // 失焦时按键状态已丢失：原型 window blur 的处理（第 719-729 行 / 第 735 行）
  onBlur() {
    const s = this.state;
    if (!s) return;
    const charge = s.charge;
    charge.active = false;
    charge.t = 0;
    charge.power = 0;
    charge.locked = null;
    charge.overexpose = 0;
    s.lockScan.active = false;
    for (let i = 0; i < s.points.length; i++) {
      s.points[i].inBeam = 0;
    }
  }

  /* =========================================================================
     尺寸 —— 只同步动效自己的 W / H，画布尺寸与 DPR 由基类维护
     ========================================================================= */
  onResize(width, height) {
    const s = this.state;
    if (!s) return;
    s.W = width;
    s.H = height;
  }

  /* =========================================================================
     分区十二：更新（原型的渲染循环体，第 1559-1573 行）
     帧率钳制、时间基准、标签页显隐由基类负责；这里保持原型的调用顺序。
     ========================================================================= */
  update(dt, s) {
    if (!s) return;

    s.time += dt;

    // 原型在 mousemove 里生成拖尾（逐事件），移植后每帧补一次
    this._emitTrail(s);

    updateCharge(s, dt);
    updatePoints(s, dt);
    updateScanRings(s);
    updateLockScan(s, dt);
    updateEffects(s, dt);
  }

  /* =========================================================================
     渲染
     ========================================================================= */
  render(s) {
    if (!s) return;
    renderScene(s);
  }
}

if (!customElements.get('cursor-radar')) {
  customElements.define('cursor-radar', CursorRadar);
}

export default CursorRadar;
