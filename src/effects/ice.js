/**
 * cursor-ice —— 鼠标光标冰晶动效。
 *
 * 由 html/冰晶.html 原型移植：算法流程、数值、视觉表现与原文件一一对应。
 * 作为光标层组件，原型页面自身的行为已剔除：
 *   - 不携带深色页面底色（基类保证 canvas 透明，绘制中也没有整屏填底）；
 *   - 不拦截 contextmenu，宿主页面的右键菜单不受影响；
 *   - 画布创建、DPR 适配、监听注册、rAF 循环均由基类负责。
 *
 * 输入事件族沿用原型的 pointer（pointerdown / pointerup / pointermove），
 * 与基类默认值一致，因此不声明 inputFamily。
 *
 * 所有运行状态都放在 setup() 返回的 state 上，多实例互不干扰。
 */

import { CursorEffectElement } from '../core/base.js';
import { TAU, clamp, lerp, rand, randInt, mixColor } from '../core/utils.js';

// ==================== 配置（所有可调参数集中于此） ====================
const CONFIG = {
  /* 对象池预分配上限 */
  maxParticles: 2500,
  /* 设备像素比上限，避免超高分辨率屏性能崩溃 */
  dprMax: 2,

  /* 主色板 */
  colors: {
    cyan:    [79, 227, 255],   // 主青
    blue:    [43, 123, 255],   // 电蓝
    white:   [255, 255, 255],  // 锐白
    purple:  [155, 92, 255],   // 晶体紫
    magenta: [255, 79, 216]    // 洋红（仅高速闪光瞬间）
  },

  /* 鼠标拖尾 */
  trail: {
    density: 0.42,             // 每移动 1px 生成的粒子数
    maxSpeed: 2800,            // 鼠标速度采样上限（px/s）
    lifeMin: 0.35,             // 粒子寿命下限（s）
    lifeMax: 0.90,             // 粒子寿命上限（s）
    drag: 0.85,                // 阻力系数（指数衰减，越小越“滑”）
    velK: [0.30, 0.60],        // 初速度继承鼠标速度的比例范围
    scatter: 55,               // 随机散射速度（px/s）
    streakK: 0.035,            // 残影长度 = 速度 × 该系数
    streakLen: [6, 46],        // 残影长度范围（px）
    needleLen: [8, 40]         // 冰针长度范围（px）
  },

  /* 单击碎裂 */
  click: {
    shardMin: 22,
    shardMax: 32,
    speedMin: 300,
    speedMax: 700,
    ringR1: 90,                // 六边形线框最大半径
    ringLife: 0.42,
    starLen: 40,               // 十字星芒长度
    starLife: 0.18,
    shockRadius: 180,          // 冲击波半径
    shockPower: 420            // 冲击波强度
  },

  /* 蓄力通用 */
  charge: {
    maxTime: 2.5,              // 完整蓄力时长（s）
    minClickTime: 0.12,        // 低于该时长视为普通单击
    exponent: 1.6,             // power 非线性曲线指数
    spawnRadius: [50, 200],    // 生成半径随蓄力从 50 扩到 200
    shakeStart: 0.60,          // 微震起始进度
    diffStart: 0.50            // 棱边衍射起始进度
  },

  /* 左键爆发 */
  leftBurst: {
    shardBase: 70,
    shardGain: 260,
    speedBase: 300,
    speedGain: 1100,
    ringBase: 90,
    ringGain: 460,
    shockBase: 200,
    shockGain: 300,
    shockPowerBase: 250,
    shockPowerGain: 900
  },

  /* 右键爆发 */
  rightBurst: {
    beamMin: 3,
    beamMax: 5,
    speedBase: 400,
    speedGain: 1300,
    spread: 0.16               // 束与束之间的角差（弧度）
  },

  /* 爆发余波 */
  afterglow: {
    time: 0.5,                 // 余波持续时长（s）
    rate: 90                   // 余波粒子生成速率（个/s）
  }
};

const C = CONFIG.colors;
const MAXP = CONFIG.maxParticles;

// 粒子类型
const PT = {
  SHARD: 0,   // 菱形碎片
  TRI: 1,     // 三角碎屑
  NEEDLE: 2,  // 冰针
  STAR: 3,    // 折射星芒
  STREAK: 4,  // 棱边残影
  RING: 5     // 六边形线框环
};

// ==================== 工具函数 ====================
function shortestAngle(d) {
  return ((d + Math.PI) % TAU + TAU) % TAU - Math.PI;
}

// 蓄力核心色迁移（原型的 mixC，等价于 utils 的 mixColor）
function coreColor(pr, isLeft) {
  if (isLeft) {
    if (pr < 0.34) return mixColor(C.white, C.cyan, pr / 0.34);
    if (pr < 0.67) return mixColor(C.cyan, C.blue, (pr - 0.34) / 0.33);
    return mixColor(C.blue, C.purple, (pr - 0.67) / 0.33);
  }
  if (pr < 0.5) return mixColor(C.purple, C.blue, pr * 2);
  return mixColor(C.blue, C.purple, (pr - 0.5) * 2);
}

// ==================== 粒子池（纯函数：只操作传入的粒子对象） ====================
function newParticle() {
  return {
    active: false,
    type: 0,
    idx: 0,
    seq: 0,
    x: 0, y: 0,
    vx: 0, vy: 0,
    life: 0, maxLife: 1,
    rot: 0, rotSpd: 0,
    a: 4, b: 2,             // 主尺寸 / 次尺寸
    r0: 0, r1: 0,           // 环形起止半径
    grow: 0,
    cr: 255, cg: 255, cb: 255,
    alpha: 1,
    drag: 0.6,
    flash: 0,               // 白光冲击提升量 0~1
    arms: 2,                // 星芒臂数
    lw: 1,
    stretch: 1,             // 椭圆拉伸比
    orbital: false,         // 是否处于蓄力轨道
    oAng: 0, oRad: 0, oSpd: 0, oDir: 1,
    oTarget: 0, oPull: 3, oPhase: 0, oResp: 0, oFreq: 0,
    twk: 0
  };
}

function resetP(p) {
  p.active = true;
  p.type = 0;
  p.vx = 0; p.vy = 0;
  p.rot = 0; p.rotSpd = 0;
  p.a = 4; p.b = 2;
  p.r0 = 0; p.r1 = 0; p.grow = 0;
  p.cr = 255; p.cg = 255; p.cb = 255;
  p.alpha = 1;
  p.drag = 0.6;
  p.flash = 0;
  p.arms = 2;
  p.lw = 1;
  p.stretch = 1;
  p.orbital = false;
  p.oAng = 0; p.oRad = 0; p.oSpd = 0; p.oDir = 1;
  p.oTarget = 0; p.oPull = 3; p.oPhase = 0; p.oResp = 0; p.oFreq = 0;
  p.twk = 0;
}

// ==================== 绘制（只读 state，不修改） ====================
function drawParticle(ctx, p, time) {
  const lt = p.life / p.maxLife;
  let alpha = p.alpha * Math.min(1, lt * 3.2);
  if (alpha <= 0.006) return;

  // 轨道粒子的棱镜闪烁
  if (p.twk > 0) {
    alpha *= 0.55 + 0.45 * Math.sin(time * p.twk + p.oPhase);
    if (alpha <= 0.006) return;
  }

  const fl = p.flash;
  const rs = (p.cr + (255 - p.cr) * fl) | 0;
  const gs = (p.cg + (255 - p.cg) * fl) | 0;
  const bs = (p.cb + (255 - p.cb) * fl) | 0;

  switch (p.type) {
    // ---- 菱形碎片 ----
    case PT.SHARD: {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      const L = p.a, Wd = p.b;
      ctx.beginPath();
      ctx.moveTo(0, -L);
      ctx.lineTo(Wd, 0);
      ctx.lineTo(0, L);
      ctx.lineTo(-Wd, 0);
      ctx.closePath();
      ctx.fillStyle = 'rgba(' + rs + ',' + gs + ',' + bs + ',' + (alpha * 0.30).toFixed(3) + ')';
      ctx.fill();
      ctx.strokeStyle = 'rgba(' + rs + ',' + gs + ',' + bs + ',' + (alpha * 0.95).toFixed(3) + ')';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
      break;
    }

    // ---- 三角碎屑 ----
    case PT.TRI: {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      const L = p.a, Wd = p.b;
      ctx.beginPath();
      ctx.moveTo(0, -L);
      ctx.lineTo(Wd * 0.9, L * 0.55);
      ctx.lineTo(-Wd * 0.9, L * 0.55);
      ctx.closePath();
      ctx.fillStyle = 'rgba(' + rs + ',' + gs + ',' + bs + ',' + (alpha * 0.32).toFixed(3) + ')';
      ctx.fill();
      ctx.strokeStyle = 'rgba(' + rs + ',' + gs + ',' + bs + ',' + (alpha * 0.9).toFixed(3) + ')';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
      break;
    }

    // ---- 冰针 ----
    case PT.NEEDLE: {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      const L = p.a, w = p.b;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-L * 0.5, 0);
      ctx.lineTo(L * 0.5, 0);
      ctx.strokeStyle = 'rgba(' + rs + ',' + gs + ',' + bs + ',' + (alpha * 0.20).toFixed(3) + ')';
      ctx.lineWidth = w * 1.9;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(L * 0.5, 0);
      ctx.strokeStyle = 'rgba(' + rs + ',' + gs + ',' + bs + ',' + (alpha * 0.95).toFixed(3) + ')';
      ctx.lineWidth = w;
      ctx.stroke();
      ctx.restore();
      break;
    }

    // ---- 棱边残影 ----
    case PT.STREAK: {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      const L = p.a, w = p.b;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(-L * 0.5, 0);
      ctx.lineTo(L * 0.5, 0);
      ctx.strokeStyle = 'rgba(' + rs + ',' + gs + ',' + bs + ',' + (alpha * 0.16).toFixed(3) + ')';
      ctx.lineWidth = w * 2.0;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(L * 0.5, 0);
      ctx.strokeStyle = 'rgba(' + rs + ',' + gs + ',' + bs + ',' + (alpha * 0.9).toFixed(3) + ')';
      ctx.lineWidth = w;
      ctx.stroke();
      ctx.restore();
      break;
    }

    // ---- 折射星芒 ----
    case PT.STAR: {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      const L = p.a;
      const arms = p.arms;
      ctx.beginPath();
      for (let k = 0; k < arms; k++) {
        const ang = (k * Math.PI) / arms;
        const cx0 = Math.cos(ang) * L;
        const cy0 = Math.sin(ang) * L;
        ctx.moveTo(-cx0, -cy0);
        ctx.lineTo(cx0, cy0);
      }
      ctx.strokeStyle = 'rgba(' + rs + ',' + gs + ',' + bs + ',' + (alpha * 0.9).toFixed(3) + ')';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 2.2, 0, TAU);
      ctx.fillStyle = 'rgba(255,255,255,' + (alpha * 0.95).toFixed(3) + ')';
      ctx.fill();
      ctx.restore();
      break;
    }

    // ---- 六边形线框环 ----
    case PT.RING: {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      if (p.stretch !== 1) ctx.scale(p.stretch, 1);
      const R = p.a;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const ang = (i * Math.PI) / 3;
        const px = Math.cos(ang) * R;
        const py = Math.sin(ang) * R;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.strokeStyle = 'rgba(' + rs + ',' + gs + ',' + bs + ',' + (alpha * 0.9).toFixed(3) + ')';
      ctx.lineWidth = p.b;
      ctx.stroke();

      // 六个顶点向外辐射细线
      const rayLen = R * 0.35 + 8;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const ang = (i * Math.PI) / 3;
        const c0 = Math.cos(ang) * R;
        const s0 = Math.sin(ang) * R;
        ctx.moveTo(c0, s0);
        ctx.lineTo(Math.cos(ang) * (R + rayLen), Math.sin(ang) * (R + rayLen));
      }
      ctx.strokeStyle = 'rgba(' + rs + ',' + gs + ',' + bs + ',' + (alpha * 0.55).toFixed(3) + ')';
      ctx.lineWidth = p.b * 0.55;
      ctx.stroke();
      ctx.restore();
      break;
    }
  }
}

export class CursorIce extends CursorEffectElement {
  // ==================== 初始化 ====================
  // 只建池与状态，不注册任何监听（监听归基类）
  setup({ ctx, width, height, input }) {
    // 与原型一致：初始光标位置取视口中心。
    // 基类的 input 从 (0, 0) 起算，若不在这里对齐，首帧位移会按「从左上角跳过来」计算。
    input.x = input.lx = width * 0.5;
    input.y = input.ly = height * 0.5;

    const pool = new Array(MAXP);
    const freeList = [];

    for (let i = 0; i < MAXP; i++) {
      const p = newParticle();
      p.idx = i;
      pool[i] = p;
      freeList.push(i);
    }

    return {
      // 本实例的画布上下文（已按 DPR 缩放过，统一使用 CSS 像素坐标）
      ctx,

      // 画布尺寸（CSS 像素），由基类 onResize 同步
      W: width,
      H: height,

      input,

      // 粒子池：空闲槽位栈 + 递增序号（池满时回收序号最小者）
      pool,
      freeList,
      seqCounter: 0,

      // 蓄力状态（左右键共用，靠 button 区分）
      charge: {
        active: false,
        button: -1,
        t: 0,
        power: 0,
        x: width * 0.5, y: height * 0.5,
        spawnAcc: 0,
        diffAcc: 0,
        shakeX: 0,
        shakeY: 0
      },

      // 爆发余波
      afterglow: {
        t: 0,
        x: 0, y: 0,
        p: 0,
        acc: 0
      },

      // 全局时间（棱镜闪烁、轨道呼吸相位）
      time: 0,

      trailAcc: 0
    };
  }

  // ==================== 粒子池操作 ====================
  // 获取一个粒子：优先空闲槽位，池满时回收 seq 最小的（最老）粒子
  _acquire(s) {
    let p;
    if (s.freeList.length > 0) {
      p = s.pool[s.freeList.pop()];
    } else {
      let oldestIdx = 0;
      let minSeq = Infinity;
      for (let i = 0; i < s.pool.length; i++) {
        if (s.pool[i].seq < minSeq) {
          minSeq = s.pool[i].seq;
          oldestIdx = i;
        }
      }
      p = s.pool[oldestIdx];
    }
    resetP(p);
    p.seq = ++s.seqCounter;
    return p;
  }

  // ==================== 生成器 ====================
  _spawnShard(s, x, y, ang, spd, opt) {
    const p = this._acquire(s);
    if (!p) return null;
    p.type = PT.SHARD;
    p.x = x; p.y = y;
    p.vx = Math.cos(ang) * spd;
    p.vy = Math.sin(ang) * spd;
    p.rot = ang + rand(-1.2, 1.2);
    p.rotSpd = (opt && opt.spin !== undefined) ? opt.spin : rand(-9, 9);
    p.a = (opt && opt.len) ? opt.len : rand(5, 15);
    p.b = p.a / rand(2, 5);
    p.life = (opt && opt.life) ? opt.life : rand(CONFIG.trail.lifeMin, CONFIG.trail.lifeMax);
    p.maxLife = p.life;
    p.drag = (opt && opt.drag !== undefined) ? opt.drag : CONFIG.trail.drag;
    const c = (opt && opt.col) ? opt.col : C.cyan;
    p.cr = c[0]; p.cg = c[1]; p.cb = c[2];
    p.alpha = (opt && opt.alpha !== undefined) ? opt.alpha : rand(0.65, 1);
    return p;
  }

  _spawnNeedle(s, x, y, ang, spd, life, col, len) {
    const p = this._acquire(s);
    if (!p) return null;
    p.type = PT.NEEDLE;
    p.x = x; p.y = y;
    p.vx = Math.cos(ang) * spd;
    p.vy = Math.sin(ang) * spd;
    p.rot = ang;
    p.a = len || rand(CONFIG.trail.needleLen[0], CONFIG.trail.needleLen[1]);
    p.b = rand(0.7, 1.6);
    p.life = life;
    p.maxLife = life;
    p.drag = CONFIG.trail.drag;
    p.cr = col[0]; p.cg = col[1]; p.cb = col[2];
    p.alpha = rand(0.6, 1);
    return p;
  }

  _spawnStreak(s, x, y, ang, len, life, col, vx, vy, drag) {
    const p = this._acquire(s);
    if (!p) return null;
    p.type = PT.STREAK;
    p.x = x; p.y = y;
    p.vx = vx; p.vy = vy;
    p.rot = ang;
    p.a = len;
    p.b = rand(0.8, 1.7);
    p.life = life;
    p.maxLife = life;
    p.drag = drag;
    p.cr = col[0]; p.cg = col[1]; p.cb = col[2];
    p.alpha = rand(0.55, 0.95);
    return p;
  }

  _spawnStar(s, x, y, len, life, rot, col) {
    const p = this._acquire(s);
    if (!p) return null;
    p.type = PT.STAR;
    p.x = x; p.y = y;
    p.vx = 0; p.vy = 0;
    p.a = len;
    p.arms = Math.random() < 0.5 ? 2 : 3;
    p.life = life;
    p.maxLife = life;
    p.rot = rot || 0;
    p.rotSpd = rand(-2.2, 2.2);
    p.drag = 2.5;
    const c = col || C.white;
    p.cr = c[0]; p.cg = c[1]; p.cb = c[2];
    p.alpha = 1;
    return p;
  }

  _spawnRing(s, x, y, o) {
    const p = this._acquire(s);
    if (!p) return null;
    p.type = PT.RING;
    p.x = x; p.y = y;
    p.vx = 0; p.vy = 0;
    p.r0 = o.r0;
    p.r1 = o.r1;
    p.a = o.r0;
    p.life = o.life;
    p.maxLife = o.life;
    p.rot = o.rot || 0;
    p.rotSpd = o.rotSpd || 0;
    p.b = o.lw || 2;
    p.alpha = o.alpha !== undefined ? o.alpha : 0.95;
    p.stretch = o.stretch || 1;
    const c = o.col || C.cyan;
    p.cr = c[0]; p.cg = c[1]; p.cb = c[2];
    p.drag = 0;
    return p;
  }

  // ==================== 输入（按键） ====================
  // 鼠标位移与速度由基类每帧写入 this.input，这里只处理左右键的蓄力状态
  onPointerDown(e) {
    const s = this.state;
    if (!s) return;
    if (e.button !== 0 && e.button !== 2) return;

    const c = s.charge;
    if (c.active) return;

    c.active = true;
    c.button = e.button;
    c.t = 0;
    c.power = 0;
    c.x = e.clientX;
    c.y = e.clientY;
    c.spawnAcc = 0;
    c.diffAcc = 0;
    c.shakeX = 0;
    c.shakeY = 0;

    // 原型在此把鼠标位置对齐到按下点。同步 x 与 lx 是为了避免下一帧
    // 把「上一帧位置 → 按下点」当成一段真实位移（触摸场景下会拉出假拖尾）。
    s.input.x = s.input.lx = e.clientX;
    s.input.y = s.input.ly = e.clientY;
  }

  onPointerUp(e) {
    const s = this.state;
    if (!s) return;

    const c = s.charge;
    if (!c.active || e.button !== c.button) return;

    // 原型用「按帧累加的蓄力时长」判定短按/长按，这里保持一致
    const held = c.t;
    const power = c.power;
    const btn = c.button;
    const x = s.input.x;
    const y = s.input.y;

    c.active = false;
    c.button = -1;
    c.shakeX = 0;
    c.shakeY = 0;

    if (held < CONFIG.charge.minClickTime) {
      // 视为普通单击
      if (btn === 0) this._glassClick(s, x, y);
      else this._rightClick(s, x, y);
    } else {
      if (btn === 0) this._leftBurst(s, x, y, power);
      else this._rightBurst(s, x, y, power);
    }
  }

  // 失焦时按键状态已丢失，收尾（原型 window blur 行为）
  onBlur() {
    if (this.state) this._cancelCharge(this.state);
  }

  // 光标移出窗口（原型 mouseout / relatedTarget 为空的等价钩子）
  onPointerLeave() {
    if (this.state) this._cancelCharge(this.state);
  }

  // 标签页切走时按键状态同样已丢失
  onVisibilityChange(hidden) {
    if (hidden && this.state) this._cancelCharge(this.state);
  }

  _cancelCharge(s) {
    const c = s.charge;
    if (!c.active) return;
    c.active = false;
    c.button = -1;
    c.shakeX = 0;
    c.shakeY = 0;
    for (let i = 0; i < s.pool.length; i++) {
      const p = s.pool[i];
      if (!p.active || !p.orbital) continue;
      p.orbital = false;
      p.vx = rand(-140, 140);
      p.vy = rand(-140, 140);
      p.drag = 1.6;
      if (p.life > 0.4) p.life = 0.4;
      p.rotSpd = rand(-3, 3);
    }
  }

  // ==================== 尺寸 ====================
  onResize(width, height) {
    const s = this.state;
    if (!s) return;
    s.W = width;
    s.H = height;
  }

  // ==================== 拖尾 ====================
  // 原型的拖尾在 pointermove 中按「移动像素数 × density」累积生成；
  // 基类没有逐事件钩子，这里改用每帧位移（input.lx/ly → input.x/y）做同样的累积，
  // 单位像素的生成密度与原文件一致。
  _emitTrail(s) {
    const M = s.input;

    // 蓄力期间不生成普通拖尾，由蓄力系统接管
    if (s.charge.active) return;

    const dx = M.x - M.frameLx;
    const dy = M.y - M.frameLy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 0.6) return;

    // 沿移动路径插值生成拖尾
    s.trailAcc += dist * CONFIG.trail.density;
    if (s.trailAcc > 14) s.trailAcc = 14;
    const n = Math.floor(s.trailAcc);
    s.trailAcc -= n;

    const dirAng = Math.atan2(dy, dx);
    const speed = M.speed;

    for (let i = 0; i < n; i++) {
      const t = (i + 0.6) / n;
      const px = M.x - dx * (1 - t);
      const py = M.y - dy * (1 - t);
      this._spawnTrailParticle(s, px, py, dirAng, speed);
    }
  }

  _spawnTrailParticle(s, x, y, ang, speed) {
    const M = s.input;
    const r = Math.random();
    const k = rand(CONFIG.trail.velK[0], CONFIG.trail.velK[1]);
    const vx = M.vx * k + rand(-CONFIG.trail.scatter, CONFIG.trail.scatter);
    const vy = M.vy * k + rand(-CONFIG.trail.scatter, CONFIG.trail.scatter);

    if (r < 0.40) {
      // 棱边残影
      const len = clamp(speed * CONFIG.trail.streakK,
        CONFIG.trail.streakLen[0], CONFIG.trail.streakLen[1]) * rand(0.7, 1.35);
      const rnd = Math.random();
      const col = rnd < 0.55 ? C.cyan : (rnd < 0.85 ? C.blue : C.white);
      this._spawnStreak(s, x, y, ang, len,
        rand(0.22, 0.45), col, vx, vy, CONFIG.trail.drag);
    } else if (r < 0.78) {
      // 菱形碎片
      const rnd = Math.random();
      const col = rnd < 0.55 ? C.cyan : (rnd < 0.85 ? C.blue : C.white);
      const p = this._spawnShard(s, x, y, ang + rand(-0.6, 0.6),
        Math.sqrt(vx * vx + vy * vy) * rand(0.8, 1.3), {
          col: col,
          len: rand(4.5, 13),
          life: rand(CONFIG.trail.lifeMin, CONFIG.trail.lifeMax),
          drag: CONFIG.trail.drag,
          alpha: rand(0.6, 1)
        });
      // 原型用 seqLastIdx() 取回刚生成的粒子覆盖初速度，这里直接用返回值（同一个粒子）
      if (p && p.active) { p.vx = vx; p.vy = vy; }
    } else {
      // 冰针
      const col = Math.random() < 0.6 ? C.cyan : C.white;
      const p = this._spawnNeedle(s, x, y, ang + rand(-0.25, 0.25),
        Math.sqrt(vx * vx + vy * vy) * rand(0.7, 1.2),
        rand(CONFIG.trail.lifeMin, CONFIG.trail.lifeMax), col,
        rand(CONFIG.trail.needleLen[0], CONFIG.trail.needleLen[1]) * 0.9);
      if (p && p.active) { p.vx = vx; p.vy = vy; }
    }
  }

  // ==================== 拖尾冲击辅助 ====================
  _shockwave(s, cx, cy, radius, strength, swirl) {
    const sw = swirl === undefined ? 0.6 : swirl;
    const r2 = radius * radius;
    for (let i = 0; i < s.pool.length; i++) {
      const p = s.pool[i];
      if (!p.active || p.orbital || p.type === PT.RING) continue;
      const dx = p.x - cx;
      const dy = p.y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const d = Math.sqrt(d2) || 0.0001;
      const f = 1 - d / radius;
      const nx = dx / d;
      const ny = dy / d;
      const imp = strength * f * f;
      // 径向 + 切向（螺旋飞散）
      p.vx += nx * imp - ny * imp * sw;
      p.vy += ny * imp + nx * imp * sw;
      // 亮度瞬间提升至白
      p.flash = 1;
      if (p.drag > 0.45) p.drag = 0.45;
      if (p.life < 0.35) p.life = Math.min(p.maxLife, p.life + 0.35);
    }
  }

  // ==================== 单击碎裂 ====================
  _glassClick(s, x, y) {
    const n = randInt(CONFIG.click.shardMin, CONFIG.click.shardMax);
    for (let i = 0; i < n; i++) {
      const ang = rand(0, TAU);
      const spd = rand(CONFIG.click.speedMin, CONFIG.click.speedMax);
      const rnd = Math.random();
      const col = rnd < 0.55 ? C.cyan : (rnd < 0.85 ? C.blue : C.white);
      this._spawnShard(s, x, y, ang, spd, {
        col: col,
        len: rand(5, 16),
        life: rand(0.35, 0.7),
        drag: 0.55,
        spin: rand(-11, 11),
        alpha: rand(0.7, 1)
      });
    }
    // 少量三角碎屑
    for (let i = 0; i < 10; i++) {
      const ang = rand(0, TAU);
      const spd = rand(280, 620);
      const col = Math.random() < 0.6 ? C.cyan : C.white;
      const p = this._spawnShard(s, x, y, ang, spd, {
        col: col, len: rand(4, 9), life: rand(0.3, 0.55), drag: 0.6
      });
      if (p) {
        p.type = PT.TRI;
        p.b = p.a * rand(0.7, 1.1);
        p.rotSpd = rand(-13, 13);
      }
    }
    // 冰针
    for (let i = 0; i < 8; i++) {
      this._spawnNeedle(s, x, y, rand(0, TAU), rand(260, 620), rand(0.28, 0.55), C.cyan,
        rand(10, 30));
    }
    // 六边形线框环
    this._spawnRing(s, x, y, {
      r0: 8, r1: CONFIG.click.ringR1, life: CONFIG.click.ringLife,
      lw: 2.2, rotSpd: 1.6, col: C.cyan
    });
    // 十字星芒
    this._spawnStar(s, x, y, CONFIG.click.starLen, CONFIG.click.starLife, rand(0, Math.PI), C.white);
    // 冲击已有拖尾粒子
    this._shockwave(s, x, y, CONFIG.click.shockRadius, CONFIG.click.shockPower, 0.6);
  }

  // ==================== 蓄力（左右键共用，靠 charge.button 区分） ====================
  _updateCharge(s, dt) {
    const c = s.charge;
    if (!c.active) return;

    c.t += dt;
    const pr = clamp(c.t / CONFIG.charge.maxTime, 0, 1);
    c.power = Math.pow(pr, CONFIG.charge.exponent);

    // 微震（进度 > 60% 后引入 1~3px 高频抖动）
    if (pr > CONFIG.charge.shakeStart) {
      const amp = ((pr - CONFIG.charge.shakeStart) / (1 - CONFIG.charge.shakeStart)) * 3;
      c.shakeX = rand(-amp, amp);
      c.shakeY = rand(-amp, amp);
    } else {
      c.shakeX = 0;
      c.shakeY = 0;
    }

    const isLeft = c.button === 0;

    // 持续生成被吸入的碎片
    const rate = isLeft ? (28 + 160 * pr) : (20 + 110 * pr);
    c.spawnAcc += rate * dt;
    let guard = 0;
    while (c.spawnAcc >= 1 && guard < 40) {
      c.spawnAcc -= 1;
      guard++;
      this._spawnChargeParticle(s, pr, isLeft);
    }
    if (c.spawnAcc > 40) c.spawnAcc = 40;

    // 左键：棱边衍射光斑
    if (isLeft && pr > CONFIG.charge.diffStart) {
      c.diffAcc += dt * (2 + 16 * pr);
      let g2 = 0;
      while (c.diffAcc >= 1 && g2 < 8) {
        c.diffAcc -= 1;
        g2++;
        this._spawnDiffraction(s, pr);
      }
      if (c.diffAcc > 8) c.diffAcc = 8;
    }

    // 核心颜色迁移（供绘制时参考）
    c.coreColor = coreColor(pr, isLeft);
  }

  _spawnChargeParticle(s, pr, isLeft) {
    const c = s.charge;
    const p = this._acquire(s);
    if (!p) return;

    const cx = c.x + c.shakeX;
    const cy = c.y + c.shakeY;

    const col = coreColor(pr, isLeft);

    // 随机形态：菱形碎片 / 冰针 / 残影
    const r = Math.random();
    if (r < 0.5) {
      p.type = PT.SHARD;
      p.a = rand(5, 14);
      p.b = p.a / rand(2, 4.5);
      p.alpha = rand(0.7, 1);
    } else if (r < 0.8) {
      p.type = PT.NEEDLE;
      p.a = rand(10, 34);
      p.b = rand(0.7, 1.5);
      p.alpha = rand(0.6, 0.95);
    } else {
      p.type = PT.STREAK;
      p.a = rand(8, 24);
      p.b = rand(0.8, 1.4);
      p.alpha = rand(0.5, 0.85);
    }

    p.cr = col[0]; p.cg = col[1]; p.cb = col[2];

    // 螺旋吸入轨道参数
    p.orbital = true;
    p.rot = rand(0, TAU);
    p.drag = 0;

    if (isLeft) {
      const R = lerp(CONFIG.charge.spawnRadius[0], CONFIG.charge.spawnRadius[1], pr);
      p.oRad = R * rand(0.72, 1.05);
      p.oTarget = (20 + 58 * (1 - pr)) * rand(0.82, 1.18);
      p.oAng = rand(0, TAU);
      p.oSpd = (2.2 + 9.5 * pr) * rand(0.85, 1.15);
      p.oDir = 1;
      p.oPull = 2.4 + 5.2 * pr;
      p.oResp = 0;
      p.oFreq = 0;
      p.oPhase = rand(0, TAU);
      p.twk = 0;
      p.life = rand(3.5, 5);
    } else {
      // 右键：多层反向同心环
      const ringCount = 2 + Math.floor(pr * 2.001); // 2 ~ 4
      const ri = randInt(0, ringCount - 1);
      const baseR = 46 + ri * 30;
      p.oRad = baseR * rand(0.9, 1.1);
      p.oTarget = baseR;
      p.oAng = rand(0, TAU);
      p.oSpd = (3 + 7.5 * pr) * (1 + ri * 0.28) * rand(0.9, 1.1);
      p.oDir = (ri % 2 === 0) ? 1 : -1;
      p.oPull = 7.5;
      p.oResp = 0.14;
      p.oFreq = 2.4 + ri * 0.7;
      p.oPhase = ri * 1.6;
      p.twk = 6 + ri * 2.5; // 棱镜闪烁
      p.life = rand(3.5, 5);
    }
    p.maxLife = p.life;

    p.x = cx + Math.cos(p.oAng) * p.oRad;
    p.y = cy + Math.sin(p.oAng) * p.oRad;
  }

  _spawnDiffraction(s, pr) {
    const c = s.charge;
    const a = rand(0, TAU);
    const r = (28 + 62 * (1 - pr)) * rand(0.85, 1.15);
    const x = c.x + Math.cos(a) * r;
    const y = c.y + Math.sin(a) * r;
    const p = this._spawnStar(s, x, y, rand(9, 22), 0.1, a + Math.PI * 0.25, C.white);
    if (p) {
      p.vx = Math.cos(a) * 50;
      p.vy = Math.sin(a) * 50;
      p.drag = 3.5;
    }
  }

  // ==================== 爆发 ====================
  _releaseOrbitals(s, cx, cy, P) {
    for (let i = 0; i < s.pool.length; i++) {
      const p = s.pool[i];
      if (!p.active || !p.orbital) continue;
      p.orbital = false;
      const dx = p.x - cx;
      const dy = p.y - cy;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const nx = dx / d;
      const ny = dy / d;
      const spd = (420 + 1250 * P) * rand(0.8, 1.45);
      // 保留对齐方向性的径向喷射 + 轻微切向
      p.vx = nx * spd - ny * spd * 0.32;
      p.vy = ny * spd + nx * spd * 0.32;
      p.drag = 0.6;
      p.life = rand(0.45, 0.9);
      p.maxLife = p.life;
      p.flash = 1;
      p.rotSpd = rand(-5, 5);
      p.oResp = 0;
      p.twk = 0;
    }
  }

  _leftBurst(s, x, y, power) {
    const P = Math.max(power, 0.02);
    const baseSpeed = CONFIG.leftBurst.speedBase + CONFIG.leftBurst.speedGain * P;

    // 1. 晶体炸裂：六向尖刺骨架
    const total = Math.round(CONFIG.leftBurst.shardBase + CONFIG.leftBurst.shardGain * P);
    for (let i = 0; i < total; i++) {
      const dirIdx = i % 6;
      const base = (dirIdx * Math.PI) / 3 + rand(-0.30, 0.30);
      const spd = baseSpeed * rand(0.55, 1.40);
      const rnd = Math.random();
      const col = rnd < 0.5 ? C.cyan : (rnd < 0.82 ? C.blue : C.white);
      const p = this._spawnShard(s, x, y, base, spd, {
        col: col,
        len: rand(5, 18),
        life: rand(0.4, 0.85),
        drag: 0.5,
        spin: rand(-12, 12),
        alpha: rand(0.7, 1)
      });
      if (p && Math.random() < 0.25) {
        p.type = PT.TRI;
        p.b = p.a * rand(0.7, 1.1);
      }
    }

    // 高速冰针（洋红点缀）
    const nNeedle = Math.round(24 + 70 * P);
    for (let i = 0; i < nNeedle; i++) {
      const a = rand(0, TAU);
      const isFast = Math.random() < 0.16;
      const col = isFast ? C.magenta : (Math.random() < 0.6 ? C.cyan : C.white);
      this._spawnNeedle(s, x, y, a, baseSpeed * rand(0.4, 1.25), rand(0.3, 0.7), col,
        rand(14, 40));
    }

    // 2. 六边形冲击环（2~3 层）
    const maxR = CONFIG.leftBurst.ringBase + CONFIG.leftBurst.ringGain * P;
    const ringN = P > 0.45 ? 3 : 2;
    for (let k = 0; k < ringN; k++) {
      this._spawnRing(s, x, y, {
        r0: 10 + k * 9,
        r1: maxR * (1 - k * 0.22),
        life: 0.34 + 0.28 * P + k * 0.07,
        lw: Math.max(0.8, 3 - k * 0.85),
        rotSpd: (k % 2 ? -1 : 1) * (1.3 + 2.2 * P),
        col: k === 0 ? C.cyan : C.blue,
        rot: k * 0.35
      });
    }

    // 3. 星芒爆发
    const ns = 3 + Math.round(2 * P);
    for (let i = 0; i < ns; i++) {
      this._spawnStar(s, x, y, (40 + 95 * P) * rand(0.7, 1.4),
        rand(0.2, 0.35), rand(0, Math.PI), C.white);
    }
    if (P > 0.7) {
      for (let i = 0; i < 6; i++) {
        this._spawnStar(s, x + rand(-30, 30), y + rand(-30, 30),
          (26 + 40 * P) * rand(0.7, 1.2), 0.13, rand(0, Math.PI), C.magenta);
      }
    }

    // 5. 核心释放：蓄力粒子集体反向喷射
    this._releaseOrbitals(s, x, y, P);

    // 4. 吹散拖尾
    const shR = CONFIG.leftBurst.shockBase + CONFIG.leftBurst.shockGain * P;
    const shP = CONFIG.leftBurst.shockPowerBase + CONFIG.leftBurst.shockPowerGain * P;
    this._shockwave(s, x, y, shR, shP, 0.72);

    // 6. 余波
    this._startAfterglow(s, x, y, P);
  }

  _rightClick(s, x, y) {
    // 右键蓄力不足：小六边形环 + 少量碎片，比左键更冷更小
    const n = 12;
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU);
      const spd = rand(200, 420);
      const p = this._spawnShard(s, x, y, a, spd, {
        col: Math.random() < 0.7 ? C.blue : C.purple,
        len: rand(4, 10),
        life: rand(0.3, 0.55),
        drag: 0.7,
        spin: rand(-8, 8),
        alpha: rand(0.6, 0.95)
      });
      if (p && Math.random() < 0.3) p.type = PT.TRI;
    }
    for (let i = 0; i < 6; i++) {
      this._spawnNeedle(s, x, y, rand(0, TAU), rand(220, 480), rand(0.25, 0.45), C.purple,
        rand(10, 26));
    }
    this._spawnRing(s, x, y, {
      r0: 6, r1: 58, life: 0.34, lw: 1.6, rotSpd: -2.2, col: C.purple
    });
    this._spawnStar(s, x, y, 22, 0.14, rand(0, Math.PI), C.white);
    this._shockwave(s, x, y, 130, 260, 0.5);
  }

  _rightBurst(s, x, y, power) {
    const P = Math.max(power, 0.02);
    const M = s.input;
    const baseSpeed = CONFIG.rightBurst.speedBase + CONFIG.rightBurst.speedGain * P;

    // 喷发方向：鼠标最后一段移动方向，若几乎静止则随机
    const mspd = Math.sqrt(M.vx * M.vx + M.vy * M.vy);
    const ang0 = mspd > 40 ? Math.atan2(M.vy, M.vx) : rand(0, TAU);

    const beams = CONFIG.rightBurst.beamMin +
      Math.round((CONFIG.rightBurst.beamMax - CONFIG.rightBurst.beamMin) * P);

    const palette = [C.cyan, C.blue, C.purple, C.white, C.cyan, C.blue];

    // 1. 分光定向束：密集冰针
    for (let b = 0; b < beams; b++) {
      const off = (b - (beams - 1) * 0.5) * CONFIG.rightBurst.spread;
      const ang = ang0 + off + rand(-0.02, 0.02);
      const col = palette[b % palette.length];
      const cnt = Math.round(22 + 62 * P);
      for (let i = 0; i < cnt; i++) {
        const a2 = ang + rand(-0.038, 0.038);
        const spd = baseSpeed * rand(0.72, 1.28);
        this._spawnNeedle(s, x, y, a2, spd, rand(0.35, 0.8), col, rand(14, 42));
      }
    }

    // 4. 碎片旋涡：围绕喷发轴线螺旋前进
    const nv = Math.round(40 + 100 * P);
    const perpX = -Math.sin(ang0);
    const perpY = Math.cos(ang0);
    for (let i = 0; i < nv; i++) {
      const side = Math.random() < 0.5 ? 1 : -1;
      const a2 = ang0 + rand(-0.45, 0.45);
      const spd = baseSpeed * rand(0.35, 0.9);
      const p = this._spawnShard(s, x, y, a2, spd, {
        col: Math.random() < 0.55 ? C.purple : C.blue,
        len: rand(4, 12),
        life: rand(0.4, 0.85),
        drag: 0.5,
        spin: rand(-10, 10),
        alpha: rand(0.6, 1)
      });
      if (p) {
        const perp = rand(70, 260) * side;
        p.vx += perpX * perp;
        p.vy += perpY * perp;
      }
    }

    // 3. 撕裂环：沿喷发方向拉伸的椭圆六边形
    const ringR = 120 + 420 * P;
    this._spawnRing(s, x, y, {
      r0: 12, r1: ringR, life: 0.48, lw: 2.4,
      rot: ang0, stretch: 1.9, col: C.purple
    });
    this._spawnRing(s, x, y, {
      r0: 8, r1: ringR * 0.66, life: 0.38, lw: 1.6,
      rot: ang0, stretch: 1.55, rotSpd: -3.4, col: C.cyan
    });

    // 星芒
    for (let i = 0; i < 3 + Math.round(2 * P); i++) {
      this._spawnStar(s, x + rand(-20, 20), y + rand(-20, 20),
        (30 + 60 * P) * rand(0.7, 1.3), rand(0.18, 0.3),
        ang0 + rand(-0.4, 0.4), i % 2 ? C.white : C.purple);
    }

    // 5. 风向感：场上拖尾被沿喷发方向吹走 + 折射偏折
    const windStrength = 320 + 820 * P;
    const cosA = Math.cos(ang0);
    const sinA = Math.sin(ang0);
    for (let i = 0; i < s.pool.length; i++) {
      const p = s.pool[i];
      if (!p.active || p.orbital || p.type === PT.RING) continue;
      const dx = p.x - x;
      const dy = p.y - y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 700) continue;
      const f = 1 - d / 700;
      p.vx += cosA * windStrength * f;
      p.vy += sinA * windStrength * f;
      // 折射偏折
      p.vx += -sinA * windStrength * f * 0.28;
      p.vy += cosA * windStrength * f * 0.28;
      p.flash = Math.max(p.flash, 0.85);
    }

    // 蓄力粒子释放
    this._releaseOrbitals(s, x, y, P * 0.85);

    // 6. 余波
    this._startAfterglow(s, x, y, P);
  }

  // ==================== 余波 ====================
  _startAfterglow(s, x, y, power) {
    const ag = s.afterglow;
    ag.t = CONFIG.afterglow.time;
    ag.x = x;
    ag.y = y;
    ag.p = power;
    ag.acc = 0;
  }

  _updateAfterglow(s, dt) {
    const ag = s.afterglow;
    if (ag.t <= 0) return;
    ag.t -= dt;
    ag.acc += dt * CONFIG.afterglow.rate * (0.4 + ag.p);
    let guard = 0;
    while (ag.acc >= 1 && guard < 20) {
      ag.acc -= 1;
      guard++;
      const a = rand(0, TAU);
      const r = rand(3, 38);
      const px = ag.x + Math.cos(a) * r;
      const py = ag.y + Math.sin(a) * r;
      const spd = rand(40, 150);
      if (Math.random() < 0.6) {
        this._spawnShard(s, px, py, a, spd, {
          col: Math.random() < 0.6 ? C.cyan : C.white,
          len: rand(3, 7),
          life: rand(0.4, 0.9),
          drag: 1.6,
          spin: rand(-6, 6),
          alpha: rand(0.5, 0.9)
        });
      } else {
        this._spawnNeedle(s, px, py, a, spd, rand(0.35, 0.7), C.blue, rand(8, 18));
      }
      if (Math.random() < 0.12) {
        this._spawnStar(s, px, py, rand(8, 18), 0.12, rand(0, Math.PI), C.white);
      }
    }
    if (ag.acc > 20) ag.acc = 20;
  }

  // ==================== 更新 ====================
  _updateParticles(s, dt) {
    const charge = s.charge;

    for (let i = 0; i < s.pool.length; i++) {
      const p = s.pool[i];
      if (!p.active) continue;

      p.life -= dt;
      if (p.life <= 0) {
        p.active = false;
        s.freeList.push(i);
        continue;
      }

      if (p.flash > 0) {
        p.flash -= dt / 0.15;
        if (p.flash < 0) p.flash = 0;
      }

      // ---- 六边形线框环 ----
      if (p.type === PT.RING) {
        const t = 1 - p.life / p.maxLife;
        const e = 1 - Math.pow(1 - t, 2.6);
        p.a = p.r0 + (p.r1 - p.r0) * e;
        p.rot += p.rotSpd * dt;
        continue;
      }

      // ---- 蓄力轨道粒子 ----
      if (p.orbital) {
        if (!charge.active) {
          // 蓄力已结束仍未释放：转为自由粒子
          p.orbital = false;
          p.vx = rand(-120, 120);
          p.vy = rand(-120, 120);
          p.drag = 1.4;
          p.oResp = 0;
          p.twk = 0;
        } else {
          p.oAng += p.oSpd * p.oDir * dt;

          const resp = p.oResp > 0
            ? 1 + p.oResp * Math.sin(s.time * p.oFreq + p.oPhase)
            : 1;
          const targetR = p.oTarget * resp;
          p.oRad += (targetR - p.oRad) * Math.min(1, p.oPull * dt);

          // 六边形半径调制 —— 形成收缩晶体环
          const hexMod = 1 + 0.09 * Math.cos(6 * p.oAng);
          const rr = p.oRad * hexMod;

          p.x = charge.x + charge.shakeX + Math.cos(p.oAng) * rr;
          p.y = charge.y + charge.shakeY + Math.sin(p.oAng) * rr;

          // 几何对齐：长轴逐渐趋向切向
          const tgt = p.oAng + Math.PI;
          const d = shortestAngle(tgt - p.rot);
          const alignSpeed = 2.5 + 12 * charge.power;
          p.rot += d * Math.min(1, alignSpeed * dt);
          continue;
        }
      }

      // ---- 自由物理 ----
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      const damp = Math.exp(-p.drag * dt);
      p.vx *= damp;
      p.vy *= damp;

      if (p.type === PT.NEEDLE || p.type === PT.STREAK) {
        // 冰针 / 残影保持方向锐利，不自转
        const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
        if (sp > 8) p.rot = Math.atan2(p.vy, p.vx);
      } else {
        p.rot += p.rotSpd * dt;
      }

      // 远离屏幕的粒子提前回收
      if (p.x < -260 || p.x > s.W + 260 || p.y < -260 || p.y > s.H + 260) {
        if (p.life < p.maxLife * 0.6) {
          p.active = false;
          s.freeList.push(i);
        }
      }
    }
  }

  update(dt, s) {
    if (!s) return;

    s.time += dt;

    // —— 鼠标位移 / 速度：由基类每帧写入 this.input（含平滑、跳变归零、封顶），
    //    这里不重复计算，只把蓄力原点同步到最新光标位置 ——
    const c = s.charge;
    if (c.active) {
      c.x = s.input.x;
      c.y = s.input.y;
    }

    // —— 拖尾生成 ——
    this._emitTrail(s);

    // —— 蓄力计时 & 吸附生成 ——
    this._updateCharge(s, dt);

    // —— 余波 ——
    this._updateAfterglow(s, dt);

    // —— 粒子更新 ——
    this._updateParticles(s, dt);
  }

  // ==================== 渲染 ====================
  render(s) {
    if (!s) return;
    const ctx = s.ctx;

    // 画布缓冲与 DPR 缩放由基类维护，这里统一使用 CSS 像素坐标
    ctx.clearRect(0, 0, s.W, s.H);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 1;

    for (let i = 0; i < s.pool.length; i++) {
      const p = s.pool[i];
      if (p.active) drawParticle(ctx, p, s.time);
    }

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }
}

if (!customElements.get('cursor-ice')) {
  customElements.define('cursor-ice', CursorIce);
}

export default CursorIce;
