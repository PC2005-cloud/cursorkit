/**
 * cursor-snow —— 鼠标光标雪花动效。
 *
 * 由 html/雪花.html 原型移植：算法流程、数值、视觉表现与原文件一一对应。
 * 作为光标层组件，原型页面自身的行为已剔除：
 *   - 不携带深色页面底色（基类保证 canvas 透明，绘制中也没有整屏填底）；
 *   - 不拦截 contextmenu，宿主页面的右键菜单不受影响；
 *   - 画布创建、DPR 适配、监听注册、rAF 循环均由基类负责。
 *
 * 所有运行状态都放在 setup() 返回的 state 上，多实例互不干扰。
 */

import { CursorEffectElement } from '../core/base.js';
import { TAU, clamp, lerp, rand, randInt, mixColor } from '../core/utils.js';

// ==== 配置 ====
const CONFIG = {
  // —— 粒子池 ——
  maxParticles: 2500,                 // 粒子池预分配上限（超出后回收最老粒子）

  // —— 配色（雪花主题）——
  colors: {
    white:      [255, 255, 255],      // 主白 #FFFFFF
    iceBlue:    [191, 233, 255],      // 冰蓝 #BFE9FF
    skyBlue:    [127, 200, 248],      // 天蓝 #7FC8F8
    deepIce:    [ 79, 168, 224],      // 深冰蓝 #4FA8E0
    coldPurple: [201, 182, 255]       // 冷紫 #C9B6FF（点缀）
  },

  // —— 鼠标拖尾 ——
  trail: {
    minSpeed: 25,        // 低于此速度不生成拖尾（px/s）
    rateFactor: 0.55,    // 生成速率 = 速度 × 该系数（个/秒）
    maxRate: 420,        // 生成速率上限（个/秒）
    maxPerFrame: 14,     // 单帧生成上限
    speedFactor: 0.15,   // 鼠标速度转化为粒子初速的比例
    scatter: 55,         // 随机散射速度（px/s）
    width: 13,           // 拖尾横向散布半宽（px）
    lifeMin: 0.6,        // 最短寿命（s）
    lifeMax: 1.4         // 最长寿命（s）
  },

  // —— 单击爆发（交互二）——
  burst: {
    countMin: 20,
    countMax: 30,
    speed: 220,          // 基础放射速度（px/s）
    lifeMin: 0.35,
    lifeMax: 0.6,
    ringStart: 6,        // 霜环起始半径（px）
    ringEnd: 70,         // 霜环结束半径（px）
    ringWidth: 3,        // 霜环起始线宽（px）
    ringLife: 0.42,      // 霜环寿命（s）
    bigMin: 3,           // 大雪花数量下限
    bigMax: 5            // 大雪花数量上限
  },

  // —— 单击对已有拖尾的冲击波（交互三）——
  shock: {
    radius: 160,         // 冲击半径（px）
    force: 950,          // 最大径向冲量（px/s）
    brightTime: 0.2      // 高亮回落时间（s）
  },

  // —— 蓄力通用 ——
  charge: {
    fullTime: 2.5,       // 完整蓄力时长（s）
    minTime: 0.12,       // 低于此值视为普通单击（s）
    powerExp: 1.6,       // power 曲线指数
    shakeStart: 0.6,     // 微震触发的蓄力进度
    shakeAmp: 3,         // 微震最大幅度（px）
    pulseBase: 2.0,      // 呼吸脉动基础频率（Hz）
    pulseGain: 3.5       // 脉动频率随蓄力增量（Hz）
  },

  // —— 左键蓄力：向心雪球 ——
  leftHold: {
    spawnRate: 260,      // 每秒吸附粒子数
    spinMin: 2.0,        // 基础角速度（rad/s）
    spinGain: 7.0,       // 角速度随蓄力增量
    radMinMin: 60,       // 生成半径下限（弱蓄力）
    radMinMax: 130,      // 生成半径下限（满蓄力）
    radMaxMin: 120,      // 生成半径上限（弱蓄力）
    radMaxMax: 210,      // 生成半径上限（满蓄力）
    coreMin: 5,          // 核心收束半径下限（px）
    coreMax: 26,         // 核心收束半径上限（px）
    releaseBase: 60,     // 爆发基础粒子数
    releaseExtra: 240,   // 爆发额外粒子数 = 240 × power
    speedMin: 200,       // 爆发基础速度（px/s）
    speedGain: 900       // 爆发速度增益（px/s）
  },

  // —— 右键蓄力：双螺旋暴风雪 ——
  rightHold: {
    spawnRate: 280,
    spinMin: 1.6,
    spinGain: 6.0,
    radMinMin: 90,
    radMinMax: 160,
    radMaxMin: 150,
    radMaxMax: 240,
    coreMin: 14,
    coreMax: 48,
    coneAngle: 50 * Math.PI / 180,  // 锥形喷流总角度
    releaseBase: 60,
    releaseExtra: 240,
    speedMin: 400,
    speedGain: 1200,
    needleBase: 20,      // 冰针基础数量
    needleExtra: 80,     // 冰针额外数量 = 80 × power
    needleSpeedMin: 600,
    needleSpeedGain: 1100
  },

  // —— 爆发余波 ——
  afterglow: {
    time: 0.4,           // 余波持续时间（s）
    rate: 90             // 余波粒子生成速率（个/秒）
  }
};

const COL = CONFIG.colors;
const CHARGE_STOPS = [COL.white, COL.iceBlue, COL.skyBlue, COL.deepIce];
const RIGHT_STOPS = [COL.deepIce, COL.coldPurple];

const MAXP = CONFIG.maxParticles;
const MAX_RINGS = 48;

// ==== 工具函数（颜色）====
// 沿蓄力色带取色（0 → 1）
function chargeColor(t) {
  t = clamp(t, 0, 1);
  const s = t * (CHARGE_STOPS.length - 1);
  const i = Math.min(CHARGE_STOPS.length - 2, Math.floor(s));
  return mixColor(CHARGE_STOPS[i], CHARGE_STOPS[i + 1], s - i);
}

// 右键蓄力色带（深冰蓝 → 冷紫）
function rightChargeColor(t) {
  t = clamp(t, 0, 1);
  return mixColor(RIGHT_STOPS[0], RIGHT_STOPS[1], t);
}

function pickTrailColor() {
  const r = Math.random();
  if (r < 0.60) return COL.white;
  if (r < 0.88) return COL.iceBlue;
  return COL.skyBlue;
}

function pickFlakeColor() {
  const r = Math.random();
  if (r < 0.35) return COL.white;
  if (r < 0.80) return COL.iceBlue;
  if (r < 0.95) return COL.skyBlue;
  return COL.coldPurple;
}

// ==== 粒子池（纯函数：只操作传入的粒子对象）====
function createEmpty() {
  return {
    alive: false, type: 0, mode: 0,
    x: 0, y: 0, vx: 0, vy: 0,
    life: 0, maxLife: 1,
    size: 2, rot: 0, rotV: 0,
    r: 255, g: 255, b: 255,
    baseAlpha: 1, drag: 1, gravity: 0,
    swayAmp: 0, swayFreq: 0, swayPhase: 0, swayX: 0,
    bright: 0,
    ang: 0, rad: 0, radBase: 20, spinMul: 1,
    lineWidth: 1.4
  };
}

function resetParticle(p, x, y) {
  p.alive = true;
  p.type = 0;
  p.mode = 0;
  p.x = x; p.y = y;
  p.vx = 0; p.vy = 0;
  p.life = 0;
  p.maxLife = 1;
  p.size = 2;
  p.rot = Math.random() * TAU;
  p.rotV = 0;
  p.r = 255; p.g = 255; p.b = 255;
  p.baseAlpha = 1;
  p.drag = 1;
  p.gravity = 0;
  p.swayAmp = 0;
  p.swayFreq = 0;
  p.swayPhase = Math.random() * TAU;
  p.swayX = 0;
  p.bright = 0;
  p.ang = 0;
  p.rad = 0;
  p.radBase = 20;
  p.spinMul = 1;
  p.lineWidth = 1.4;
}

function setColor(p, c) {
  p.r = c[0]; p.g = c[1]; p.b = c[2];
}

// ==== 绘制（只读 state，不修改）====
function drawFlake(ctx, x, y, size, rot, a, r, g, b) {
  const L6 = size;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const ang = rot + i * Math.PI / 3;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    ctx.moveTo(x, y);
    ctx.lineTo(x + ca * L6, y + sa * L6);
    // 每条主枝两侧各 2 段短侧枝
    for (let j = 0; j < 2; j++) {
      const tt = j === 0 ? 0.45 : 0.72;
      const bx = x + ca * L6 * tt;
      const by = y + sa * L6 * tt;
      const bl = L6 * (j === 0 ? 0.32 : 0.22);
      for (let s = -1; s <= 1; s += 2) {
        const a2 = ang + s * 1.05;
        ctx.moveTo(bx, by);
        ctx.lineTo(bx + Math.cos(a2) * bl, by + Math.sin(a2) * bl);
      }
    }
  }
  ctx.strokeStyle = 'rgba(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ',' + a.toFixed(3) + ')';
  ctx.lineWidth = Math.max(0.6, size * 0.13);
  ctx.stroke();
}

function drawParticle(ctx, p) {
  const lt = p.life / p.maxLife;
  let a = Math.min(1, p.life * 10) * Math.pow(1 - lt, 1.35) * p.baseAlpha;
  if (a <= 0.004) return;

  let r = p.r, g = p.g, b = p.b;
  if (p.bright > 0) {
    const t = Math.min(1, p.bright);
    r = r + (255 - r) * t;
    g = g + (255 - g) * t;
    b = b + (255 - b) * t;
    a = Math.min(1, a * (1 + t * 1.4));
  }

  const x = p.x + p.swayX;
  const y = p.y;

  if (p.type === 0) {
    // 雪点：柔和圆形光点
    const s = p.size * (0.78 + 0.22 * (1 - lt));
    if (s > 2.2) {
      ctx.beginPath();
      ctx.arc(x, y, s * 2.4, 0, TAU);
      ctx.fillStyle = 'rgba(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ',' + (a * 0.13).toFixed(3) + ')';
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(x, y, s, 0, TAU);
    ctx.fillStyle = 'rgba(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ',' + a.toFixed(3) + ')';
    ctx.fill();
  } else if (p.type === 1) {
    // 六角雪花
    drawFlake(ctx, x, y, p.size * (0.85 + 0.15 * (1 - lt)), p.rot, a, r, g, b);
  } else if (p.type === 2) {
    // 霜雾：大半径模糊光团
    const rr = p.size * (0.8 + 0.4 * (1 - lt));
    const grd = ctx.createRadialGradient(x, y, 0, x, y, rr);
    grd.addColorStop(0, 'rgba(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ',' + (a * 0.9).toFixed(3) + ')');
    grd.addColorStop(1, 'rgba(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ',0)');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, TAU);
    ctx.fill();
  } else if (p.type === 3) {
    // 冰针
    const len = p.size * (1 - lt * 0.72);
    const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    if (sp > 1 && len > 0.5) {
      const nx = p.vx / sp, ny = p.vy / sp;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - nx * len, y - ny * len);
      ctx.strokeStyle = 'rgba(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ',' + a.toFixed(3) + ')';
      ctx.lineWidth = p.lineWidth;
      ctx.stroke();
    }
  }
}

function drawRings(ctx, s) {
  const rings = s.rings;
  for (let i = 0; i < rings.length; i++) {
    const r = rings[i];
    if (!r.alive || r.life < 0) continue;
    const t = r.life / r.maxLife;
    const e = 1 - Math.pow(1 - t, 3);
    const rad = lerp(r.r0, r.r1, e);
    const w = r.w0 * (1 - t);
    const a = (1 - t) * (1 - t);
    if (w <= 0.06 || rad <= 0.15) continue;
    ctx.beginPath();
    ctx.ellipse(r.x, r.y, rad * r.sx, rad * r.sy, r.ang, 0, TAU);
    ctx.strokeStyle = 'rgba(' + (r.cr | 0) + ',' + (r.cg | 0) + ',' + (r.cb | 0) + ',' + a.toFixed(3) + ')';
    ctx.lineWidth = w;
    ctx.stroke();
  }
}

function drawCore(ctx, s, x, y, charge, isLeft) {
  const c = clamp(charge, 0, 1);
  const freq = CONFIG.charge.pulseBase + CONFIG.charge.pulseGain * c;
  const pulse = 1 + Math.sin(s.corePhase * freq * TAU) * (0.08 + 0.07 * c);
  const baseR = (isLeft ? 30 : 40) * (0.45 + 1.0 * c) * pulse;
  if (baseR <= 0.5) return;

  const col = isLeft ? chargeColor(c) : rightChargeColor(c);
  const alphaK = 0.28 + 0.62 * c;

  const grd = ctx.createRadialGradient(x, y, 0, x, y, baseR * 3);
  grd.addColorStop(0, 'rgba(' + (col[0] | 0) + ',' + (col[1] | 0) + ',' + (col[2] | 0) + ',' + (0.55 * alphaK).toFixed(3) + ')');
  grd.addColorStop(0.32, 'rgba(' + (col[0] | 0) + ',' + (col[1] | 0) + ',' + (col[2] | 0) + ',' + (0.18 * alphaK).toFixed(3) + ')');
  grd.addColorStop(1, 'rgba(' + (col[0] | 0) + ',' + (col[1] | 0) + ',' + (col[2] | 0) + ',0)');
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(x, y, baseR * 3, 0, TAU);
  ctx.fill();

  // 蓄满时核心边缘的冷紫辉光
  if (c > 0.88) {
    const k = (c - 0.88) / 0.12;
    const pg = ctx.createRadialGradient(x, y, baseR * 0.5, x, y, baseR * 2.4);
    pg.addColorStop(0, 'rgba(201,182,255,0)');
    pg.addColorStop(0.72, 'rgba(201,182,255,' + (0.16 * k).toFixed(3) + ')');
    pg.addColorStop(1, 'rgba(201,182,255,0)');
    ctx.fillStyle = pg;
    ctx.beginPath();
    ctx.arc(x, y, baseR * 2.4, 0, TAU);
    ctx.fill();
  }
}

export class CursorSnow extends CursorEffectElement {
  /**
   * 主题光标：冰蓝描边 + 寒气装饰。
   * 箭头保持标准轮廓，只让配色与围绕的粒子呼应主题。
   */
  cursorTheme() {
    return {
      edge: '#8fe3ff',
      fill: 'rgba(13, 34, 51, .88)',
      glow: '#8fe3ff',
      deco: { color: [180, 232, 255], style: 'cold', rate: 14, speedGain: 0.22 }
    };
  }

  // ==== 初始化 ====
  // 只建池与状态，不注册任何监听（监听归基类）
  setup({ ctx, width, height, input }) {
    // 与原型一致：初始光标位置取视口中心。
    // 基类的 input 从 (0, 0) 起算，若不在这里对齐，首帧的位移会按「从左上角跳过来」计算，
    // 速度与拖尾生成量会和原型不同。
    input.x = input.lx = width * 0.5;
    input.y = input.ly = height * 0.5;

    const pool = new Array(MAXP);
    for (let i = 0; i < MAXP; i++) pool[i] = createEmpty();

    const rings = [];
    for (let i = 0; i < MAX_RINGS; i++) rings.push({ alive: false });

    return {
      // 本实例的画布上下文（已按 DPR 缩放过，统一使用 CSS 像素坐标）
      ctx,

      // 画布尺寸（CSS 像素），由基类 onResize 同步
      W: width,
      H: height,

      input,

      // 粒子池：环形游标复用空闲槽
      pool,
      cursor: 0,

      // 霜环池
      rings,
      ringCursor: 0,

      // 有效光标位置（含蓄力微震偏移），初值与原型一致：视口中心
      E: { x: width * 0.5, y: height * 0.5 },

      // 左右键蓄力状态
      // downAt：真实按下时刻（ms），用于短按/长按判定
      L: { holding: false, t: 0, power: 0, charge: 0, acc: 0, downAt: 0 },
      R: { holding: false, t: 0, power: 0, charge: 0, acc: 0, downAt: 0 },

      // 爆发余波
      afterglow: { t: 0, x: 0, y: 0, acc: 0, power: 0 },

      corePhase: 0,
      trailAcc: 0
    };
  }

  // ==== 粒子池操作 ====
  // 获取一个可用粒子（优先复用空闲槽；全满时环形覆盖最老的一个）
  _obtain(s) {
    const pool = s.pool;
    for (let i = 0; i < 128; i++) {
      const p = pool[s.cursor];
      s.cursor = (s.cursor + 1) % MAXP;
      if (!p.alive) return p;
    }
    const p = pool[s.cursor];
    s.cursor = (s.cursor + 1) % MAXP;
    return p;
  }

  // ==== 霜环池 ====
  _addRing(s, x, y, r0, r1, w0, life, color, delay, sx, sy, ang) {
    const rings = s.rings;
    const r = rings[s.ringCursor];
    s.ringCursor = (s.ringCursor + 1) % MAX_RINGS;
    r.alive = true;
    r.x = x; r.y = y;
    r.r0 = r0; r.r1 = r1;
    r.w0 = w0;
    r.life = -(delay || 0);
    r.maxLife = life;
    r.cr = color[0]; r.cg = color[1]; r.cb = color[2];
    r.sx = sx || 1;
    r.sy = sy || 1;
    r.ang = ang || 0;
  }

  _updateRings(s, dt) {
    const rings = s.rings;
    for (let i = 0; i < rings.length; i++) {
      const r = rings[i];
      if (!r.alive) continue;
      r.life += dt;
      if (r.life >= r.maxLife) r.alive = false;
    }
  }

  // ==== 输入（按键）====
  // 按键速度由基类计算，这里只处理左右键的蓄力状态
  onPointerDown(e) {
    const s = this.state;
    if (!s) return;

    // 记录真实按下时刻：短按/长按的判定不依赖按帧累加的 L.t / R.t。
    // 按帧累加在瞬时点击时可能仍是 0，且受帧率影响，手感不可预测。
    const now = performance.now();

    if (e.button === 0) {
      s.L.holding = true; s.L.t = 0; s.L.power = 0; s.L.charge = 0; s.L.acc = 0;
      s.L.downAt = now;
    } else if (e.button === 2) {
      s.R.holding = true; s.R.t = 0; s.R.power = 0; s.R.charge = 0; s.R.acc = 0;
      s.R.downAt = now;
    }
  }

  onPointerUp(e) {
    const s = this.state;
    if (!s) return;

    // 以真实按住时长判定；取不到时回退到按帧累加值
    const heldMs = (st) => (st.downAt ? performance.now() - st.downAt : st.t * 1000);

    if (e.button === 0 && s.L.holding) {
      s.L.holding = false;
      const ms = heldMs(s.L);
      const power = s.L.power;
      const charge = s.L.charge;
      s.L.t = 0; s.L.power = 0; s.L.charge = 0; s.L.acc = 0; s.L.downAt = 0;
      if (ms < CONFIG.charge.minTime * 1000) {
        // 瞬时点击：用事件坐标作为爆发原点。
        // s.E 是上一帧算出的有效光标，瞬时点击时可能尚未更新到点击位置，会造成爆发点偏移。
        this._smallClickBurst(s, e.clientX, e.clientY);
      } else {
        this._bigLeftBurst(s, power, charge);
      }
    } else if (e.button === 2 && s.R.holding) {
      s.R.holding = false;
      const ms = heldMs(s.R);
      const power = s.R.power;
      const charge = s.R.charge;
      s.R.t = 0; s.R.power = 0; s.R.charge = 0; s.R.acc = 0; s.R.downAt = 0;
      if (ms < CONFIG.charge.minTime * 1000) {
        this._smallRightClick(s, e.clientX, e.clientY);
      } else {
        this._bigRightBurst(s, power, charge);
      }
    }
  }

  // 失焦时按键状态已丢失，温和收尾
  onBlur() {
    if (this.state) this._cancelCharge(this.state);
  }

  // 光标移出窗口：原型在 document 的 mouseleave 里做同样处理
  onPointerLeave() {
    if (this.state) this._cancelCharge(this.state);
  }

  // 标签页切走时按键状态同样已丢失（原型 visibilitychange 行为）
  onVisibilityChange(hidden) {
    if (hidden && this.state) this._cancelCharge(this.state);
  }

  _cancelCharge(s) {
    if (s.L.holding) { s.L.holding = false; s.L.t = 0; s.L.power = 0; s.L.charge = 0; s.L.acc = 0; s.L.downAt = 0; }
    if (s.R.holding) { s.R.holding = false; s.R.t = 0; s.R.power = 0; s.R.charge = 0; s.R.acc = 0; s.R.downAt = 0; }
    // 温和释放所有被吸附的粒子，避免状态残留
    for (let i = 0; i < MAXP; i++) {
      const p = s.pool[i];
      if (!p.alive || p.mode === 0) continue;
      p.mode = 0;
      p.life = 0;
      p.maxLife = rand(0.4, 0.9);
      p.vx = rand(-40, 40);
      p.vy = rand(-40, 20);
      p.drag = 1.2;
      p.gravity = 8;
    }
  }

  // ==== 尺寸 ====
  onResize(width, height) {
    const s = this.state;
    if (!s) return;
    s.W = width;
    s.H = height;
  }

  // ==== 拖尾 ====
  _emitTrail(s, dt) {
    const M = s.input;
    if (!M.inside) { s.trailAcc = 0; return; }
    const T = CONFIG.trail;
    if (M.speed < T.minSpeed) { s.trailAcc *= 0.4; return; }

    const rate = Math.min(T.maxRate, M.speed * T.rateFactor);
    s.trailAcc += rate * dt;
    let n = s.trailAcc | 0;
    s.trailAcc -= n;
    if (n > T.maxPerFrame) n = T.maxPerFrame;
    if (n <= 0) return;

    const dirX = M.speed > 1 ? M.vx / M.speed : 0;
    const dirY = M.speed > 1 ? M.vy / M.speed : 0;
    const nX = -dirY, nY = dirX;
    const w = T.width * clamp(M.speed / 900, 0.35, 1.6);
    const sp = M.speed * T.speedFactor;

    for (let i = 0; i < n; i++) {
      const p = this._obtain(s);
      const t = Math.random();
      const bx = M.frameLx + (M.x - M.frameLx) * t;
      const by = M.frameLy + (M.y - M.frameLy) * t;
      const off = (Math.random() - 0.5) * 2 * w;
      const along = (Math.random() - 0.5) * 12;
      resetParticle(p, bx + nX * off + dirX * along, by + nY * off + dirY * along);

      const r = Math.random();
      if (r < 0.62) {
        // 雪点
        p.type = 0;
        p.size = rand(1, 3);
        p.maxLife = rand(T.lifeMin, T.lifeMax);
        p.baseAlpha = rand(0.55, 0.95);
        p.drag = 1.6;
        p.gravity = rand(8, 20);
        p.swayAmp = rand(4, 12);
        p.swayFreq = rand(0.5, 1.4);
        setColor(p, pickTrailColor());
      } else if (r < 0.93) {
        // 小雪花
        p.type = 1;
        p.size = rand(4, 9);
        p.maxLife = rand(0.8, 1.6);
        p.baseAlpha = rand(0.45, 0.85);
        p.drag = 1.4;
        p.gravity = rand(6, 16);
        p.swayAmp = rand(6, 18);
        p.swayFreq = rand(0.5, 1.2);
        p.rotV = rand(-1.8, 1.8);
        setColor(p, pickFlakeColor());
      } else {
        // 霜雾
        p.type = 2;
        p.size = rand(18, 40);
        p.maxLife = rand(0.9, 1.8);
        p.baseAlpha = rand(0.05, 0.10);
        p.drag = 2.0;
        p.gravity = rand(2, 6);
        p.swayAmp = rand(10, 24);
        p.swayFreq = rand(0.3, 0.8);
        setColor(p, COL.iceBlue);
      }

      p.vx = dirX * sp + rand(-1, 1) * T.scatter;
      p.vy = dirY * sp + rand(-1, 1) * T.scatter;
    }
  }

  // ==== 单击爆发（交互二 + 交互三）====
  _shockwave(s, x, y) {
    const S = CONFIG.shock;
    const R2 = S.radius * S.radius;
    for (let i = 0; i < MAXP; i++) {
      const p = s.pool[i];
      if (!p.alive || p.mode !== 0) continue;
      const dx = p.x - x, dy = p.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > R2) continue;
      const d = Math.sqrt(d2) || 0.001;
      const fall = 1 - d / S.radius;
      const imp = S.force * fall * fall;
      p.vx += (dx / d) * imp;
      p.vy += (dy / d) * imp;
      p.bright = Math.min(1.2, p.bright + 0.35 + fall);
    }
  }

  _smallClickBurst(s, x, y) {
    const B = CONFIG.burst;

    // 1) 小簇放射雪花
    const n = randInt(B.countMin, B.countMax);
    for (let i = 0; i < n; i++) {
      const p = this._obtain(s);
      resetParticle(p, x, y);
      p.type = Math.random() < 0.75 ? 0 : 1;
      const a = rand(0, TAU);
      const sp = B.speed * rand(0.35, 1.1);
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp;
      p.maxLife = rand(B.lifeMin, B.lifeMax);
      if (p.type === 0) {
        p.size = rand(1.2, 2.8);
        p.drag = 1.7;
        p.gravity = 10;
      } else {
        p.size = rand(4, 8);
        p.drag = 1.5;
        p.gravity = 8;
        p.rotV = rand(-5, 5);
      }
      p.baseAlpha = rand(0.7, 1);
      p.swayAmp = rand(2, 8);
      p.swayFreq = rand(0.7, 1.6);
      setColor(p, Math.random() < 0.65 ? COL.white : COL.iceBlue);
    }

    // 2) 3~5 个较大的六角雪花
    const bn = randInt(B.bigMin, B.bigMax);
    for (let i = 0; i < bn; i++) {
      const p = this._obtain(s);
      resetParticle(p, x, y);
      p.type = 1;
      const a = rand(0, TAU);
      const sp = rand(60, 155);
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp;
      p.size = rand(10, 16);
      p.maxLife = rand(0.55, 0.85);
      p.baseAlpha = 0.95;
      p.drag = 1.3;
      p.gravity = 6;
      p.rotV = rand(-6, 6);
      p.bright = 0.7;
      setColor(p, COL.white);
    }

    // 3) 短寿命霜环
    this._addRing(s, x, y, B.ringStart, B.ringEnd, B.ringWidth, B.ringLife, COL.iceBlue, 0, 1, 1, 0);

    // 4) 推动场上已有拖尾粒子
    this._shockwave(s, x, y);

    // 5) 释放可能存在的被吸附粒子（快速点击时）
    this._freeCaptured(s, 140, 50);
  }

  _smallRightClick(s, x, y) {
    for (let i = 0; i < 14; i++) {
      const p = this._obtain(s);
      resetParticle(p, x, y);
      p.type = Math.random() < 0.8 ? 0 : 1;
      const a = rand(0, TAU);
      const sp = rand(40, 165);
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp;
      if (p.type === 0) {
        p.size = rand(1, 2.4);
        p.drag = 1.8;
      } else {
        p.size = rand(4, 7);
        p.drag = 1.6;
        p.rotV = rand(-5, 5);
      }
      p.maxLife = rand(0.3, 0.6);
      p.baseAlpha = rand(0.6, 0.95);
      p.gravity = 10;
      p.swayAmp = rand(2, 7);
      p.swayFreq = rand(0.8, 1.6);
      setColor(p, Math.random() < 0.5 ? COL.skyBlue : COL.deepIce);
    }
    this._addRing(s, x, y, 4, 46, 2.2, 0.36, COL.deepIce, 0, 1, 1, 0);
    this._freeCaptured(s, 90, 30);
  }

  // ==== 释放被吸附粒子 ====
  // 径向喷射（左键用）
  _freeCaptured(s, speed, jitter) {
    const E = s.E;
    for (let i = 0; i < MAXP; i++) {
      const p = s.pool[i];
      if (!p.alive || p.mode === 0) continue;
      const dx = p.x - E.x, dy = p.y - E.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.001;
      const sp = speed * rand(0.55, 1.35);
      p.vx = (dx / d) * sp + rand(-1, 1) * jitter;
      p.vy = (dy / d) * sp + rand(-1, 1) * jitter;
      p.mode = 0;
      p.life = 0;
      p.maxLife = rand(0.4, 0.9);
      p.bright = 1;
      p.drag = 1.2;
      p.gravity = 8;
      p.rad = 0;
    }
  }

  // 定向喷射（右键用）
  _freeCapturedDirectional(s, dx, dy, speed, half) {
    const baseAng = Math.atan2(dy, dx);
    for (let i = 0; i < MAXP; i++) {
      const p = s.pool[i];
      if (!p.alive || p.mode === 0) continue;
      const a = baseAng + rand(-half, half);
      const sp = speed * rand(0.6, 1.2);
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp;
      p.mode = 0;
      p.life = 0;
      p.maxLife = rand(0.4, 0.9);
      p.bright = 1;
      p.drag = 1.0;
      p.gravity = 8;
      p.type = Math.random() < 0.7 ? 0 : 1;
      if (p.type === 1 && p.size < 5) p.size = rand(5, 8);
      p.rad = 0;
    }
  }

  // ==== 左键蓄力 ====
  _spawnCaptured(s, cx, cy, mode, charge) {
    const isLeft = mode === 1;
    const cfg = isLeft ? CONFIG.leftHold : CONFIG.rightHold;
    const p = this._obtain(s);
    resetParticle(p, cx, cy);
    p.mode = mode;
    p.maxLife = 1e9;
    p.life = 0;
    p.drag = 0;
    p.gravity = 0;
    p.swayAmp = 0;

    p.type = Math.random() < 0.62 ? 0 : 1;
    if (p.type === 0) {
      p.size = rand(1.2, 2.8);
      p.baseAlpha = rand(0.6, 1);
    } else {
      p.size = rand(4, 9);
      p.baseAlpha = rand(0.5, 0.95);
      p.rotV = rand(-3, 3);
    }

    const c = clamp(charge, 0, 1);

    if (isLeft) {
      p.ang = rand(0, TAU);
      p.rad = rand(lerp(cfg.radMinMin, cfg.radMinMax, c), lerp(cfg.radMaxMin, cfg.radMaxMax, c));
      p.radBase = rand(cfg.coreMin, cfg.coreMax);
      p.spinMul = rand(0.7, 1.3);
      const cc = chargeColor(c);
      setColor(p, Math.random() < 0.4 ? COL.white : cc);
    } else {
      // 双旋涡：从上下两个方向被吸入
      const up = Math.random() < 0.5;
      p.ang = (up ? -Math.PI / 2 : Math.PI / 2) + rand(-0.4, 0.4);
      p.rad = rand(lerp(cfg.radMinMin, cfg.radMinMax, c), lerp(cfg.radMaxMin, cfg.radMaxMax, c));
      p.radBase = rand(cfg.coreMin, cfg.coreMax);
      p.spinMul = rand(0.7, 1.3);
      const r = Math.random();
      setColor(p, r < 0.35 ? COL.deepIce : (r < 0.75 ? COL.skyBlue : COL.coldPurple));
    }

    p.x = cx + Math.cos(p.ang) * p.rad;
    p.y = cy + Math.sin(p.ang) * p.rad;
  }

  _updateCaptured(s, p, dt) {
    const isLeft = p.mode === 1;
    const charge = isLeft ? s.L.charge : s.R.charge;
    const cfg = isLeft ? CONFIG.leftHold : CONFIG.rightHold;
    const c = clamp(charge, 0, 1);

    const spin = (cfg.spinMin + cfg.spinGain * c) * p.spinMul;
    const dir = isLeft ? 1 : -1;

    p.ang += dir * spin * dt;

    const shrink = 1.6 + 3.2 * c;
    p.rad += (p.radBase - p.rad) * shrink * dt;
    if (p.rad < 1) p.rad = 1;

    p.x = s.E.x + Math.cos(p.ang) * p.rad;
    p.y = s.E.y + Math.sin(p.ang) * p.rad * (isLeft ? 0.92 : 1.0);

    p.vx = -Math.sin(p.ang) * dir * spin * p.rad;
    p.vy = Math.cos(p.ang) * dir * spin * p.rad;
  }

  // 蓄力场对自由粒子的影响
  _applyField(s, p, dt, isLeft) {
    const dx = s.E.x - p.x, dy = s.E.y - p.y;
    const d2 = dx * dx + dy * dy;
    const R = 260;
    if (d2 > R * R) return;
    const d = Math.sqrt(d2) || 0.001;
    const f = 1 - d / R;
    const ff = f * f;
    if (isLeft) {
      p.vx += (dx / d) * 280 * ff * dt;
      p.vy += (dy / d) * 280 * ff * dt;
    } else {
      p.vx += (-dy / d) * 340 * ff * dt;
      p.vy += (dx / d) * 340 * ff * dt;
    }
  }

  _bigLeftBurst(s, power, charge) {
    const x = s.E.x, y = s.E.y;
    const cfg = CONFIG.leftHold;
    const coreCol = chargeColor(clamp(charge, 0, 1));

    // 1) 雪崩
    const n = Math.round(cfg.releaseBase + cfg.releaseExtra * power);
    for (let i = 0; i < n; i++) {
      const p = this._obtain(s);
      resetParticle(p, x, y);
      p.type = Math.random() < 0.78 ? 0 : 1;
      const a = rand(0, TAU);
      const sp = (cfg.speedMin + cfg.speedGain * power) * rand(0.35, 1.15);
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp;
      p.maxLife = lerp(0.35, 1.1, clamp(sp / 1100, 0, 1)) * rand(0.8, 1.25);
      if (p.type === 0) {
        p.size = rand(1.4, 3.2);
        p.drag = 1.6;
        p.gravity = rand(8, 22);
      } else {
        p.size = rand(5, 12);
        p.drag = 1.4;
        p.gravity = rand(6, 16);
        p.rotV = rand(-4, 4);
      }
      p.baseAlpha = rand(0.65, 1);
      p.swayAmp = rand(2, 10);
      p.swayFreq = rand(0.6, 1.6);
      setColor(p, Math.random() < 0.5 ? coreCol : COL.white);
    }

    // 2) 2~3 层同心霜环
    const ringCount = 2 + (power > 0.5 ? 1 : 0);
    const maxR = 80 + 420 * power;
    for (let i = 0; i < ringCount; i++) {
      const col = i === 0 ? COL.white : (i === 1 ? COL.iceBlue : COL.deepIce);
      this._addRing(s, x, y, 8 + i * 6, maxR * (1 - i * 0.18),
        3 + 7 * power, 0.42 + 0.22 * power, col, i * 0.055, 1, 1, 0);
    }

    // 3) 吹散场上所有拖尾粒子
    const blow = 400 + 1300 * power;
    for (let i = 0; i < MAXP; i++) {
      const p = s.pool[i];
      if (!p.alive || p.mode !== 0) continue;
      const dx = p.x - x, dy = p.y - y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.001;
      const fall = Math.max(0, 1 - d / 420);
      const imp = blow * fall * fall;
      p.vx += (dx / d) * imp;
      p.vy += (dy / d) * imp;
      p.bright = 1;
    }

    // 4) 核心释放：被吸住的粒子集体反向喷射
    this._freeCaptured(s, 500 + 1100 * power, 60);

    // 5) 余波
    this._startAfterglow(s, x, y, power);
  }

  // ==== 右键蓄力 ====
  _bigRightBurst(s, power, charge) {
    const x = s.E.x, y = s.E.y;
    const cfg = CONFIG.rightHold;
    const M = s.input;

    // 喷发方向：最后一段鼠标移动方向
    let dx = M.vx, dy = M.vy;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 40) {
      const a = rand(0, TAU);
      dx = Math.cos(a); dy = Math.sin(a);
    } else {
      dx /= len; dy /= len;
    }
    const baseAng = Math.atan2(dy, dx);
    const half = cfg.coneAngle * 0.5;

    // 1) 定向锥形雪流
    const n = Math.round(cfg.releaseBase + cfg.releaseExtra * power);
    const spd = cfg.speedMin + cfg.speedGain * power;
    for (let i = 0; i < n; i++) {
      const p = this._obtain(s);
      resetParticle(p, x, y);
      const a = baseAng + rand(-half, half);
      const sp = spd * rand(0.45, 1.15);
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp;
      p.type = Math.random() < 0.8 ? 0 : 1;
      if (p.type === 0) {
        p.size = rand(1.2, 3);
        p.drag = 1.1;
        p.gravity = 8;
      } else {
        p.size = rand(5, 10);
        p.drag = 1.0;
        p.gravity = 6;
        p.rotV = rand(-6, 6);
      }
      p.maxLife = lerp(0.4, 1.2, clamp(sp / 1600, 0, 1)) * rand(0.8, 1.2);
      p.baseAlpha = rand(0.7, 1);
      p.swayAmp = rand(2, 8);
      p.swayFreq = rand(0.7, 1.5);
      const r = Math.random();
      setColor(p, r < 0.4 ? COL.deepIce : (r < 0.75 ? COL.skyBlue : COL.coldPurple));
    }

    // 2) 撕裂环（拉长椭圆，沿喷发方向）
    const maxR = 80 + 420 * power;
    for (let i = 0; i < 3; i++) {
      const col = i === 0 ? COL.white : (i === 1 ? COL.skyBlue : COL.coldPurple);
      this._addRing(s, x, y, 10, maxR * (0.8 + i * 0.35),
        3 + 6 * power, 0.38 + 0.2 * power, col, i * 0.05,
        1.6 + i * 0.4, 0.45, baseAng);
    }

    // 3) 冰针雨
    const nn = Math.round(cfg.needleBase + cfg.needleExtra * power);
    const nspd = cfg.needleSpeedMin + cfg.needleSpeedGain * power;
    for (let i = 0; i < nn; i++) {
      const p = this._obtain(s);
      resetParticle(p, x, y);
      p.type = 3;
      const a = baseAng + rand(-half * 0.85, half * 0.85);
      const sp = nspd * rand(0.7, 1.3);
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp;
      p.size = rand(10, 30);
      p.lineWidth = rand(0.8, 1.8);
      p.maxLife = rand(0.28, 0.55);
      p.baseAlpha = rand(0.75, 1);
      p.drag = 0.25;
      p.gravity = 3;
      p.rotV = 0;
      setColor(p, Math.random() < 0.55 ? COL.white : COL.coldPurple);
    }

    // 4) 风向感：场上拖尾粒子被沿喷发方向吹走
    const blow = 500 + 1400 * power;
    for (let i = 0; i < MAXP; i++) {
      const p = s.pool[i];
      if (!p.alive || p.mode !== 0) continue;
      const ddx = p.x - x, ddy = p.y - y;
      const d = Math.sqrt(ddx * ddx + ddy * ddy) || 0.001;
      const fall = Math.max(0, 1 - d / 520);
      const imp = blow * fall;
      p.vx += dx * imp + rand(-1, 1) * 60;
      p.vy += dy * imp + rand(-1, 1) * 60;
      p.bright = 1;
    }

    // 5) 被吸附粒子沿锥形方向喷射
    this._freeCapturedDirectional(s, dx, dy, 400 + 1000 * power, half);

    this._startAfterglow(s, x, y, power);
  }

  // ==== 余波 ====
  _startAfterglow(s, x, y, power) {
    const ag = s.afterglow;
    ag.t = CONFIG.afterglow.time;
    ag.x = x;
    ag.y = y;
    ag.power = power;
    ag.acc = 0;
  }

  _updateAfterglow(s, dt) {
    const ag = s.afterglow;
    if (ag.t <= 0) return;
    ag.t -= dt;
    ag.acc += CONFIG.afterglow.rate * (0.5 + ag.power) * dt;
    let n = ag.acc | 0;
    ag.acc -= n;
    if (n > 8) n = 8;
    for (let i = 0; i < n; i++) {
      const p = this._obtain(s);
      resetParticle(p, ag.x + rand(-26, 26), ag.y + rand(-26, 26));
      p.type = Math.random() < 0.85 ? 0 : 1;
      p.size = p.type === 0 ? rand(1, 2.4) : rand(3, 7);
      p.maxLife = rand(0.5, 1.1);
      p.baseAlpha = rand(0.5, 0.9);
      p.vx = rand(-45, 45);
      p.vy = rand(-55, -5);
      p.drag = 1.2;
      p.gravity = rand(6, 14);
      p.swayAmp = rand(3, 12);
      p.swayFreq = rand(0.5, 1.3);
      if (p.type === 1) p.rotV = rand(-3, 3);
      setColor(p, Math.random() < 0.6 ? COL.white : COL.iceBlue);
    }
  }

  // ==== 更新 ====
  _computeEffectiveCursor(s) {
    const M = s.input;
    let sx = 0, sy = 0;
    const C = CONFIG.charge;

    if (s.L.holding) {
      const c = clamp(s.L.t / C.fullTime, 0, 1);
      if (c > C.shakeStart) {
        const k = (c - C.shakeStart) / (1 - C.shakeStart);
        sx += (Math.random() * 2 - 1) * C.shakeAmp * k;
        sy += (Math.random() * 2 - 1) * C.shakeAmp * k;
      }
    }
    if (s.R.holding) {
      const c = clamp(s.R.t / C.fullTime, 0, 1);
      if (c > C.shakeStart) {
        const k = (c - C.shakeStart) / (1 - C.shakeStart);
        sx += (Math.random() * 2 - 1) * C.shakeAmp * k;
        sy += (Math.random() * 2 - 1) * C.shakeAmp * k;
      }
    }

    s.E.x = M.x + sx;
    s.E.y = M.y + sy;
  }

  _updateCharge(s, dt) {
    const C = CONFIG.charge;

    if (s.L.holding) {
      s.L.t += dt;
      const c = clamp(s.L.t / C.fullTime, 0, 1);
      s.L.power = Math.pow(c, C.powerExp);
      s.L.charge = c + Math.min(0.18, Math.max(0, s.L.t - C.fullTime) * 0.03);

      const rate = CONFIG.leftHold.spawnRate * (0.45 + 0.95 * c);
      s.L.acc += rate * dt;
      let n = s.L.acc | 0;
      s.L.acc -= n;
      if (n > 30) n = 30;
      for (let i = 0; i < n; i++) this._spawnCaptured(s, s.E.x, s.E.y, 1, s.L.charge);
    }

    if (s.R.holding) {
      s.R.t += dt;
      const c = clamp(s.R.t / C.fullTime, 0, 1);
      s.R.power = Math.pow(c, C.powerExp);
      s.R.charge = c + Math.min(0.18, Math.max(0, s.R.t - C.fullTime) * 0.03);

      const rate = CONFIG.rightHold.spawnRate * (0.45 + 0.95 * c);
      s.R.acc += rate * dt;
      let n = s.R.acc | 0;
      s.R.acc -= n;
      if (n > 30) n = 30;
      for (let i = 0; i < n; i++) this._spawnCaptured(s, s.E.x, s.E.y, 2, s.R.charge);
    }
  }

  _updateParticles(s, dt) {
    const lHold = s.L.holding;
    const rHold = s.R.holding;
    const fieldOn = lHold || rHold;

    for (let i = 0; i < MAXP; i++) {
      const p = s.pool[i];
      if (!p.alive) continue;

      p.life += dt;

      if (p.mode !== 0) {
        this._updateCaptured(s, p, dt);
      } else {
        // 空气阻力 + 重力
        const k = Math.exp(-p.drag * dt);
        p.vx *= k;
        p.vy *= k;
        p.vy += p.gravity * dt;

        // 蓄力场影响
        if (fieldOn) this._applyField(s, p, dt, lHold);

        // 速度保护
        const sp2 = p.vx * p.vx + p.vy * p.vy;
        if (sp2 > 2600 * 2600) {
          const sc = 2600 / Math.sqrt(sp2);
          p.vx *= sc; p.vy *= sc;
        }

        p.x += p.vx * dt;
        p.y += p.vy * dt;

        // 正弦左右摆动
        if (p.swayAmp > 0) {
          p.swayX = Math.sin(p.life * p.swayFreq * TAU + p.swayPhase) * p.swayAmp;
        }
      }

      p.rot += p.rotV * dt;

      // 生命周期
      if (p.mode === 0 && p.life >= p.maxLife) {
        p.alive = false;
        continue;
      }

      // 高亮回落
      if (p.bright > 0) {
        p.bright -= dt / CONFIG.shock.brightTime;
        if (p.bright < 0) p.bright = 0;
      }

      // 出界回收
      if (p.x < -320 || p.x > s.W + 320 || p.y < -320 || p.y > s.H + 320) {
        p.alive = false;
      }
    }
  }

  update(dt, s) {
    if (!s) return;

    s.corePhase += dt;

    // —— 鼠标位移 / 速度：由基类每帧写入 this.input，这里不再重复计算 ——

    // —— 有效光标位置（含微震）——
    this._computeEffectiveCursor(s);

    // —— 蓄力计时 & 吸附生成 ——
    this._updateCharge(s, dt);

    // —— 拖尾生成 ——
    this._emitTrail(s, dt);

    // —— 粒子更新 ——
    this._updateParticles(s, dt);

    // —— 霜环 ——
    this._updateRings(s, dt);

    // —— 余波 ——
    this._updateAfterglow(s, dt);
  }

  // ==== 渲染 ====
  render(s) {
    if (!s) return;
    const ctx = s.ctx;

    // 画布缓冲与 DPR 缩放由基类维护，这里统一使用 CSS 像素坐标
    ctx.clearRect(0, 0, s.W, s.H);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 霜环
    drawRings(ctx, s);

    // 粒子
    for (let i = 0; i < MAXP; i++) {
      const p = s.pool[i];
      if (p.alive) drawParticle(ctx, p);
    }

    // 蓄力核心
    if (s.L.holding) drawCore(ctx, s, s.E.x, s.E.y, s.L.charge, true);
    if (s.R.holding) drawCore(ctx, s, s.E.x, s.E.y, s.R.charge, false);

    ctx.globalCompositeOperation = 'source-over';
  }
}

if (!customElements.get('cursor-snow')) {
  customElements.define('cursor-snow', CursorSnow);
}

export default CursorSnow;
