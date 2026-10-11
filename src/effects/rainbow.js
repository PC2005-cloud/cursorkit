/**
 * cursor-rainbow —— 鼠标光标彩虹动效（左键主虹弧线 / 右键色相环）。
 *
 * 由 html/彩虹.html 原型移植：算法流程、数值、视觉表现与原文件一一对应。
 * 作为光标层组件，原型页面自身的行为已剔除：
 *   - 原型没有整屏铺底（页面底色来自 CSS 的 html/body background），render() 本来就是
 *     clearRect，移植后同样只清屏，绝不覆盖宿主页面；
 *   - 不拦截 contextmenu，宿主页面的右键菜单不受影响；
 *   - 画布创建、DPR 适配、尺寸同步、监听注册、rAF 循环、鼠标速度平滑
 *     以及「>300px 跳变归零 / 6000 封顶」全部由基类负责。
 *
 * 原型监听 mousemove / mousedown / mouseup，因此声明 inputFamily = 'mouse'。
 * 所有运行状态都放在 setup() 返回的 state 上，多实例互不干扰。
 */

import { CursorEffectElement } from '../core/base.js';
import { TAU, clamp, lerp, rand } from '../core/utils.js';

const DEG = Math.PI / 180;

/* ============================================================
   CONFIG —— 全部参数集中于此
   ============================================================ */
const CONFIG = {
  /* --- 光谱色系统：t=0 紫(280°) → t=1 红(0°)，HSL 连续插值 --- */
  spectrumHueStart: 280,   // 光谱起点色相（紫）
  spectrumHueEnd: 0,       // 光谱终点色相（红）
  sat: 100,                // 饱和度
  light: 58,               // 亮度基准

  /* --- 水滴池 --- */
  maxDrops: 1200,          // 水滴对象上限
  maxBands: 200,           // 色带对象上限
  dropRadiusMin: 2,        // 水滴半径下限
  dropRadiusMax: 6,        // 水滴半径上限
  dropAlphaMin: 0.3,       // 水滴透明度下限
  dropAlphaMax: 0.7,       // 水滴透明度上限
  glowScale: 2.2,          // 辉光半径倍率
  glowAlpha: 0.7,          // 辉光基础 alpha
  fanLenMin: 3,            // 色散扇最短
  fanLenMax: 8,            // 色散扇最长

  /* --- 拖尾 --- */
  trailGravity: 30,        // 拖尾水滴重力 px/s²
  trailStep: 9,            // 拖尾分段密度参考

  /* --- 主虹弧线（左键） --- */
  bowAngSegments: 60,      // 角度分段数
  bowRadSegments: 10,      // 半径分段数（色带层数）
  arcRadiusMin: 200,       // 弧半径起点
  arcRadiusMax: 350,       // 弧半径蓄满
  bandWidthMin: 60,        // 色带宽度起点
  bandWidthMax: 120,       // 色带宽度蓄满
  arcAngleMin: 60,         // 弧角度起点
  arcAngleMax: 180,        // 弧角度蓄满
  bowCenterOffset: 250,    // 圆心在光标下方距离
  bowHueSpeed: 0.1,        // 光谱偏移速度（圈/秒）

  /* --- 副虹 / 亚历山大暗带 --- */
  secondaryFactor: 1.3,    // 副虹半径 = 主虹半径 × 1.3
  secondaryBright: 0.7,    // 副虹亮度系数
  alexanderMin: 1.25,      // 暗带内边界倍率
  alexanderMax: 1.35,      // 暗带外边界倍率
  alexanderAlpha: 0.15,    // 暗带 alpha

  /* --- 蓄力 --- */
  chargeMax: 2.5,          // 蓄力满时长 s
  clickThreshold: 0.12,    // 低于此值视为普通单击

  /* --- 色相环（右键） --- */
  ringRadiusMin: 60,       // 环半径起点
  ringRadiusMax: 250,      // 环半径蓄满
  ringWidthMin: 3,         // 环线宽起点
  ringWidthMax: 12,        // 环线宽蓄满
  ringHueSpeedMin: 0.2,    // 色相循环速度起点（圈/秒）
  ringHueSpeedMax: 1.2,    // 色相循环速度蓄满
  ringLayer2At: 0.8,       // 二级环出现时间 s
  ringLayer3At: 1.5,       // 三级环出现时间 s

  /* --- 光谱化 --- */
  spectralRadius: 250,     // 光谱化场半径
  spectralDur: 0.3,        // 过渡时长
  spectralHold: 0.3,       // 保持时长
  spectralRecover: 0.35    // 恢复时长
};

/* ============================================================
   工具函数（纯函数，无实例状态）
   ============================================================ */
function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
function lerpHue(a, b, t) {
  const diff = ((b - a + 540) % 360) - 180;
  return a + diff * t;
}
function hslStr(h, s, l, a) {
  const hh = ((h % 360) + 360) % 360;
  if (a === undefined) return 'hsl(' + hh.toFixed(1) + ',' + s + '%,' + l + '%)';
  return 'hsla(' + hh.toFixed(1) + ',' + s + '%,' + l + '%,' + a + ')';
}

/* ============================================================
   光谱色系统 —— t:0(紫) → 1(红)，HSL 连续插值
   ============================================================ */
function spectrumHue(t) {
  t = clamp(t, 0, 1);
  return CONFIG.spectrumHueStart + (CONFIG.spectrumHueEnd - CONFIG.spectrumHueStart) * t;
}
/* 角度 → 色相（用于光谱化：0°红 / 60°橙 / 120°黄 / 180°绿 / 240°蓝 / 300°紫） */
const ANGLE_HUE_TABLE = [[0, 0], [60, 30], [120, 55], [180, 130], [240, 220], [300, 275], [360, 360]];
function angleToHue(deg) {
  deg = ((deg % 360) + 360) % 360;
  for (let i = 0; i < ANGLE_HUE_TABLE.length - 1; i++) {
    const a = ANGLE_HUE_TABLE[i], b = ANGLE_HUE_TABLE[i + 1];
    if (deg >= a[0] && deg <= b[0]) {
      const k = (deg - a[0]) / (b[0] - a[0]);
      return lerp(a[1], b[1], k);
    }
  }
  return 0;
}

/* ============================================================
   离屏纹理预渲染 —— 辉光软光斑 + 白色柔光
   ============================================================ */
// 原型用全局 document 的 createElement 预渲染贴图。移植后改用元素自身的
// ownerDocument：不触碰任何全局对象，每个实例各自持有一份，且绝不挂进 DOM。
// 这里的 cv.width / cv.height / getContext 都只作用于离屏贴图画布，与主画布无关。
const GLOW_STEPS = 48;

function buildGlowSprites(doc) {
  const sprites = [];
  const size = 64;
  for (let i = 0; i < GLOW_STEPS; i++) {
    const cv = doc.createElement('canvas');
    cv.width = cv.height = size;
    const g = cv.getContext('2d');
    const hue = i * (360 / GLOW_STEPS);
    const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grd.addColorStop(0, 'hsla(' + hue + ',100%,64%,0.60)');
    grd.addColorStop(0.42, 'hsla(' + hue + ',100%,60%,0.24)');
    grd.addColorStop(1, 'hsla(' + hue + ',100%,56%,0)');
    g.fillStyle = grd;
    // 贴图自身的整块填充：它落在离屏画布上，不是视口铺底，必须保留
    g.fillRect(0, 0, size, size);
    sprites.push(cv);
  }
  return sprites;
}

function buildWhiteSprite(doc) {
  const size = 128;
  const cv = doc.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(255,255,255,0.9)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  // 同上：离屏贴图自身的填充
  g.fillRect(0, 0, size, size);
  return cv;
}

export class CursorRainbow extends CursorEffectElement {
  /** 主题光标：紫调描边 + 电弧装饰 */
  cursorTheme() {
    return {
      edge: '#c9a6ff',
      fill: 'rgba(24, 14, 40, .88)',
      glow: '#a06cf0',
      deco: { color: [201, 166, 255], style: 'arc', rate: 18, speedGain: 0.28 }
    };
  }

  // 原型用的是 mousemove / mousedown / mouseup（不是 pointer 事件族），
  // 不声明这一行，基类会去监听 pointermove，动效将完全收不到鼠标输入。
  inputFamily = 'mouse';

  /* ============================================================
     初始化
     ============================================================ */
  // 只建池与状态，不注册任何监听（监听、DPR 缩放、rAF 全归基类）
  setup({ canvas, ctx, width, height, input }) {
    // 与原型一致：初始光标位置取视口中心。
    // 基类的 input 从 (0, 0) 起算，若不在这里对齐，首帧的位移会按「从左上角跳过来」计算，
    // 速度与拖尾生成量会和原型不同。
    input.x = input.lx = width * 0.5;
    input.y = input.ly = height * 0.5;

    // 线帽 / 线接：原型在 resize() 里设置。绘制过程中个别分支会临时改写
    // （色带用 butt、色散扇用 round），所以初始与每次 resize 都要重设才与原型时序一致。
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    return {
      // 本实例的画布上下文（已按 DPR 缩放过，统一使用 CSS 像素坐标）
      ctx,

      // 画布尺寸（CSS 像素），由基类 onResize 同步
      W: width,
      H: height,

      input,

      // 全局时间（原型的 time）
      time: 0,

      // 主虹整体脉动系数（原型的模块级 bowPulse）
      bowPulse: 1,

      // 双虹（亚历山大暗带）开关，原型中恒为 false
      dualBowActive: false,

      // 离屏贴图（每个实例一份）
      glowSprites: buildGlowSprites(canvas.ownerDocument),
      whiteSprite: buildWhiteSprite(canvas.ownerDocument),

      /* --- 水滴池 --- */
      drops: [],
      dropPool: [],

      /* --- 色带对象池 --- */
      bands: [],

      /* --- 特效层（星芒 / 闪光 / 光谱线 / 雨雾） --- */
      fx: [],

      /* --- 弧线生成系统 —— 主虹（左键） --- */
      bow: {
        charging: false,
        t: 0,
        phase: 0,
        dir: 1,
        cx: 0, cy: 0,
        R: CONFIG.arcRadiusMin,
        band: CONFIG.bandWidthMin,
        span: CONFIG.arcAngleMin,
        spawned: false,
        releasing: false,
        detached: false,
        releaseT: 0,
        freezeT: 0,
        overT: 0,
        power: 0,
        releaseR0: 0, releaseR1: 0,
        releaseSpan0: 180,
        mistTimer: 0,
        dripTimer: 0
      },

      /* --- 色相循环系统 —— 色相环（右键） --- */
      ring: {
        charging: false,
        t: 0,
        phase: 0,
        dir: 1,
        cx: 0, cy: 0,
        R: CONFIG.ringRadiusMin,
        lw: CONFIG.ringWidthMin,
        hueSpeed: CONFIG.ringHueSpeedMin,
        releasing: false,
        released: false,
        releaseT: 0,
        freezeT: 0,
        boostT: 0,
        power: 0,
        orbTimer: 0,
        orbs: []
      }
    };
  }

  /* ============================================================
     水滴池
     ============================================================ */
  _acquireDrop(s) {
    if (s.dropPool.length) return s.dropPool.pop();
    return {
      x: 0, y: 0, vx: 0, vy: 0, r: 3,
      hue: 0, hueFrom: 0, hueTo: 0, hueT: 1, hueDur: 0,
      alpha: 0.5, a: 0.5, life: 0, maxLife: 1, gravity: 30,
      kind: 'free', fan: 1, fanBoost: 0, fanFade: 1,
      glowMul: 1, lightMul: 1,
      attached: false, tx: 0, ty: 0, i: 0, j: 0, attachSpeed: 5,
      specPhase: 0, specTimer: 0, specOrigHue: 0,
      mist: false, mistK: 0, delay: 0,
      jx: 0, jy: 0, seed: Math.random()
    };
  }

  _spawnDrop(s, o) {
    if (s.drops.length >= CONFIG.maxDrops) return null;
    const d = this._acquireDrop(s);
    d.x = o.x; d.y = o.y;
    d.vx = o.vx || 0; d.vy = o.vy || 0;
    d.r = o.r !== undefined ? o.r : rand(CONFIG.dropRadiusMin, CONFIG.dropRadiusMax);
    d.hue = o.hue !== undefined ? o.hue : spectrumHue(Math.random());
    d.hueFrom = d.hue; d.hueTo = d.hue; d.hueT = 1; d.hueDur = 0;
    d.alpha = o.alpha !== undefined ? o.alpha : rand(CONFIG.dropAlphaMin, CONFIG.dropAlphaMax);
    d.a = d.alpha;
    d.life = 0;
    d.maxLife = o.maxLife || 1.2;
    d.gravity = o.gravity !== undefined ? o.gravity : CONFIG.trailGravity;
    d.kind = o.kind || 'free';
    d.fan = o.fan !== undefined ? o.fan : 1;
    d.fanBoost = 0;
    d.fanFade = 1;
    d.glowMul = o.glowMul !== undefined ? o.glowMul : 1;
    d.lightMul = o.lightMul !== undefined ? o.lightMul : 1;
    d.attached = !!o.attached;
    d.tx = o.tx !== undefined ? o.tx : d.x;
    d.ty = o.ty !== undefined ? o.ty : d.y;
    d.i = o.i || 0;
    d.j = o.j || 0;
    d.attachSpeed = o.attachSpeed || 5;
    d.specPhase = 0; d.specTimer = 0; d.specOrigHue = d.hue;
    d.mist = false; d.mistK = 0;
    d.delay = o.delay || 0;
    d.jx = 0; d.jy = 0;
    d.seed = Math.random();
    s.drops.push(d);
    return d;
  }

  _killDrop(s, i) {
    const drops = s.drops;
    const d = drops[i];
    drops[i] = drops[drops.length - 1];
    drops.pop();
    if (s.dropPool.length < 500) s.dropPool.push(d);
  }

  _dropBudget(s) { return CONFIG.maxDrops - s.drops.length; }

  /* ============================================================
     色带对象池
     ============================================================ */
  _spawnBand(s, o) {
    if (s.bands.length >= CONFIG.maxBands) return null;
    const b = {
      x: o.x, y: o.y,
      r: o.r,
      thick: o.thick || 5,
      a0: o.a0, a1: o.a1,
      hue0: o.hue0, hue1: o.hue1,
      alpha: o.alpha !== undefined ? o.alpha : 0.6,
      life: 0,
      maxLife: o.maxLife || 0.6,
      vr: o.vr || 0,
      vx: o.vx || 0,
      vy: o.vy || 0
    };
    s.bands.push(b);
    return b;
  }

  _updateBands(s, dt) {
    const bands = s.bands;
    for (let i = bands.length - 1; i >= 0; i--) {
      const b = bands[i];
      b.life += dt;
      if (b.life >= b.maxLife) { bands.splice(i, 1); continue; }
      b.r += b.vr * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
    }
  }

  _drawBand(s, b) {
    const ctx = s.ctx;
    const fade = 1 - b.life / b.maxLife;
    if (fade <= 0) return;
    const alpha = b.alpha * fade;
    if (alpha <= 0.012) return;
    const span = b.a1 - b.a0;
    if (span <= 0 || b.r <= 0.5) return;
    let segs = Math.round(span * b.r / 9);
    segs = clamp(segs, 3, 40);
    const step = span / segs;
    ctx.lineWidth = b.thick;
    ctx.lineCap = 'butt';
    const hueSpan = b.hue1 - b.hue0;
    for (let i = 0; i < segs; i++) {
      const t = (i + 0.5) / segs;
      ctx.strokeStyle = hslStr(b.hue0 + hueSpan * t, 100, 60, alpha);
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, b.a0 + i * step, b.a0 + (i + 1) * step + 0.02);
      ctx.stroke();
    }
  }

  /* ============================================================
     特效层（星芒 / 闪光 / 光谱线 / 雨雾）
     ============================================================ */
  _spawnFX(s, o) {
    if (s.fx.length > 400) s.fx.shift();
    s.fx.push(o);
  }

  _updateFX(s, dt) {
    const fx = s.fx;
    for (let i = fx.length - 1; i >= 0; i--) {
      const f = fx[i];
      f.life += dt;
      if (f.life >= f.maxLife) { fx.splice(i, 1); continue; }
      if (f.vx !== undefined) { f.x += f.vx * dt; f.y += f.vy * dt; }
    }
  }

  _drawFX(s) {
    const ctx = s.ctx;
    const fx = s.fx;
    for (let i = 0; i < fx.length; i++) {
      const f = fx[i];
      const k = f.life / f.maxLife;
      const a = 1 - k;
      if (f.type === 'star') {
        ctx.globalAlpha = a * 0.9;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.4;
        const L = f.size * (0.6 + k * 0.8);
        ctx.beginPath();
        ctx.moveTo(f.x - L, f.y); ctx.lineTo(f.x + L, f.y);
        ctx.moveTo(f.x, f.y - L); ctx.lineTo(f.x, f.y + L);
        ctx.moveTo(f.x - L * 0.5, f.y - L * 0.5); ctx.lineTo(f.x + L * 0.5, f.y + L * 0.5);
        ctx.moveTo(f.x - L * 0.5, f.y + L * 0.5); ctx.lineTo(f.x + L * 0.5, f.y - L * 0.5);
        ctx.stroke();
      } else if (f.type === 'flash') {
        const r = lerp(f.r0, f.r1, easeOutCubic(k));
        ctx.globalAlpha = a * 0.95;
        ctx.drawImage(s.whiteSprite, f.x - r, f.y - r, r * 2, r * 2);
      } else if (f.type === 'line') {
        ctx.globalAlpha = a * 0.5;
        ctx.strokeStyle = hslStr(f.hue, 100, 65, 1);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(f.x0, f.y0);
        ctx.lineTo(lerp(f.x0, f.x1, easeOutCubic(k)), lerp(f.y0, f.y1, easeOutCubic(k)));
        ctx.stroke();
      } else if (f.type === 'mist') {
        const r = f.r * (1 + k * 2.2);
        ctx.globalAlpha = a * 0.09;
        ctx.drawImage(s.whiteSprite, f.x - r, f.y - r, r * 2, r * 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  _glowSpriteOf(s, hue) {
    let i = Math.round(((hue % 360) + 360) % 360 / 360 * GLOW_STEPS);
    i = ((i % GLOW_STEPS) + GLOW_STEPS) % GLOW_STEPS;
    return s.glowSprites[i];
  }

  /* ============================================================
     水滴绘制 —— 辉光 → 本体 → 内部光路 → 色散扇 → 高光
     ============================================================ */
  _drawDrop(s, d, time) {
    const ctx = s.ctx;
    if (d.delay > 0) { d.delay -= 1 / 60; if (d.delay > 0) return; }
    let a = d.a;
    if (d.kind === 'bow') a *= s.bowPulse;
    if (a <= 0.015) return;

    const r = d.r;
    const hue = d.hue;
    const x = d.x + d.jx;
    const y = d.y + d.jy;

    /* --- 结构 1 前置：辉光（离屏纹理） --- */
    let glowR = r * CONFIG.glowScale * d.glowMul;
    if (d.mistK > 0) glowR *= (1 + d.mistK * 3);
    ctx.globalAlpha = Math.min(1, a * CONFIG.glowAlpha * (1 + d.fanBoost * 0.45));
    ctx.drawImage(this._glowSpriteOf(s, hue), x - glowR, y - glowR, glowR * 2, glowR * 2);

    /* 雾化的水滴只保留软光斑 */
    if (d.mistK > 0.85) return;

    const bodyA = d.mistK > 0 ? a * (1 - d.mistK) : a;

    /* --- 结构 1：水滴本体 --- */
    ctx.globalAlpha = bodyA;
    ctx.fillStyle = hslStr(hue, CONFIG.sat, CONFIG.light * d.lightMul);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();

    /* --- 结构 2：内部光路（进 → 折射 → 后壁反射 → 出） --- */
    if (r > 1.7 && bodyA > 0.08) {
      ctx.globalAlpha = bodyA * 0.6 * d.lightMul;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(x - r * 0.88, y - r * 0.36);
      ctx.lineTo(x + r * 0.14, y + r * 0.30);
      ctx.lineTo(x + r * 0.88, y - r * 0.10);
      ctx.stroke();
    }

    /* --- 结构 3：色散扇（红→紫连续过渡） --- */
    const fanA = (0.5 + d.fanBoost * 0.4) * d.fanFade * bodyA;
    if (fanA > 0.05 && r > 1.5) {
      const fanLen = (CONFIG.fanLenMin + r * 0.7) * d.fan;
      const ex = x + r * 0.85;
      const ey = y - r * 0.10;
      const N = 3;
      const spread = 0.9;
      ctx.lineWidth = 1.15;
      ctx.lineCap = 'round';
      for (let k = 0; k < N; k++) {
        const ang = -spread / 2 + spread * (k / (N - 1));
        const hueK = spectrumHue(k / (N - 1));
        ctx.globalAlpha = fanA;
        ctx.strokeStyle = hslStr(hueK, 100, 62, 1);
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex + Math.cos(ang) * fanLen, ey + Math.sin(ang) * fanLen);
        ctx.stroke();
      }
    }

    /* --- 结构 4：高光 --- */
    if (bodyA > 0.08) {
      ctx.globalAlpha = bodyA * 0.7;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x - r * 0.34, y - r * 0.38, Math.max(0.55, r * 0.2), 0, TAU);
      ctx.fill();
    }
  }

  /* ============================================================
     水滴更新
     ============================================================ */
  _updateDrops(s, dt, time) {
    const drops = s.drops;
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.life += dt;

      /* 颜色过渡 */
      if (d.hueT < d.hueDur) {
        d.hueT += dt;
        const k = clamp(d.hueT / d.hueDur, 0, 1);
        d.hue = lerpHue(d.hueFrom, d.hueTo, easeOutCubic(k));
      }

      /* 光谱化状态机 */
      if (d.specPhase === 1) {
        if (d.hueT >= d.hueDur) { d.specPhase = 2; d.specTimer = CONFIG.spectralHold; }
      } else if (d.specPhase === 2) {
        d.specTimer -= dt;
        if (d.specTimer <= 0) {
          d.specPhase = 3;
          d.hueFrom = d.hue;
          d.hueTo = d.specOrigHue;
          d.hueT = 0;
          d.hueDur = CONFIG.spectralRecover;
        }
      } else if (d.specPhase === 3) {
        if (d.hueT >= d.hueDur) { d.specPhase = 0; d.fanBoost = 0; }
      }

      /* 运动 */
      if (d.kind === 'bow' && d.attached) {
        const k = Math.min(1, dt * d.attachSpeed);
        d.x += (d.tx - d.x) * k;
        d.y += (d.ty - d.y) * k;
        d.jx = Math.sin(time * 7 + d.seed * 31) * 0.7;
        d.jy = Math.cos(time * 8.5 + d.seed * 47) * 0.7;
      } else {
        d.vy += d.gravity * dt;
        d.x += d.vx * dt;
        d.y += d.vy * dt;
        d.vx *= (1 - Math.min(0.6, dt * 0.35));
        d.jx = Math.sin(time * 6 + d.seed * 31) * 0.35;
        d.jy = Math.cos(time * 7 + d.seed * 47) * 0.35;
      }

      /* 雾化进度 */
      if (d.mist && d.mistK < 1) d.mistK = Math.min(1, d.mistK + dt * 1.4);

      /* 生命 / 淡出 */
      const lk = d.life / d.maxLife;
      if (lk >= 1 || d.x < -500 || d.x > s.W + 500 || d.y > s.H + 500 || d.y < -900) {
        this._killDrop(s, i);
        continue;
      }
      const fade = lk < 0.65 ? 1 : Math.max(0, 1 - (lk - 0.65) / 0.35);
      d.a = d.alpha * fade;
      d.fanFade = lk < 0.55 ? 1 : Math.max(0, 1 - (lk - 0.55) / 0.3);
    }
  }

  /* ============================================================
     拖尾 —— 沿轨迹排列成微弧的小水滴
     ============================================================ */
  // 原型在 mousemove 里按位移生成；基类已把本帧位移整理成 lx/ly → x/y，
  // 因此这里每帧处理一段，语义与原型一致（>1.5px 才生成）。
  _updateTrail(s) {
    const inp = s.input;
    const dist = Math.hypot(inp.x - inp.lx, inp.y - inp.ly);
    if (dist > 1.5) this._spawnTrail(s, inp.lx, inp.ly, inp.x, inp.y, dist);
  }

  _spawnTrail(s, x0, y0, x1, y1, dist) {
    if (this._dropBudget(s) < 40) return;
    const n = clamp(Math.round(dist / CONFIG.trailStep), 3, 5);
    const mx = (x0 + x1) * 0.5;
    const my = (y0 + y1) * 0.5;
    const nx = -(y1 - y0) / (dist || 1);
    const ny = (x1 - x0) / (dist || 1);
    const bend = Math.min(dist * 0.22, 14) * (Math.random() < 0.5 ? -1 : 1);
    const cxp = mx + nx * bend;
    const cyp = my + ny * bend;

    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const it = 1 - t;
      const bx = it * it * x0 + 2 * it * t * cxp + t * t * x1;
      const by = it * it * y0 + 2 * it * t * cyp + t * t * y1;
      this._spawnDrop(s, {
        x: bx,
        y: by,
        vx: (Math.random() - 0.5) * 34,
        vy: (Math.random() - 0.5) * 34,
        r: rand(2, 4),
        hue: spectrumHue(Math.random()),
        alpha: rand(0.35, 0.62),
        maxLife: rand(0.8, 1.5),
        gravity: CONFIG.trailGravity,
        kind: 'free'
      });
    }
  }

  /* ============================================================
     光谱化 —— 位置不变，颜色按角度重新分配
     ============================================================ */
  _spectralize(s, cx, cy, radius) {
    const affected = [];
    const drops = s.drops;
    for (let i = 0; i < drops.length; i++) {
      const d = drops[i];
      if (d.kind === 'bow') continue;
      const dx = d.x - cx, dy = d.y - cy;
      const dist = Math.hypot(dx, dy);
      if (dist > radius) continue;
      const ang = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
      d.specOrigHue = d.hue;
      d.hueFrom = d.hue;
      d.hueTo = angleToHue(ang);
      d.hueT = 0;
      d.hueDur = CONFIG.spectralDur;
      d.specPhase = 1;
      d.specTimer = CONFIG.spectralHold;
      d.fanBoost = 1;
      affected.push(d);
    }
    return affected;
  }

  _spawnSpectralLines(s, cx, cy, affected) {
    if (!affected.length) return;
    const count = Math.min(affected.length, 6 + Math.floor(Math.random() * 5));
    for (let i = 0; i < count; i++) {
      const d = affected[Math.floor(Math.random() * affected.length)];
      this._spawnFX(s, {
        type: 'line',
        x0: cx, y0: cy,
        x1: d.x, y1: d.y,
        hue: d.hueTo,
        life: 0, maxLife: 0.4
      });
    }
  }

  /* ============================================================
     单击（左键按下瞬间）—— 短弧 + 散射 + 星芒 + 光谱环
     ============================================================ */
  _spawnClickBurst(s, x, y) {
    /* 短弧：30°，半径 80，20~30 个水滴，从中心向两端展开 */
    const count = 22 + Math.floor(Math.random() * 8);
    const baseR = 80;
    const spanDeg = 30;
    const startA = (270 - spanDeg / 2) * DEG;
    const span = spanDeg * DEG;
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      const ang = startA + span * t;
      const rr = baseR + (Math.random() - 0.5) * 6;
      const delay = Math.abs(t - 0.5) * 2 * 0.2;
      this._spawnDrop(s, {
        x: x + Math.cos(ang) * rr,
        y: y + Math.sin(ang) * rr,
        vx: 0, vy: 0,
        r: rand(2, 3.6),
        hue: spectrumHue(t),
        alpha: rand(0.4, 0.65),
        maxLife: 0.55,
        gravity: 20,
        kind: 'free',
        delay: delay
      });
    }

    /* 向外散射水滴 */
    const sc = 8 + Math.floor(Math.random() * 7);
    for (let i = 0; i < sc; i++) {
      const ang = Math.random() * TAU;
      const sp = 150 + Math.random() * 250;
      this._spawnDrop(s, {
        x: x, y: y,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        r: rand(2, 4),
        hue: spectrumHue(Math.random()),
        alpha: rand(0.4, 0.7),
        maxLife: rand(0.7, 1.1),
        gravity: 60,
        kind: 'free'
      });
    }

    /* 光谱闪点（白色十字星芒） */
    this._spawnFX(s, { type: 'star', x: x, y: y, size: 16, life: 0, maxLife: 0.1 });

    /* 光谱环：12~18 个水滴组成的圆环，扩散到 60px */
    const rc = 12 + Math.floor(Math.random() * 7);
    const ringSpeed = 60 / 0.4;
    for (let i = 0; i < rc; i++) {
      const ang = (i / rc) * TAU;
      this._spawnDrop(s, {
        x: x, y: y,
        vx: Math.cos(ang) * ringSpeed,
        vy: Math.sin(ang) * ringSpeed,
        r: rand(2, 3.4),
        hue: spectrumHue(i / rc),
        alpha: rand(0.5, 0.75),
        maxLife: 0.4,
        gravity: 0,
        kind: 'free'
      });
    }
  }

  /* ============================================================
     弧线生成系统 —— 主虹（左键）
     ============================================================ */
  _spawnBowDrops(s) {
    const nAng = CONFIG.bowAngSegments;
    const nRad = CONFIG.bowRadSegments;
    for (let i = 0; i < nAng; i++) {
      for (let j = 0; j < nRad; j++) {
        if (this._dropBudget(s) <= 0) return;
        const a0 = Math.random() * TAU;
        const r0 = 100 + Math.random() * 260;
        const d = this._spawnDrop(s, {
          x: s.input.x + Math.cos(a0) * r0,
          y: s.input.y + Math.sin(a0) * r0,
          vx: 0, vy: 0,
          r: rand(2.6, 5),
          hue: spectrumHue(j / (nRad - 1)),
          alpha: rand(0.42, 0.66),
          maxLife: 9999,
          gravity: 0,
          kind: 'bow',
          attached: true,
          i: i, j: j,
          attachSpeed: 3.5 + Math.random() * 3.5
        });
        if (d) {
          d.delay = (i / nAng) * 0.35;
        }
      }
    }
  }

  _updateBowTargets(s) {
    const bow = s.bow;
    const nAng = CONFIG.bowAngSegments;
    const nRad = CONFIG.bowRadSegments;
    const spanRad = bow.span * DEG;
    const startA = (270 - bow.span / 2) * DEG;
    const R = bow.R;
    const w = bow.band;
    const cx = bow.cx;
    const cy = bow.cy;
    const phase = bow.phase;
    const half = w * 0.5;
    const invA = 1 / (nAng - 1);
    const invR = 1 / (nRad - 1);
    const drops = s.drops;
    for (let k = 0; k < drops.length; k++) {
      const d = drops[k];
      if (d.kind !== 'bow') continue;
      const ang = startA + spanRad * (d.i * invA);
      const rr = R - half + w * (d.j * invR);
      d.tx = cx + Math.cos(ang) * rr;
      d.ty = cy + Math.sin(ang) * rr;
      d.hue = spectrumHue(d.j * invR) + phase;
    }
  }

  _updateBow(s, dt, time) {
    const bow = s.bow;
    if (!bow.charging && !bow.releasing) return;

    if (bow.charging) {
      bow.t = Math.min(bow.t + dt, CONFIG.chargeMax + 1);
      const p = clamp(bow.t / CONFIG.chargeMax, 0, 1);
      const e = easeOutCubic(p);

      bow.R = lerp(CONFIG.arcRadiusMin, CONFIG.arcRadiusMax, e);
      bow.band = lerp(CONFIG.bandWidthMin, CONFIG.bandWidthMax, e);
      bow.span = lerp(CONFIG.arcAngleMin, CONFIG.arcAngleMax, e);
      bow.phase += bow.dir * CONFIG.bowHueSpeed * 360 * dt;

      if (!bow.spawned && bow.t > 0.06) {
        bow.spawned = true;
        this._spawnBowDrops(s);
      }

      this._updateBowTargets(s);

      /* 水滴滴落 */
      if (p > 0.4) {
        bow.dripTimer -= dt;
        if (bow.dripTimer <= 0) {
          bow.dripTimer = lerp(0.5, 0.08, p) * (0.6 + Math.random() * 0.8);
          if (this._dropBudget(s) > 20 && bow.spawned) {
            const jj = Math.floor(Math.random() * CONFIG.bowRadSegments);
            const ang = (270 - bow.span / 2 + Math.random() * bow.span) * DEG;
            const half = bow.band * 0.5;
            const rr = bow.R - half + bow.band * (jj / (CONFIG.bowRadSegments - 1));
            this._spawnDrop(s, {
              x: bow.cx + Math.cos(ang) * rr,
              y: bow.cy + Math.sin(ang) * rr,
              vx: (Math.random() - 0.5) * 12,
              vy: 20 + Math.random() * 40,
              r: rand(2, 3.6),
              hue: spectrumHue(jj / (CONFIG.bowRadSegments - 1)) + bow.phase,
              alpha: rand(0.4, 0.65),
              maxLife: rand(0.7, 1.1),
              gravity: 110,
              kind: 'free',
              fan: 2.5
            });
          }
        }
      }

      /* 雨雾 */
      if (p > 0.35) {
        bow.mistTimer -= dt;
        if (bow.mistTimer <= 0) {
          bow.mistTimer = lerp(0.5, 0.12, p);
          this._spawnFX(s, {
            type: 'mist',
            x: s.input.x + (Math.random() - 0.5) * 420,
            y: s.input.y + 60 + Math.random() * 260,
            r: rand(20, 60),
            life: 0, maxLife: rand(1.2, 2.2)
          });
        }
      }
    }

    if (bow.releasing) {
      if (bow.freezeT > 0) {
        bow.freezeT -= dt;
      } else {
        if (bow.overT > 0) bow.overT -= dt;
        bow.releaseT += dt;
        const rk = Math.min(1, bow.releaseT / 0.2);
        const ek = easeOutCubic(rk);
        bow.R = lerp(bow.releaseR0, bow.releaseR1, ek);
        bow.span = lerp(bow.releaseSpan0, 270, ek);
        this._updateBowTargets(s);
        if (rk >= 1 && !bow.detached) {
          bow.detached = true;
          this._detachBowDrops(s);
        }
        if (bow.releaseT > 4) {
          bow.releasing = false;
        }
      }
    }
  }

  _detachBowDrops(s) {
    const bow = s.bow;
    const power = bow.power;
    const cx = bow.cx, cy = bow.cy;
    const drops = s.drops;
    for (let k = 0; k < drops.length; k++) {
      const d = drops[k];
      if (d.kind !== 'bow') continue;
      d.kind = 'free';
      d.attached = false;
      const dx = d.x - cx, dy = d.y - cy;
      const L = Math.hypot(dx, dy) || 1;
      const sp = 300 + 800 * power;
      d.vx = (dx / L) * sp;
      d.vy = (dy / L) * sp;
      d.gravity = 100;
      d.fan = 6;
      d.fanFade = 1;
      d.maxLife = d.life + 1.6 + Math.random() * 1.0;
      d.alpha = Math.min(0.85, d.alpha * 1.15);
      d.mist = Math.random() < 0.3;
    }
    this._spawnSpectrumWave(s, power);
    this._spawnBowAfterimage(s);
  }

  /* 光谱波：7 条同心色带，内紫外红，向外扩张 */
  _spawnSpectrumWave(s, power) {
    const bow = s.bow;
    const cx = bow.cx, cy = bow.cy;
    const baseR = bow.R;
    const span = bow.span * DEG;
    const startA = (270 - bow.span / 2) * DEG;
    const maxR = 200 + 400 * power;
    for (let i = 0; i < 7; i++) {
      const t = i / 6;
      const r0 = baseR - 12 + i * 4;
      const vr = (maxR - r0) / 0.6;
      this._spawnBand(s, {
        x: cx, y: cy,
        r: Math.max(4, r0),
        thick: 6,
        a0: startA, a1: startA + span,
        hue0: spectrumHue(t), hue1: spectrumHue(t),
        alpha: 0.55,
        maxLife: 0.6,
        vr: vr
      });
    }
  }

  /* 光谱残影 */
  _spawnBowAfterimage(s) {
    const bow = s.bow;
    const cx = bow.cx, cy = bow.cy;
    const span = bow.span * DEG;
    const startA = (270 - bow.span / 2) * DEG;
    const R = bow.R;
    const w = bow.band;
    for (let i = 0; i < 5; i++) {
      const t = i / 4;
      this._spawnBand(s, {
        x: cx, y: cy,
        r: R - w * 0.5 + w * t,
        thick: w / 5,
        a0: startA, a1: startA + span,
        hue0: spectrumHue(t), hue1: spectrumHue(t),
        alpha: 0.15,
        maxLife: 1.2,
        vr: 0
      });
    }
  }

  /* ============================================================
     亚历山大暗带系统（双虹专用）
     ============================================================ */
  _drawAlexanderBand(s, cx, cy, R1, R2) {
    const ctx = s.ctx;
    ctx.globalAlpha = CONFIG.alexanderAlpha;
    ctx.fillStyle = '#1A1A2A';
    ctx.beginPath();
    ctx.arc(cx, cy, R2, 0, TAU);
    ctx.arc(cx, cy, R1, 0, TAU);
    ctx.fill('evenodd');
    ctx.globalAlpha = 1;
  }

  /* ============================================================
     色相循环系统 —— 色相环（右键）
     ============================================================ */
  _updateRing(s, dt) {
    const ring = s.ring;
    if (!ring.charging && !ring.releasing) return;

    if (ring.charging) {
      ring.t = Math.min(ring.t + dt, CONFIG.chargeMax + 1);
      const p = clamp(ring.t / CONFIG.chargeMax, 0, 1);
      const e = easeOutCubic(p);
      ring.R = lerp(CONFIG.ringRadiusMin, CONFIG.ringRadiusMax, e);
      ring.lw = lerp(CONFIG.ringWidthMin, CONFIG.ringWidthMax, e);
      ring.hueSpeed = lerp(CONFIG.ringHueSpeedMin, CONFIG.ringHueSpeedMax, e);
      ring.phase += ring.dir * ring.hueSpeed * dt;

      /* 环内光点 */
      ring.orbTimer -= dt;
      if (ring.orbTimer <= 0 && ring.orbs.length < 26) {
        ring.orbTimer = 0.06;
        ring.orbs.push({
          a: Math.random() * TAU,
          r: Math.random() * ring.R * 0.8,
          sp: (Math.random() - 0.5) * 1.4,
          vr: (Math.random() - 0.5) * 30,
          size: rand(1, 3),
          life: 0, maxLife: rand(0.6, 1.4)
        });
      }
    }

    for (let i = ring.orbs.length - 1; i >= 0; i--) {
      const o = ring.orbs[i];
      o.life += dt;
      if (o.life >= o.maxLife) { ring.orbs.splice(i, 1); continue; }
      o.a += o.sp * dt * (1 + ring.hueSpeed * 2);
      o.r += o.vr * dt;
      if (o.r < 0) o.r = 0;
      if (o.r > ring.R * 1.05) { ring.orbs.splice(i, 1); continue; }
    }

    if (ring.releasing) {
      if (ring.freezeT > 0) {
        ring.freezeT -= dt;
      } else {
        ring.releaseT += dt;
        if (ring.boostT > 0) {
          ring.boostT -= dt;
          ring.phase += ring.dir * 6 * dt; /* 5 倍色相加速 */
        } else if (!ring.released) {
          ring.released = true;
          this._ringBurst(s, ring.power);
        }
        if (ring.releaseT > 3) {
          ring.releasing = false;
          ring.orbs.length = 0;
        }
      }
    }
  }

  _drawRingLayer(s, cx, cy, R, lw, phase, alpha, segs) {
    const ctx = s.ctx;
    if (R < 2 || alpha <= 0.01) return;
    const step = TAU / segs;
    ctx.lineWidth = lw;
    ctx.lineCap = 'butt';
    for (let i = 0; i < segs; i++) {
      const a0 = i * step;
      let t = (a0 / TAU + phase) % 1;
      t = ((t % 1) + 1) % 1;
      ctx.strokeStyle = hslStr(spectrumHue(t), 100, 60, alpha);
      ctx.beginPath();
      ctx.arc(cx, cy, R, a0, a0 + step * 1.03);
      ctx.stroke();
    }
  }

  _drawRing(s, time) {
    const ring = s.ring;
    if (!ring.charging && !ring.releasing) return;
    const ctx = s.ctx;
    const cx = ring.cx, cy = ring.cy;

    /* 低频脉动 */
    const pulse = 1 + 0.05 * Math.sin(time * TAU * 1.2);
    const R = ring.R * pulse;
    const lw = ring.lw;

    /* 环内极淡光谱填充 */
    const hueNow = spectrumHue(((ring.phase % 1) + 1) % 1);
    const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, R));
    grd.addColorStop(0, 'hsla(0,0%,100%,0.08)');
    grd.addColorStop(0.6, 'hsla(' + hueNow + ',100%,60%,0.05)');
    grd.addColorStop(1, 'hsla(' + hueNow + ',100%,58%,0.09)');
    ctx.globalAlpha = 1;
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.fill();

    /* 光谱辉光 */
    ctx.globalAlpha = 0.2;
    const gl = ctx.createRadialGradient(cx, cy, R * 0.8, cx, cy, R * 1.3);
    gl.addColorStop(0, 'hsla(' + hueNow + ',100%,60%,0)');
    gl.addColorStop(0.55, 'hsla(' + hueNow + ',100%,60%,0.5)');
    gl.addColorStop(1, 'hsla(' + hueNow + ',100%,60%,0)');
    ctx.fillStyle = gl;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 1.3, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;

    /* 主环 */
    this._drawRingLayer(s, cx, cy, R, lw, ring.phase, 0.85, 84);

    /* 二级环 */
    if (ring.t > CONFIG.ringLayer2At || (ring.releasing && ring.released === false)) {
      const a2 = clamp((ring.t - CONFIG.ringLayer2At) / 0.4, 0, 1);
      this._drawRingLayer(s, cx, cy, R * 0.6, lw * 0.8, ring.phase * 1.5, 0.7 * a2, 64);
    }
    /* 三级环 */
    if (ring.t > CONFIG.ringLayer3At) {
      const a3 = clamp((ring.t - CONFIG.ringLayer3At) / 0.4, 0, 1);
      this._drawRingLayer(s, cx, cy, R * 0.3, lw * 0.65, ring.phase * 2.5, 0.6 * a3, 48);
    }

    /* 环内光点 */
    for (let i = 0; i < ring.orbs.length; i++) {
      const o = ring.orbs[i];
      const k = o.life / o.maxLife;
      const a = 1 - Math.abs(k - 0.5) * 2;
      if (a <= 0) continue;
      const ox = cx + Math.cos(o.a) * o.r;
      const oy = cy + Math.sin(o.a) * o.r;
      const hue = spectrumHue(((o.a / TAU + ring.phase) % 1 + 1) % 1);
      ctx.globalAlpha = a * 0.6;
      ctx.fillStyle = hslStr(hue, 100, 65, 1);
      ctx.beginPath();
      ctx.arc(ox, oy, o.size, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /* ============================================================
     右键爆发 —— 环碎裂成弧段 + 光谱风暴 + 色相波 + 七色射流
     ============================================================ */
  _ringBurst(s, power) {
    const ring = s.ring;
    const cx = ring.cx, cy = ring.cy;
    const layers = [
      { R: ring.R * 0.98, w: ring.lw, speed: 1 },
      { R: ring.R * 0.60, w: ring.lw * 0.8, speed: 1.5 },
      { R: ring.R * 0.30, w: ring.lw * 0.65, speed: 2.5 }
    ];

    /* --- 环碎裂成弧段 --- */
    for (let li = 0; li < layers.length; li++) {
      const L = layers[li];
      if (L.R < 16) continue;
      const count = 24 + Math.floor(Math.random() * 16);
      const step = TAU / count;
      for (let i = 0; i < count; i++) {
        if (s.bands.length >= CONFIG.maxBands) break;
        const a0 = i * step + Math.random() * 0.02;
        const a1 = a0 + step * (0.55 + Math.random() * 0.3);
        let t = (a0 / TAU + ring.phase + (L.speed - 1) * 0.1) % 1;
        t = ((t % 1) + 1) % 1;
        const hue = spectrumHue(t);
        const vr = (400 + 1000 * power) * (0.8 + Math.random() * 0.4);
        this._spawnBand(s, {
          x: cx, y: cy,
          r: L.R,
          thick: L.w * 0.8,
          a0: a0, a1: a1,
          hue0: hue, hue1: hue,
          alpha: 0.85,
          maxLife: 0.6 + Math.random() * 0.35,
          vr: vr
        });
      }
    }

    /* --- 光谱风暴 --- */
    let storm = Math.floor(80 + 250 * power);
    storm = Math.min(storm, this._dropBudget(s));
    for (let i = 0; i < storm; i++) {
      const ang = Math.random() * TAU;
      const sp = 300 + Math.random() * 500;
      this._spawnDrop(s, {
        x: cx, y: cy,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        r: rand(1, 4),
        hue: spectrumHue(Math.random()),
        alpha: rand(0.4, 0.75),
        maxLife: rand(0.8, 1.6),
        gravity: 70,
        kind: 'free',
        fan: 1.6
      });
    }

    /* --- 色相波：多层水滴圆环 --- */
    const waveCount = 3 + Math.floor(Math.random() * 3);
    for (let w = 0; w < waveCount; w++) {
      const count = 60;
      const hueOff = Math.random();
      const spd = 150 + 400 * power;
      for (let i = 0; i < count; i++) {
        if (this._dropBudget(s) <= 0) break;
        const a = (i / count) * TAU + Math.random() * 0.05;
        const hue = spectrumHue(((i / count) + hueOff) % 1);
        this._spawnDrop(s, {
          x: cx, y: cy,
          vx: Math.cos(a) * spd,
          vy: Math.sin(a) * spd,
          r: rand(1.5, 3.2),
          hue: hue,
          alpha: rand(0.45, 0.7),
          maxLife: 0.6,
          gravity: 0,
          kind: 'free'
        });
      }
    }

    /* --- 中心闪光 --- */
    this._spawnFX(s, { type: 'flash', x: cx, y: cy, r0: 5, r1: 30, life: 0, maxLife: 0.25 });
    this._spawnFX(s, { type: 'star', x: cx, y: cy, size: 26, life: 0, maxLife: 0.14 });

    /* --- 七色射流 --- */
    for (let k = 0; k < 7; k++) {
      const ang = (k / 7) * TAU - Math.PI / 2;
      const hue = spectrumHue(k / 6);
      const n = 24;
      for (let i = 0; i < n; i++) {
        if (this._dropBudget(s) <= 0) break;
        const sp = 500 + Math.random() * 400;
        const spread = (Math.random() - 0.5) * 0.22;
        this._spawnDrop(s, {
          x: cx, y: cy,
          vx: Math.cos(ang + spread) * sp,
          vy: Math.sin(ang + spread) * sp,
          r: rand(1.5, 3.5),
          hue: hue,
          alpha: rand(0.5, 0.8),
          maxLife: 0.5,
          gravity: 20,
          kind: 'free',
          fan: 2
        });
      }
    }
  }

  /* ============================================================
     鼠标事件 —— 按键由基类转发，速度平滑由基类计算
     ============================================================ */
  onPointerDown(e) {
    const s = this.state;
    if (!s) return;

    // 原型用 mousedown 事件的 clientX/clientY 作为原点，并把 mouseX/mouseY 与
    // lastX/lastY 一起对齐到该点（否则下一次移动会从旧位置拉出一条长拖尾）
    if (e.button === 0) this._onLeftDown(s, e.clientX, e.clientY);
    else if (e.button === 2) this._onRightDown(s, e.clientX, e.clientY);
  }

  onPointerUp(e) {
    const s = this.state;
    if (!s) return;
    if (e.button === 0) this._onLeftUp(s);
    else if (e.button === 2) this._onRightUp(s);
  }

  // 失焦清理蓄力状态（原型 window blur 的行为）
  onBlur() {
    const s = this.state;
    if (!s) return;
    const bow = s.bow;
    const ring = s.ring;

    if (bow.charging) {
      bow.charging = false;
      const drops = s.drops;
      for (let i = 0; i < drops.length; i++) {
        const d = drops[i];
        if (d.kind === 'bow') { d.maxLife = d.life + 0.4; d.attached = false; d.gravity = 40; }
      }
      bow.spawned = false;
    }
    if (ring.charging) {
      ring.charging = false;
      ring.releasing = false;
      ring.released = true;
      ring.orbs.length = 0;
    }
  }

  _onLeftDown(s, x, y) {
    const bow = s.bow;
    s.input.x = x; s.input.y = y;
    s.input.lx = x; s.input.ly = y;

    /* 光谱化场 + 光谱线 */
    const affected = this._spectralize(s, x, y, CONFIG.spectralRadius);
    this._spawnSpectralLines(s, x, y, affected);

    /* 单击特效 */
    this._spawnClickBurst(s, x, y);

    /* 开始主虹蓄力 */
    bow.charging = true;
    bow.t = 0;
    bow.cx = x;
    bow.cy = y + CONFIG.bowCenterOffset;
    bow.phase = Math.random() * 360;
    bow.dir = Math.random() < 0.5 ? 1 : -1;
    bow.R = CONFIG.arcRadiusMin;
    bow.band = CONFIG.bandWidthMin;
    bow.span = CONFIG.arcAngleMin;
    bow.spawned = false;
    bow.releasing = false;
    bow.detached = false;
    bow.releaseT = 0;
    bow.freezeT = 0;
    bow.overT = 0;
    bow.power = 0;
    bow.mistTimer = 0;
    bow.dripTimer = 0;
  }

  _onLeftUp(s) {
    const bow = s.bow;
    if (!bow.charging) return;
    bow.charging = false;
    const t = bow.t;
    if (t < CONFIG.clickThreshold) {
      const drops = s.drops;
      for (let i = 0; i < drops.length; i++) {
        const d = drops[i];
        if (d.kind === 'bow') { d.maxLife = d.life + 0.35; d.attached = false; d.gravity = 40; }
      }
      bow.spawned = false;
      return;
    }
    const power = Math.pow(clamp(t, 0, CONFIG.chargeMax) / CONFIG.chargeMax, 1.6);
    bow.power = power;
    bow.releasing = true;
    bow.detached = false;
    bow.releaseT = 0;
    bow.freezeT = 0.03;
    bow.overT = 0.05;
    bow.releaseR0 = bow.R;
    bow.releaseR1 = 500 + 300 * power;
    bow.releaseSpan0 = bow.span;

    /* 拖尾水滴被卷入光谱化 */
    const affected = this._spectralize(s, bow.cx, bow.cy - CONFIG.bowCenterOffset, CONFIG.spectralRadius);
    this._spawnSpectralLines(s, bow.cx, bow.cy - CONFIG.bowCenterOffset, affected);
  }

  _onRightDown(s, x, y) {
    const ring = s.ring;
    s.input.x = x; s.input.y = y;
    s.input.lx = x; s.input.ly = y;

    ring.charging = true;
    ring.t = 0;
    ring.cx = x;
    ring.cy = y;
    ring.dir = Math.random() < 0.5 ? 1 : -1;
    ring.phase = Math.random();
    ring.R = CONFIG.ringRadiusMin;
    ring.lw = CONFIG.ringWidthMin;
    ring.hueSpeed = CONFIG.ringHueSpeedMin;
    ring.releasing = false;
    ring.released = false;
    ring.releaseT = 0;
    ring.freezeT = 0;
    ring.boostT = 0;
    ring.power = 0;
    ring.orbs.length = 0;
    ring.orbTimer = 0;
  }

  _onRightUp(s) {
    const ring = s.ring;
    if (!ring.charging) return;
    ring.charging = false;
    const t = ring.t;
    if (t < CONFIG.clickThreshold) {
      ring.power = 0.12;
      ring.releasing = true;
      ring.released = false;
      ring.releaseT = 0;
      ring.freezeT = 0;
      ring.boostT = 0.08;
      return;
    }
    const power = Math.pow(clamp(t, 0, CONFIG.chargeMax) / CONFIG.chargeMax, 1.6);
    ring.power = power;
    ring.releasing = true;
    ring.released = false;
    ring.releaseT = 0;
    ring.freezeT = 0.03;
    ring.boostT = 0.15;

    /* 拖尾水滴被卷入光谱化 */
    const affected = this._spectralize(s, ring.cx, ring.cy, CONFIG.spectralRadius);
    this._spawnSpectralLines(s, ring.cx, ring.cy, affected);
  }

  /* ============================================================
     尺寸 —— 只同步动效自己的 W / H，画布尺寸与 DPR 由基类维护
     ============================================================ */
  onResize(width, height) {
    const s = this.state;
    if (!s) return;
    s.W = width;
    s.H = height;
    // 与原型 resize() 一致：重设线帽 / 线接（绘制过程中会被个别分支临时改写）
    s.ctx.lineCap = 'round';
    s.ctx.lineJoin = 'round';
  }

  /* ============================================================
     渲染循环
     ============================================================ */
  update(dt, s) {
    if (!s) return;

    s.time += dt;

    /* 主虹整体脉动 */
    s.bowPulse = 0.85 + 0.15 * Math.sin(s.time * TAU * 0.8);

    /* 拖尾（原型在 mousemove 里生成，基类已把本帧位移整理好） */
    this._updateTrail(s);

    this._updateBow(s, dt, s.time);
    this._updateRing(s, dt);
    this._updateDrops(s, dt, s.time);
    this._updateBands(s, dt);
    this._updateFX(s, dt);
  }

  render(s) {
    if (!s) return;
    const ctx = s.ctx;
    const bow = s.bow;

    // 清屏：原型这里本来就是 clearRect（页面底色来自 CSS 的 html/body background），
    // 移植后同样只清屏，不铺任何整屏背景，绝不遮住宿主页面。
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, s.W, s.H);

    /* 亚历山大暗带（双虹时启用） */
    if (s.dualBowActive && bow.releasing) {
      const r1 = bow.R;
      const r2 = r1 * CONFIG.secondaryFactor;
      this._drawAlexanderBand(s, bow.cx, bow.cy, r1 * CONFIG.alexanderMin, r2 * CONFIG.alexanderMax);
    }

    /* 色带 */
    for (let i = 0; i < s.bands.length; i++) this._drawBand(s, s.bands[i]);

    /* 色相环 */
    this._drawRing(s, s.time);

    /* 水滴 */
    for (let i = 0; i < s.drops.length; i++) this._drawDrop(s, s.drops[i], s.time);

    /* 特效 */
    this._drawFX(s);

    ctx.globalAlpha = 1;
  }
}

if (!customElements.get('cursor-rainbow')) {
  customElements.define('cursor-rainbow', CursorRainbow);
}

export default CursorRainbow;
