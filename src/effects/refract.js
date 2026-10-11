/**
 * cursor-refract —— 鼠标光标光折射动效（左键折射透镜 / 右键全反射导波管）。
 *
 * 由 html/光折射.html 原型移植：算法流程、数值、视觉表现与原文件一一对应。
 * 作为光标层组件，原型页面自身的行为已剔除：
 *   - 不携带页面底色：原型 canvas 本身就是透明的，render() 里只有 clearRect，
 *     没有任何整屏铺底绘制（页面深色底来自 CSS 的 body 背景，不属于绘制内容）；
 *   - 不拦截 contextmenu，宿主页面的右键菜单不受影响；
 *   - 画布创建、DPR 适配、尺寸同步、监听注册、rAF 循环均由基类负责。
 *
 * 原型监听 mousemove / mousedown / mouseup，因此声明 inputFamily = 'mouse'。
 * 所有运行状态（光线池 / 光点池 / 介质 / 特效列表 / 延时任务）都放在
 * setup() 返回的 state 上，多实例互不干扰。
 */

import { CursorEffectElement } from '../core/base.js';
import { clamp, rand } from '../core/utils.js';

/* ============================================================
   CONFIG —— 全部参数集中在此
   ============================================================ */
const CONFIG = {
  /* 对象池上限 */
  maxRays: 400,
  maxMotes: 800,

  /* 折射率（玻璃 / 空气） */
  nAir: 1.0,
  nGlass: 1.5,
  nRed: 1.47,
  nGreen: 1.50,
  nBlue: 1.53,
  /* 全反射临界角 sinθc = n2/n1 （玻璃→空气 ≈ 41.8°） */
  criticalAngle: Math.asin(1 / 1.5),

  /* 色散强度倍率与分解条数 */
  dispersionStrength: 1.0,
  dispersionCount: 3,

  /* 光线生命周期与点阵上限 */
  maxBounces: 8,
  rayMaxDots: 12,

  /* 光线分支概率（爆发时的分裂） */
  branchChance: 0.30,
  branchMin: 2,
  branchMax: 3,

  /* 蓄力时长阈值 */
  chargeMax: 2.5,          // 满蓄力秒数
  chargeMinClick: 0.12,    // 低于该值视为普通单击
  microShakeStart: 0.55,   // 蓄力超过该比例开始微震
  microShakeAmp: 2.6,      // 微震最大幅度 px

  /* 左键：透镜介质 */
  lensMinW: 60, lensMinH: 40,
  lensMaxW: 200, lensMaxH: 120,
  lensBreathHz: 1.0,
  lensBreathAmp: 0.05,
  focusMinDist: 60, focusMaxDist: 120,
  focusMinR: 3, focusMaxR: 12,
  focusBurstR: 30,

  /* 右键：导波管 */
  guideMinGap: 60, guideMaxGap: 100,
  guideMinLen: 300, guideMaxLen: 500,
  guideInAngle: 45 * Math.PI / 180,

  /* 拖尾 */
  trailMinDist: 5,
  trailLifeMin: 0.30,
  trailLifeMax: 0.80,

  /* 光路重定向（单击冲击） */
  redirectRadius: 30,
  redirectInfluence: 250,
  redirectDur: 0.40,
  redirectBend: 0.72,

  /* 两组配色 */
  cold: {
    incident: '#FFFFFF',
    refract: '#4FE3FF',
    bend: '#9B5CFF',
    focus: '#FF4FD8',
    boundary: 'rgb(58,90,138)',
    medium: 'rgb(26,42,74)',
    spectrum: ['#FF3D3D', '#FF8C1A', '#FFD24A', '#3DFF7A', '#4FE3FF', '#9B5CFF']
  },
  warm: {
    incident: '#FFFFFF',
    reflect: '#FF8C1A',
    multi: '#FFD24A',
    wall: 'rgb(138,90,42)',
    medium: 'rgb(42,26,10)',
    critical: '#FF3D5D',
    out: '#FFE8B0',
    spectrum: ['#FFE8B0', '#FFD24A', '#FF8C1A', '#FF3D5D']
  }
};

/* 导波管内多次反射的颜色阶梯（白 → 橙 → 金 → 暗橙） */
const GUIDE_RAMP = ['#FFFFFF', '#FFE8B0', '#FFD24A', '#FF8C1A', '#B36A1A'];

/* ============================================================
   工具函数
   ============================================================ */
function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/* 线段求交 */
function segX(x1, y1, x2, y2, x3, y3, x4, y4) {
  const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
  const u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
}

/* 线段与椭圆求交（返回最近正根命中点） */
function segEllipse(x1, y1, x2, y2, cx, cy, a, b) {
  const dx = x2 - x1, dy = y2 - y1;
  const u = x1 - cx, v = y1 - cy;
  const A = dx * dx / (a * a) + dy * dy / (b * b);
  if (A < 1e-12) return null;
  const B = 2 * (u * dx / (a * a) + v * dy / (b * b));
  const C = u * u / (a * a) + v * v / (b * b) - 1;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = (-B - sq) / (2 * A);
  if (t < 0 || t > 1) {
    t = (-B + sq) / (2 * A);
    if (t < 0 || t > 1) return null;
  }
  return { x: x1 + dx * t, y: y1 + dy * t, t: t };
}

/* ============================================================
   离屏纹理预渲染（光点 / 辉光精灵）
   ============================================================ */
// 原型用全局 document 预渲染贴图，并缓存在模块级 Map 里。
// 移植后改用元素自身的 ownerDocument，缓存挂到实例 state 上：
// 不触碰任何全局对象，多实例互不共享，且绝不挂进 DOM。
// 这里的 c.width / c.height / getContext 只作用于离屏贴图画布，与主画布无关。
function makeSprite(doc, hex, radius, coreWhite) {
  const size = radius * 2;
  const c = doc.createElement('canvas');
  c.width = size; c.height = size;
  const g = c.getContext('2d');
  const rgb = hexToRgb(hex);
  const grd = g.createRadialGradient(radius, radius, 0, radius, radius, radius);
  if (coreWhite) {
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.30, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.85)');
    grd.addColorStop(1, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0)');
  } else {
    grd.addColorStop(0, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',1)');
    grd.addColorStop(1, 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0)');
  }
  g.fillStyle = grd;
  g.beginPath(); g.arc(radius, radius, radius, 0, Math.PI * 2); g.fill();
  return c;
}

function getSprite(s, hex, radius, coreWhite) {
  const key = hex + '|' + radius + '|' + (coreWhite ? 1 : 0);
  let c = s.sprites.get(key);
  if (c) return c;
  c = makeSprite(s.doc, hex, radius, coreWhite);
  s.sprites.set(key, c);
  return c;
}

/* ============================================================
   折射计算 —— 斯涅尔定律
   ============================================================ */
/**
 * @param dx,dy   入射方向（单位向量）
 * @param nx,ny   指向入射侧的法线（单位向量）
 * @param n1      入射侧折射率
 * @param n2      出射侧折射率
 * @returns {dx,dy,tir} 折射方向 / 是否全反射
 */
function snell(dx, dy, nx, ny, n1, n2) {
  const cosI = clamp(-(dx * nx + dy * ny), -1, 1);
  const eta = n1 / n2;
  const sin2T = eta * eta * (1 - cosI * cosI);
  if (sin2T > 1) {
    // 全反射：方向关于法线镜像
    const d = dx * nx + dy * ny;
    return { dx: dx - 2 * d * nx, dy: dy - 2 * d * ny, tir: true, cosI: cosI };
  }
  const cosT = Math.sqrt(1 - sin2T);
  const rx = eta * dx + (eta * cosI - cosT) * nx;
  const ry = eta * dy + (eta * cosI - cosT) * ny;
  return { dx: rx, dy: ry, tir: false, cosI: cosI };
}

/* ============================================================
   色散系统 —— 一条白光分解成多条色光
   ============================================================ */
const DISPERSION_DEFS = [
  { n: CONFIG.nRed, color: '#FF6A3D' },
  { n: CONFIG.nGreen, color: '#3DFF7A' },
  { n: CONFIG.nBlue, color: '#4FE3FF' }
];

/* 介质碎片（纯函数） */
function makeShard(x, y, ang, sp) {
  const n = 5 + Math.floor(Math.random() * 3);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
    const rr = 0.5 + Math.random() * 0.7;
    pts.push(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  return {
    x: x, y: y,
    vx: Math.cos(ang) * sp,
    vy: Math.sin(ang) * sp,
    rot: Math.random() * Math.PI * 2,
    vrot: rand(-5, 5),
    size: 8 + Math.random() * 14,
    life: 0,
    maxLife: 0.9 + Math.random() * 0.5,
    pts: pts
  };
}

export class CursorRefract extends CursorEffectElement {
  // 原型用的是 mousemove / mousedown / mouseup（不是 pointer 事件族），
  // 不声明这一行，基类会去监听 pointermove，动效将完全收不到鼠标输入。
  inputFamily = 'mouse';

  /* ============================================================
     初始化 —— 只建池与状态，不注册任何监听
     ============================================================ */
  setup({ canvas, ctx, width, height, input }) {
    // 与原型一致：初始光标位置取视口中心（原型 mouse.x = VW / 2）。
    // 基类的 input 从 (0, 0) 起算，若不在这里对齐，首帧会按「从左上角跳过来」计算位移。
    input.x = input.lx = width * 0.5;
    input.y = input.ly = height * 0.5;

    /* 光线池 */
    const rays = [];
    const freeRayIdx = [];
    for (let i = 0; i < CONFIG.maxRays; i++) {
      rays.push({
        idx: i,
        active: false,
        mode: 'trail',        // trail | burst | lens | guide
        pts: [],              // 折线顶点（扁平数组 x,y）
        x: 0, y: 0,           // 头部
        px: 0, py: 0,         // 上一帧位置
        dx: 0, dy: 0,         // 方向
        speed: 0,
        grown: 0,
        maxLen: 0,
        ox: 0, oy: 0,         // 爆发光线原点
        color: '#FFFFFF',
        alpha: 1,
        life: 0, maxLife: 1,
        width: 1.5,
        bounces: 0,
        focusTarget: false,
        split: false,
        splitAt: 0,
        didSplit: false,
        leak: false
      });
      freeRayIdx.push(CONFIG.maxRays - 1 - i);
    }

    /* 光点池 */
    const motes = [];
    const freeMoteIdx = [];
    for (let i = 0; i < CONFIG.maxMotes; i++) {
      motes.push({
        idx: i, active: false,
        x: 0, y: 0, vx: 0, vy: 0,
        r: 2, color: '#FFFFFF',
        life: 0, maxLife: 0.4
      });
      freeMoteIdx.push(CONFIG.maxMotes - 1 - i);
    }

    return {
      // 本实例的画布上下文（已按 DPR 缩放过，统一使用 CSS 像素坐标）
      ctx,

      // 画布尺寸（CSS 像素），由基类 onResize 同步
      W: width,
      H: height,

      input,

      // 离屏贴图的宿主文档与缓存（每个实例一份）
      doc: canvas.ownerDocument,
      sprites: new Map(),

      rays,
      freeRayIdx,
      motes,
      freeMoteIdx,

      /* 介质系统 —— 左键透镜 / 右键导波管 */
      lens: {
        active: false,
        x: 0, y: 0,
        a: 30, b: 20,
        p: 0,
        breathe: 1,
        focusX: 0, focusY: 0,
        focusDist: 60,
        focusR: 3,
        spawnT: 0,
        energy: 0
      },
      guide: {
        active: false,
        x: 0, y: 0,
        gap: 60,
        len: 300,
        spawnT: 0,
        jitter: false,
        p: 0
      },

      /* 临时球形介质（光路重定向） {x,y,r,life,maxLife} */
      redirects: [],
      /* 折射光弧 {x,y,r0,r1,a0,a1,life,maxLife,color} */
      arcs: [],
      /* 色散环 {x,y,r,maxR,life,maxLife} */
      rings: [],
      /* 锯齿光爆环 {x,y,r,maxR,life,maxLife,segs} */
      sawRings: [],
      /* 介质碎片 {x,y,vx,vy,rot,vrot,size,life,maxLife,pts} */
      shards: [],
      /* 闪光 {x,y,r,life,maxLife,color} */
      flashes: [],
      /* 管壁残影 {x,y,gap,len,life,maxLife} */
      wallGhosts: [],

      /* 延时任务 */
      timers: [],

      /* 输入与全局状态 */
      charging: { on: false, btn: 0, t: 0 },
      trailInit: false,      // 是否已收到过第一次移动（对应原型的 mouse.has）
      freezeT: 0,
      shakeX: 0, shakeY: 0,
      T: 0
    };
  }

  /* ============================================================
     光线池
     ============================================================ */
  _allocRay(s) {
    while (s.freeRayIdx.length) {
      const i = s.freeRayIdx.pop();
      const r = s.rays[i];
      r.active = true;
      return r;
    }
    return null;
  }

  _killRay(s, r) {
    if (!r.active) return;
    r.active = false;
    s.freeRayIdx.push(r.idx);
  }

  /* ============================================================
     光点池
     ============================================================ */
  _spawnMote(s, x, y, color, life, r, vx, vy) {
    if (!s.freeMoteIdx.length) return null;
    const i = s.freeMoteIdx.pop();
    const m = s.motes[i];
    m.active = true;
    m.x = x; m.y = y;
    m.vx = vx || 0; m.vy = vy || 0;
    m.r = (r === undefined) ? 2 : r;
    m.color = color || '#FFFFFF';
    m.life = 0;
    m.maxLife = life || 0.4;
    return m;
  }

  _stepMotes(s, dt) {
    for (let i = 0; i < s.motes.length; i++) {
      const m = s.motes[i];
      if (!m.active) continue;
      m.life += dt;
      if (m.life >= m.maxLife) {
        m.active = false;
        s.freeMoteIdx.push(i);
        continue;
      }
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      const damp = Math.pow(0.12, dt);
      m.vx *= damp; m.vy *= damp;
    }
  }

  _drawMotes(s) {
    const ctx = s.ctx;
    for (let i = 0; i < s.motes.length; i++) {
      const m = s.motes[i];
      if (!m.active) continue;
      const t = 1 - m.life / m.maxLife;
      if (t <= 0.01) continue;
      const sp = getSprite(s, m.color, 12, true);
      const sz = m.r * 6;
      ctx.globalAlpha = t * 0.95;
      ctx.drawImage(sp, m.x - sz * 0.5, m.y - sz * 0.5, sz, sz);
    }
  }

  /* ============================================================
     延时任务
     ============================================================ */
  _after(s, t, fn) { s.timers.push({ t: t, fn: fn }); }

  _stepTimers(s, dt) {
    for (let i = s.timers.length - 1; i >= 0; i--) {
      s.timers[i].t -= dt;
      if (s.timers[i].t <= 0) {
        const f = s.timers[i].fn;
        s.timers.splice(i, 1);
        f();
      }
    }
  }

  /* ============================================================
     鼠标输入 —— 位置与速度由基类维护，这里只处理按键与收尾
     ============================================================ */
  onPointerDown(e) {
    const s = this.state;
    if (!s) return;
    if (e.button !== 0 && e.button !== 2) return;
    if (s.charging.on) return;
    this._startCharge(s, e.button);
  }

  onPointerUp(e) {
    const s = this.state;
    if (!s) return;
    if (e.button !== 0 && e.button !== 2) return;
    if (!s.charging.on) return;
    this._endCharge(s);
  }

  // 失焦：原型 window blur 里取消蓄力，并清掉透镜光线
  onBlur() {
    const s = this.state;
    if (!s) return;
    s.charging.on = false;
    s.charging.t = 0;
    s.lens.active = false;
    s.guide.active = false;
    for (let i = 0; i < s.rays.length; i++) {
      if (s.rays[i].active && s.rays[i].mode === 'lens') this._killRay(s, s.rays[i]);
    }
  }

  _startCharge(s, btn) {
    s.charging.on = true;
    s.charging.btn = btn;
    s.charging.t = 0;
    if (btn === 0) this._initLens(s);
    else this._initGuide(s);
  }

  _endCharge(s) {
    const btn = s.charging.btn;
    const t = s.charging.t;
    const power = Math.pow(clamp(t / CONFIG.chargeMax, 0, 1), 1.6);

    if (t < CONFIG.chargeMinClick) {
      if (btn === 0) this._doLeftClick(s, s.input.x, s.input.y);
      else this._doRightClick(s, s.input.x, s.input.y);
      s.charging.on = false;
      s.charging.t = 0;
      s.lens.active = false;
      s.guide.active = false;
      return;
    }

    if (btn === 0) {
      this._burstLens(s, power, s.lens.focusX, s.lens.focusY);
    } else {
      this._burstGuide(s, power);
    }
    s.charging.on = false;
    s.charging.t = 0;
  }

  /* ============================================================
     拖尾 —— 沿鼠标轨迹生成光线
     ============================================================ */
  // 原型在每次 mousemove 里按「上一次事件位置 → 本次事件位置」生成拖尾；
  // 基类每帧只提供一个位移样本，因此按 trailMinDist 把本帧位移切段逐段生成，
  // 判据与原型一致，拖尾密度不随帧率变化。
  _emitTrail(s) {
    const inp = s.input;

    // 原型用 mouse.has 标记「是否收到过第一次移动」：
    // 第一次移动只建立基准位置，不生成拖尾，避免从初始中心拉出一条长直线。
    if (!s.trailInit) {
      if (inp.x !== inp.lx || inp.y !== inp.ly) s.trailInit = true;
      return;
    }

    const dx = inp.x - inp.lx, dy = inp.y - inp.ly;
    const d = Math.hypot(dx, dy);
    if (d < CONFIG.trailMinDist) return;

    let n = Math.floor(d / CONFIG.trailMinDist);
    if (n > 8) n = 8;   // 单帧上限，避免极快移动时瞬间抽干光线池
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n;
      this._spawnTrail(s,
        inp.lx + dx * t0, inp.ly + dy * t0,
        inp.lx + dx * t1, inp.ly + dy * t1);
    }
  }

  _spawnTrail(s, x1, y1, x2, y2) {
    const r = this._allocRay(s);
    if (!r) return;
    const dx = x2 - x1, dy = y2 - y1;
    const d = Math.hypot(dx, dy);
    if (d < 0.4) { this._killRay(s, r); return; }

    r.mode = 'trail';
    r.x = x1; r.y = y1;
    r.px = x1; r.py = y1;
    r.dx = dx / d; r.dy = dy / d;
    r.speed = 25 + Math.random() * 55;
    r.grown = 0;
    r.maxLen = Math.min(d * 1.6 + 12, 150);
    r.pts.length = 0;
    r.pts.push(x1, y1);
    r.color = Math.random() < 0.45 ? '#BEE9FF' : '#FFFFFF';
    r.width = 0.8 + Math.random() * 0.9;
    r.alpha = 1;
    r.life = 0;
    r.maxLife = CONFIG.trailLifeMin + Math.random() * (CONFIG.trailLifeMax - CONFIG.trailLifeMin);
    r.bounces = 0;
    r.focusTarget = false;
    r.leak = false;

    /* 蓄力期间：拖尾光线被介质吸引（污染拖尾） */
    if (s.charging.on && s.lens.active) {
      const dd = Math.hypot(x1 - s.lens.x, y1 - s.lens.y);
      if (dd < 340) {
        let tx = s.lens.x - x1, ty = s.lens.y - y1;
        const tl = Math.hypot(tx, ty) || 1;
        r.mode = 'lens';
        r.dx = tx / tl;
        r.dy = ty / tl;
        r.speed = 220;
        r.maxLen = dd + 80;
        r.maxLife = 3;
        r.color = CONFIG.cold.incident;
        return;
      }
    }
    if (s.charging.on && s.guide.active) {
      const dd = Math.hypot(x1 - s.guide.x, y1 - s.guide.y);
      if (dd < 380) {
        r.mode = 'guide';
        r.speed = 210;
        r.maxLife = 3.2;
        r.color = CONFIG.warm.incident;
        r.bounces = 0;
        return;
      }
    }

    this._checkCrossings(s, r);
  }

  /* 光线交叉检测 —— 交叉点生成光点 */
  _checkCrossings(s, nr) {
    const x1 = nr.pts[0], y1 = nr.pts[1];
    const x2 = nr.x + nr.dx * nr.maxLen;
    const y2 = nr.y + nr.dy * nr.maxLen;
    let count = 0;
    for (let i = 0; i < s.rays.length && count < 3; i++) {
      const r = s.rays[i];
      if (!r.active || r === nr || r.mode !== 'trail') continue;
      if (Math.abs(r.x - nr.x) > 180 || Math.abs(r.y - nr.y) > 180) continue;
      const p = r.pts;
      for (let k = 0; k + 3 < p.length; k += 2) {
        const ip = segX(x1, y1, x2, y2, p[k], p[k + 1], p[k + 2], p[k + 3]);
        if (ip) {
          this._spawnMote(s, ip.x, ip.y, '#FFFFFF', 0.32, 2.6);
          count++;
          break;
        }
      }
    }
  }

  /* ============================================================
     左键 —— 折射聚焦（透镜介质）
     ============================================================ */
  _initLens(s) {
    const lens = s.lens;
    lens.active = true;
    lens.x = s.input.x;
    lens.y = s.input.y;
    lens.a = CONFIG.lensMinW / 2;
    lens.b = CONFIG.lensMinH / 2;
    lens.p = 0;
    lens.spawnT = 0;
    lens.focusDist = CONFIG.focusMinDist;
    lens.focusX = lens.x + lens.focusDist;
    lens.focusY = lens.y;
    lens.focusR = CONFIG.focusMinR;
    lens.energy = 0;
  }

  _updateLens(s, dt) {
    const lens = s.lens;
    if (!lens.active) return;
    const p = clamp(s.charging.t / CONFIG.chargeMax, 0, 1);
    lens.p = p;

    /* 跟随鼠标（带轻微滞后） */
    const k = Math.min(1, dt * 14);
    lens.x += (s.input.x - lens.x) * k;
    lens.y += (s.input.y - lens.y) * k;

    /* 呼吸脉动 */
    const breathe = 1 + CONFIG.lensBreathAmp * Math.sin(s.charging.t * Math.PI * 2 * CONFIG.lensBreathHz);
    lens.breathe = breathe;
    lens.a = (CONFIG.lensMinW / 2 + (CONFIG.lensMaxW / 2 - CONFIG.lensMinW / 2) * p) * breathe;
    lens.b = (CONFIG.lensMinH / 2 + (CONFIG.lensMaxH / 2 - CONFIG.lensMinH / 2) * p) * breathe;

    /* 焦点 */
    lens.focusDist = CONFIG.focusMinDist + (CONFIG.focusMaxDist - CONFIG.focusMinDist) * p;
    lens.focusX = lens.x + lens.focusDist;
    lens.focusY = lens.y;
    lens.focusR = CONFIG.focusMinR + (CONFIG.focusMaxR - CONFIG.focusMinR) * p;

    /* 生成射入光线：频率随蓄力增加 */
    lens.spawnT -= dt;
    if (lens.spawnT <= 0) {
      lens.spawnT = 0.20 - 0.12 * p;
      const n = 1 + ((Math.random() < 0.15 + 0.7 * p) ? 1 : 0);
      for (let i = 0; i < n; i++) this._spawnLensIncident(s);
    }
  }

  _spawnLensIncident(s) {
    const lens = s.lens;
    const r = this._allocRay(s);
    if (!r) return;
    const ang = Math.random() * Math.PI * 2;
    const dist = 150 + Math.random() * 150;
    const sx = lens.x + Math.cos(ang) * dist;
    const sy = lens.y + Math.sin(ang) * dist;
    let dx = lens.x - sx, dy = lens.y - sy;
    const dl = Math.hypot(dx, dy) || 1;
    dx /= dl; dy /= dl;

    r.mode = 'lens';
    r.x = sx; r.y = sy;
    r.px = sx; r.py = sy;
    r.dx = dx; r.dy = dy;
    r.speed = 250 + Math.random() * 90;
    r.grown = 0;
    r.maxLen = 1e6;
    r.pts.length = 0;
    r.pts.push(sx, sy);
    r.color = CONFIG.cold.incident;
    r.width = 1.2;
    r.alpha = 1;
    r.life = 0;
    r.maxLife = 4;
    r.bounces = 0;
    r.focusTarget = false;
  }

  _stepLensRay(s, r, dt) {
    const lens = s.lens;
    const step = r.speed * dt;
    r.px = r.x; r.py = r.y;
    r.x += r.dx * step;
    r.y += r.dy * step;

    if (r.focusTarget) {
      /* 已折射，飞向焦点 */
      if (r.pts.length < 2 || Math.hypot(r.x - r.pts[r.pts.length - 2], r.y - r.pts[r.pts.length - 1]) > 6) {
        r.pts.push(r.x, r.y);
      }
      const d = Math.hypot(r.x - lens.focusX, r.y - lens.focusY);
      if (d < 14) this._killRay(s, r);
      return;
    }

    if (!lens.active) {
      if (r.pts.length < 2 || Math.hypot(r.x - r.pts[r.pts.length - 2], r.y - r.pts[r.pts.length - 1]) > 6) {
        r.pts.push(r.x, r.y);
      }
      return;
    }

    const hit = segEllipse(r.px, r.py, r.x, r.y, lens.x, lens.y, lens.a, lens.b);
    if (hit) {
      this._refractAtLens(s, r, hit.x, hit.y);
      return;
    }
    if (r.pts.length < 2 || Math.hypot(r.x - r.pts[r.pts.length - 2], r.y - r.pts[r.pts.length - 1]) > 6) {
      r.pts.push(r.x, r.y);
    }
  }

  /* 在透镜边界发生折射 + 色散 + 聚焦 */
  _refractAtLens(s, r, hx, hy) {
    const lens = s.lens;

    /* 椭圆外法线 */
    let nx = (hx - lens.x) / (lens.a * lens.a);
    let ny = (hy - lens.y) / (lens.b * lens.b);
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl; ny /= nl;
    /* 法线指向入射侧 */
    if (nx * r.dx + ny * r.dy > 0) { nx = -nx; ny = -ny; }

    /* 焦点方向 */
    let fx = lens.focusX - hx, fy = lens.focusY - hy;
    const fl = Math.hypot(fx, fy) || 1;
    fx /= fl; fy /= fl;

    const mixK = 0.62;   /* 透镜聚焦引导强度 */

    for (let k = 0; k < DISPERSION_DEFS.length; k++) {
      const def = DISPERSION_DEFS[k];
      const res = snell(r.dx, r.dy, nx, ny, CONFIG.nAir, def.n);

      let rdx = res.dx, rdy = res.dy;
      if (res.tir) { rdx = r.dx; rdy = r.dy; }

      /* 向焦点方向偏折（凸透镜汇聚） */
      let fdx = rdx * (1 - mixK) + fx * mixK;
      let fdy = rdy * (1 - mixK) + fy * mixK;
      const fl2 = Math.hypot(fdx, fdy) || 1;
      fdx /= fl2; fdy /= fl2;

      const nr = this._allocRay(s);
      if (!nr) continue;
      nr.mode = 'lens';
      nr.x = hx; nr.y = hy;
      nr.px = hx; nr.py = hy;
      nr.dx = fdx; nr.dy = fdy;
      nr.speed = 320 + Math.random() * 70;
      nr.grown = 0;
      nr.maxLen = 1e6;
      nr.pts.length = 0;
      nr.pts.push(hx, hy);
      nr.color = def.color;
      nr.width = 1.15;
      nr.alpha = 1;
      nr.life = 0;
      nr.maxLife = 3;
      nr.bounces = 0;
      nr.focusTarget = true;
    }

    /* 折射光点（色散光晕） */
    this._spawnMote(s, hx, hy, CONFIG.cold.refract, 0.30, 4.2);
    this._spawnMote(s, hx, hy, '#FFFFFF', 0.22, 2.2);

    /* 折射光弧 */
    if (s.arcs.length < 90) {
      const a0 = Math.atan2(r.dy, r.dx);
      const a1 = Math.atan2(lens.focusY - hy, lens.focusX - hx);
      s.arcs.push({
        x: hx, y: hy,
        r0: 8, r1: 16,
        a0: a0, a1: a1,
        life: 0, maxLife: 0.30,
        color: CONFIG.cold.refract
      });
    }

    this._killRay(s, r);
  }

  /* ============================================================
     右键 —— 全反射（导波管）
     ============================================================ */
  _initGuide(s) {
    const guide = s.guide;
    guide.active = true;
    guide.x = s.input.x;
    guide.y = s.input.y;
    guide.gap = CONFIG.guideMinGap;
    guide.len = CONFIG.guideMinLen;
    guide.spawnT = 0;
    guide.jitter = false;
    guide.p = 0;
  }

  _updateGuide(s, dt) {
    const guide = s.guide;
    if (!guide.active) return;
    const p = clamp(s.charging.t / CONFIG.chargeMax, 0, 1);
    guide.p = p;

    const k = Math.min(1, dt * 14);
    guide.x += (s.input.x - guide.x) * k;
    guide.y += (s.input.y - guide.y) * k;

    const breathe = 1 + 0.05 * Math.sin(s.charging.t * Math.PI * 2 * 1.0);
    guide.gap = (CONFIG.guideMinGap + (CONFIG.guideMaxGap - CONFIG.guideMinGap) * p) * breathe;
    guide.len = CONFIG.guideMinLen + (CONFIG.guideMaxLen - CONFIG.guideMinLen) * p;

    guide.spawnT -= dt;
    if (guide.spawnT <= 0) {
      guide.spawnT = 0.25 - 0.10 * p;
      this._spawnGuideRay(s);
    }

    guide.jitter = s.charging.t > 1.5;
  }

  _spawnGuideRay(s) {
    const guide = s.guide;
    const r = this._allocRay(s);
    if (!r) return;
    const x1 = guide.x - guide.len / 2;
    const top = guide.y - guide.gap / 2;
    const bot = guide.y + guide.gap / 2;

    /* 从左侧射入，方向约 45° 向右下 */
    const ang = CONFIG.guideInAngle + rand(-0.03, 0.03);
    const sy = top + guide.gap * rand(0.05, 0.25);

    r.mode = 'guide';
    r.x = x1 + 2;
    r.y = sy;
    r.px = r.x; r.py = r.y;
    r.dx = Math.cos(ang);
    r.dy = Math.sin(ang);
    r.speed = 200 + Math.random() * 90;
    r.grown = 0;
    r.maxLen = 1e6;
    r.pts.length = 0;
    r.pts.push(r.x, r.y);
    r.color = CONFIG.warm.incident;
    r.width = 1.5;       // 原型漏了这一行：池中复用的旧线宽会让导波管光线忽粗忽细
    r.alpha = 1;
    r.life = 0;
    r.maxLife = 5;
    r.bounces = 0;
    r.leak = false;
  }

  _stepGuideRay(s, r, dt) {
    const guide = s.guide;
    const step = r.speed * dt;
    const ox = r.x, oy = r.y;
    r.x += r.dx * step;
    r.y += r.dy * step;

    const x1 = guide.x - guide.len / 2;
    const x2 = guide.x + guide.len / 2;
    const top = guide.y - guide.gap / 2;
    const bot = guide.y + guide.gap / 2;

    /* 出管 / 飞出屏幕 */
    if (!guide.active) {
      if (r.pts.length < 2 || Math.hypot(r.x - r.pts[r.pts.length - 2], r.y - r.pts[r.pts.length - 1]) > 6) {
        r.pts.push(r.x, r.y);
      }
      if (r.x < -200 || r.x > s.W + 200 || r.y < -200 || r.y > s.H + 200) this._killRay(s, r);
      return;
    }

    if (r.y < -400 || r.y > s.H + 400 || r.x < -400 || r.x > s.W + 400) {
      this._killRay(s, r);
      return;
    }

    /* 与上下壁的碰撞检测 */
    let hitWall = 0, wallY = 0;
    if (r.dy < 0 && r.y <= top && oy > top) { hitWall = -1; wallY = top; }
    else if (r.dy > 0 && r.y >= bot && oy < bot) { hitWall = 1; wallY = bot; }

    if (hitWall !== 0) {
      /* 求精确交点 */
      const dyTot = r.y - oy;
      const tt = Math.abs(dyTot) > 1e-6 ? (wallY - oy) / dyTot : 0;
      const hx = ox + (r.x - ox) * clamp(tt, 0, 1);
      if (hx >= x1 && hx <= x2) {
        this._handleGuideHit(s, r, hx, wallY, hitWall);
        return;
      }
    }

    if (r.pts.length < 2 || Math.hypot(r.x - r.pts[r.pts.length - 2], r.y - r.pts[r.pts.length - 1]) > 6) {
      r.pts.push(r.x, r.y);
    }
  }

  _handleGuideHit(s, r, hx, wallY, dir) {
    const guide = s.guide;

    /* 入射角抖动（蓄力 1.5s 后开始） */
    if (guide.jitter && Math.random() < 0.35) {
      const ang = (Math.random() - 0.5) * 0.14;
      const c = Math.cos(ang), sn = Math.sin(ang);
      const ndx = r.dx * c - r.dy * sn;
      const ndy = r.dx * sn + r.dy * c;
      r.dx = ndx; r.dy = ndy;
    }

    /* 入射角（与法线的夹角） */
    const angI = Math.acos(clamp(Math.abs(r.dy), 0, 1));

    if (angI >= CONFIG.criticalAngle) {
      /* 全反射 */
      r.dy = -r.dy;
      r.bounces++;
      if (r.bounces > CONFIG.maxBounces) {
        this._killRay(s, r);
        return;
      }
      /* 颜色逐渐变暖变暗 */
      const ci = Math.min(GUIDE_RAMP.length - 1, Math.floor(r.bounces * 0.9));
      r.color = GUIDE_RAMP[ci];
      r.alpha = Math.max(0.35, r.alpha * 0.93);

      /* 反射光斑 */
      this._spawnMote(s, hx, wallY, CONFIG.warm.reflect, 0.30, 3.6);
      this._spawnMote(s, hx, wallY, '#FFFFFF', 0.20, 2.0);

      /* 修正位置，防止穿透 */
      r.y = wallY + dir * 1.2;
      r.pts.push(hx, wallY);
    } else {
      /* 临界角突破 —— 泄漏 */
      r.leak = true;
      r.color = CONFIG.warm.critical;
      r.mode = 'burst';
      r.ox = hx; r.oy = wallY;
      r.grown = 0;
      r.maxLen = 260;
      r.speed = 520;
      r.life = 0;
      r.maxLife = 0.7;
      r.split = false;
      r.pts.length = 0;
      r.pts.push(hx, wallY);

      /* 管壁红色闪烁 */
      s.flashes.push({
        x: hx, y: wallY, r: 22,
        life: 0, maxLife: 0.20,
        color: CONFIG.warm.critical
      });
      this._spawnMote(s, hx, wallY, CONFIG.warm.critical, 0.35, 4);
    }
  }

  /* ============================================================
     单击 —— 发射主光线 + 散开短光线 + 棱镜闪点 + 光路重定向
     ============================================================ */
  _doLeftClick(s, cx, cy) {
    /* 主光线 */
    const ang = Math.random() * Math.PI * 2;
    const r = this._allocRay(s);
    if (r) {
      r.mode = 'burst';
      r.ox = cx; r.oy = cy;
      r.x = cx; r.y = cy;
      r.px = cx; r.py = cy;
      r.dx = Math.cos(ang); r.dy = Math.sin(ang);
      r.speed = 900;
      r.grown = 0;
      r.maxLen = 80 + Math.random() * 70;
      r.pts.length = 0;
      r.pts.push(cx, cy);
      r.color = '#FFFFFF';
      r.width = 1.6;
      r.alpha = 1;
      r.life = 0;
      r.maxLife = 0.55;
      r.split = false;
      r.bounces = 0;
      r.leak = false;      // 原型漏了这一行：池中复用的旧 leak 会把点击光线画成红色
    }

    /* 散射短光线 */
    const n = 8 + Math.floor(Math.random() * 5);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand(-0.2, 0.2);
      const sp = 300 + Math.random() * 300;
      const rr = this._allocRay(s);
      if (!rr) break;
      rr.mode = 'burst';
      rr.ox = cx; rr.oy = cy;
      rr.x = cx; rr.y = cy;
      rr.px = cx; rr.py = cy;
      rr.dx = Math.cos(a); rr.dy = Math.sin(a);
      rr.speed = sp;
      rr.grown = 0;
      rr.maxLen = 20 + Math.random() * 30;
      rr.pts.length = 0;
      rr.pts.push(cx, cy);
      rr.color = Math.random() < 0.5 ? '#FFFFFF' : CONFIG.cold.refract;
      rr.width = 1.1;
      rr.alpha = 1;
      rr.life = 0;
      rr.maxLife = 0.30;
      rr.split = false;
      rr.bounces = 0;
      rr.leak = false;     // 同上
    }

    /* 终点折射光点（色散效果） */
    const ex = cx + Math.cos(ang) * (80 + 70);
    const ey = cy + Math.sin(ang) * (80 + 70);
    this._spawnMote(s, ex, ey, CONFIG.cold.focus, 0.40, 4.5);
    this._spawnMote(s, ex, ey, CONFIG.cold.spectrum[(Math.random() * 6) | 0], 0.40, 5.5);

    /* 棱镜闪点 */
    s.flashes.push({
      x: cx, y: cy, r: 26,
      life: 0, maxLife: 0.10,
      color: '#FFFFFF',
      hex: true
    });

    /* 光路重定向 —— 临时球形介质 */
    s.redirects.push({
      x: cx, y: cy,
      r: CONFIG.redirectRadius,
      life: 0, maxLife: CONFIG.redirectDur
    });
  }

  _doRightClick(s, cx, cy) {
    /* 小型导波管快速弹射后释放 */
    const gap = 44, len = 180;
    const top = cy - gap / 2, bot = cy + gap / 2;
    const x1 = cx - len / 2, x2 = cx + len / 2;

    let px = x1 + 4, py = top + gap * 0.15;
    let dx = Math.cos(CONFIG.guideInAngle), dy = Math.sin(CONFIG.guideInAngle);

    for (let b = 0; b < 3; b++) {
      const r = this._allocRay(s);
      if (!r) break;
      r.mode = 'burst';
      r.ox = px; r.oy = py;
      r.x = px; r.y = py;
      r.px = px; r.py = py;
      r.dx = dx; r.dy = dy;
      r.speed = 460;
      r.grown = 0;
      r.maxLen = 130 + b * 30;
      r.pts.length = 0;
      r.pts.push(px, py);
      r.color = GUIDE_RAMP[Math.min(GUIDE_RAMP.length - 1, b + 1)];
      r.width = 1.3;
      r.alpha = 1;
      r.life = 0;
      r.maxLife = 0.45;
      r.split = false;
      r.bounces = 0;

      /* 计算下一次反射点 */
      const wallY = dy < 0 ? top : bot;
      const tt = Math.abs(dy) > 1e-6 ? (wallY - py) / dy : 0;
      const nx = px + dx * Math.abs(tt);
      const ny = wallY;
      if (nx > x2) {
        px = x1 + 4; py = top + gap * 0.15;
      } else {
        px = nx; py = ny;
        dy = -dy;
      }
    }

    this._spawnMote(s, cx, cy, CONFIG.warm.multi, 0.30, 4);
    s.flashes.push({
      x: cx, y: cy, r: 20,
      life: 0, maxLife: 0.10,
      color: CONFIG.warm.out,
      hex: true
    });
    s.redirects.push({
      x: cx, y: cy,
      r: CONFIG.redirectRadius,
      life: 0, maxLife: CONFIG.redirectDur
    });
  }

  /* ============================================================
     左键爆发 —— 焦点过曝 + 全方向射出 + 分裂 + 色散环 + 碎片
     ============================================================ */
  _burstLens(s, power, fx, fy) {
    s.lens.active = false;

    s.freezeT = 0.03;

    /* 焦点过曝 */
    this._after(s, 0.03, () => {
      s.flashes.push({
        x: fx, y: fy, r: CONFIG.focusBurstR,
        life: 0, maxLife: 0.12,
        color: '#FFFFFF',
        hex: true
      });
      this._spawnMote(s, fx, fy, '#FFFFFF', 0.18, 14);
    });

    this._after(s, 0.08, () => {
      /* 全方向射出光线 */
      const N = Math.round(60 + 200 * power);
      for (let i = 0; i < N; i++) {
        const ang = (i / N) * Math.PI * 2 + rand(-0.05, 0.05);
        this._spawnBurstRay(s, fx, fy, ang, power);
      }

      /* 光子风暴 */
      const M = Math.round(100 + 300 * power);
      for (let i = 0; i < M; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 200 + Math.random() * 400;
        const col = CONFIG.cold.spectrum[(Math.random() * CONFIG.cold.spectrum.length) | 0];
        this._spawnMote(s, fx, fy, col, 0.5 + Math.random() * 0.8, 1 + Math.random() * 2,
          Math.cos(a) * sp, Math.sin(a) * sp);
      }

      /* 色散环 */
      s.rings.push({
        x: fx, y: fy, r: 12,
        maxR: 150 + 400 * power,
        life: 0, maxLife: 0.6
      });

      /* 介质碎片 */
      const SC = 8 + Math.floor(Math.random() * 5);
      for (let i = 0; i < SC; i++) {
        const a = (i / SC) * Math.PI * 2 + rand(-0.3, 0.3);
        const sp = 150 + Math.random() * 350;
        s.shards.push(makeShard(fx, fy, a, sp));
      }

      /* 焦点残影 */
      this._spawnMote(s, fx, fy, CONFIG.cold.focus, 0.8, 15);

      /* 拖尾光线被卷入 —— 光路重定向 */
      s.redirects.push({
        x: fx, y: fy,
        r: CONFIG.redirectRadius * 1.2,
        life: 0, maxLife: CONFIG.redirectDur
      });
    });
  }

  _spawnBurstRay(s, x, y, ang, power) {
    const r = this._allocRay(s);
    if (!r) return;
    r.mode = 'burst';
    r.ox = x; r.oy = y;
    r.x = x; r.y = y;
    r.px = x; r.py = y;
    r.dx = Math.cos(ang); r.dy = Math.sin(ang);
    r.speed = 1500;
    r.grown = 0;
    r.maxLen = 300 + 600 * power;
    r.pts.length = 0;
    r.pts.push(x, y);
    r.color = '#FFFFFF';
    r.width = 1.6;
    r.alpha = 1;
    r.life = 0;
    r.maxLife = 1.5;
    r.split = Math.random() < CONFIG.branchChance;
    r.splitAt = r.maxLen * (0.3 + Math.random() * 0.3);
    r.didSplit = false;
    r.bounces = 0;
    r.leak = false;
  }

  /* ============================================================
     右键爆发 —— 管壁消失 + 双向射出 + 锯齿光爆
     ============================================================ */
  _burstGuide(s, power) {
    const guide = s.guide;
    const gx = guide.x, gy = guide.y;
    const gGap = guide.gap, gLen = guide.len;

    /* 收集管内光线 */
    const inner = [];
    for (let i = 0; i < s.rays.length; i++) {
      const r = s.rays[i];
      if (r.active && r.mode === 'guide') inner.push(r);
    }

    guide.active = false;
    s.freezeT = 0.03;

    /* 管壁残影 */
    s.wallGhosts.push({
      x: gx, y: gy, gap: gGap, len: gLen,
      life: 0, maxLife: 0.5
    });

    this._after(s, 0.05, () => {
      /* 管内光线双向射出 */
      for (let i = 0; i < inner.length; i++) {
        const r = inner[i];
        if (!r.active) continue;
        const sp = 400 + 1200 * power;
        r.mode = 'burst';
        r.ox = r.x; r.oy = r.y;
        r.grown = 0;
        r.maxLen = 420 + 900 * power;
        r.speed = sp;
        r.life = 0;
        r.maxLife = 1.5;
        r.split = false;
        r.width = 1.8;
        r.alpha = 1;
        r.color = CONFIG.warm.out;
      }

      /* 锯齿光爆环 */
      const segs = [];
      const segCount = 40 + Math.floor(40 * power);
      for (let i = 0; i < segCount; i++) {
        segs.push({
          a: Math.random() * Math.PI * 2,
          len: 8 + Math.random() * 18,
          off: Math.random() * 30
        });
      }
      s.sawRings.push({
        x: gx, y: gy, r: 12,
        maxR: 150 + 400 * power,
        life: 0, maxLife: 0.5,
        segs: segs
      });

      /* 光子风暴 */
      const M = Math.round(80 + 250 * power);
      for (let i = 0; i < M; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 200 + Math.random() * 400;
        const col = CONFIG.warm.spectrum[(Math.random() * CONFIG.warm.spectrum.length) | 0];
        this._spawnMote(s, gx, gy, col, 0.5 + Math.random() * 0.8, 1 + Math.random() * 2,
          Math.cos(a) * sp, Math.sin(a) * sp);
      }

      /* 临界闪光（原型此处读 charging.t，但 _endCharge 已把它清零，
         实际只有 power > 0.72 会命中；两者阈值仅差 0.03s，按原样保留） */
      if (s.charging.t > 2.0 || power > 0.72) {
        s.flashes.push({
          x: gx, y: gy, r: 20,
          life: 0, maxLife: 0.15,
          color: CONFIG.warm.critical,
          hex: true
        });
      }

      /* 拖尾光线被卷入 */
      s.redirects.push({
        x: gx, y: gy,
        r: CONFIG.redirectRadius * 1.2,
        life: 0, maxLife: CONFIG.redirectDur
      });
    });
  }

  /* ============================================================
     光线步进
     ============================================================ */
  _stepRays(s, dt) {
    for (let i = 0; i < s.rays.length; i++) {
      const r = s.rays[i];
      if (!r.active) continue;

      r.life += dt;
      if (r.life >= r.maxLife) { this._killRay(s, r); continue; }

      switch (r.mode) {
        case 'trail': this._stepTrail(r, dt); break;
        case 'burst': this._stepBurst(s, r, dt); break;
        case 'lens': this._stepLensRay(s, r, dt); break;
        case 'guide': this._stepGuideRay(s, r, dt); break;
      }
    }
  }

  _stepTrail(r, dt) {
    if (r.grown >= r.maxLen) return;
    let step = r.speed * dt;
    if (r.grown + step > r.maxLen) step = r.maxLen - r.grown;
    r.x += r.dx * step;
    r.y += r.dy * step;
    r.grown += step;
    const p = r.pts;
    if (p.length < 2 || Math.hypot(r.x - p[p.length - 2], r.y - p[p.length - 1]) > 4) {
      p.push(r.x, r.y);
      if (p.length > 120) p.splice(0, 60);
    }
  }

  _stepBurst(s, r, dt) {
    if (r.grown >= r.maxLen) return;
    r.speed *= Math.pow(0.30, dt);
    let step = r.speed * dt;
    if (r.grown + step > r.maxLen) step = r.maxLen - r.grown;
    r.x += r.dx * step;
    r.y += r.dy * step;
    r.grown += step;

    /* 光线分裂 */
    if (r.split && !r.didSplit && r.grown > r.splitAt) {
      r.didSplit = true;
      const cnt = CONFIG.branchMin + Math.floor(Math.random() * (CONFIG.branchMax - CONFIG.branchMin + 1));
      for (let i = 0; i < cnt; i++) {
        const a = Math.atan2(r.dy, r.dx) + rand(-0.28, 0.28);
        const nr = this._allocRay(s);
        if (!nr) break;
        nr.mode = 'burst';
        nr.ox = r.x; nr.oy = r.y;
        nr.x = r.x; nr.y = r.y;
        nr.px = r.x; nr.py = r.y;
        nr.dx = Math.cos(a); nr.dy = Math.sin(a);
        nr.speed = r.speed * 0.85;
        nr.grown = 0;
        nr.maxLen = (r.maxLen - r.grown) * (0.5 + Math.random() * 0.5);
        nr.pts.length = 0;
        nr.pts.push(r.x, r.y);
        nr.color = r.leak ? CONFIG.warm.critical : '#FFFFFF';
        nr.width = 1.2;
        nr.alpha = 1;
        nr.life = r.life;
        nr.maxLife = r.maxLife;
        nr.split = false;
        nr.bounces = 0;
        nr.leak = r.leak;
      }
    }

    const p = r.pts;
    if (p.length < 2 || Math.hypot(r.x - p[p.length - 2], r.y - p[p.length - 1]) > 5) {
      p.push(r.x, r.y);
      if (p.length > 200) p.splice(0, 100);
    }

    if (r.x < -300 || r.x > s.W + 300 || r.y < -300 || r.y > s.H + 300) {
      this._killRay(s, r);
    }
  }

  /* ============================================================
     光路重定向 —— 临时球形介质使光线偏折
     ============================================================ */
  _stepRedirects(s, dt) {
    for (let i = s.redirects.length - 1; i >= 0; i--) {
      const d = s.redirects[i];
      d.life += dt;
      if (d.life >= d.maxLife) {
        s.redirects.splice(i, 1);
        continue;
      }

      const influence = CONFIG.redirectInfluence;
      for (let k = 0; k < s.rays.length; k++) {
        const r = s.rays[k];
        if (!r.active || r.mode !== 'trail') continue;
        const dist = Math.hypot(r.x - d.x, r.y - d.y);
        if (dist > influence) continue;

        let tx = d.x - r.x, ty = d.y - r.y;
        const tl = Math.hypot(tx, ty) || 1;
        tx /= tl; ty /= tl;

        const falloff = 1 - dist / influence;
        const m = CONFIG.redirectBend * falloff * (1 - d.life / d.maxLife);
        if (m <= 0.001) continue;

        /* 只有当光线朝着介质方向运动时才偏折（穿过介质） */
        const facing = r.dx * tx + r.dy * ty;
        if (facing < -0.2) continue;

        let ndx = r.dx * (1 - m) + tx * m;
        let ndy = r.dy * (1 - m) + ty * m;
        const nl = Math.hypot(ndx, ndy) || 1;
        r.dx = ndx / nl;
        r.dy = ndy / nl;
        r.maxLen = Math.max(r.maxLen, r.grown + 60);

        /* 折射光弧 */
        if (Math.random() < 0.12 && s.arcs.length < 90) {
          s.arcs.push({
            x: r.x, y: r.y,
            r0: 6, r1: 14,
            a0: Math.atan2(r.dy, r.dx),
            a1: Math.atan2(ty, tx),
            life: 0, maxLife: 0.28,
            color: CONFIG.cold.refract
          });
        }
      }
    }
  }

  /* ============================================================
     特效步进
     ============================================================ */
  _stepEffects(s, dt) {
    /* 色散环 */
    for (let i = s.rings.length - 1; i >= 0; i--) {
      const g = s.rings[i];
      g.life += dt;
      const t = g.life / g.maxLife;
      g.r = 12 + (g.maxR - 12) * (1 - Math.pow(1 - t, 2));
      if (t >= 1) s.rings.splice(i, 1);
    }

    /* 锯齿光爆 */
    for (let i = s.sawRings.length - 1; i >= 0; i--) {
      const g = s.sawRings[i];
      g.life += dt;
      const t = g.life / g.maxLife;
      g.r = 12 + (g.maxR - 12) * (1 - Math.pow(1 - t, 2));
      if (t >= 1) s.sawRings.splice(i, 1);
    }

    /* 介质碎片 */
    for (let i = s.shards.length - 1; i >= 0; i--) {
      const sh = s.shards[i];
      sh.life += dt;
      if (sh.life >= sh.maxLife) { s.shards.splice(i, 1); continue; }
      sh.x += sh.vx * dt;
      sh.y += sh.vy * dt;
      const damp = Math.pow(0.25, dt);
      sh.vx *= damp; sh.vy *= damp;
      sh.rot += sh.vrot * dt;
    }

    /* 折射光弧 */
    for (let i = s.arcs.length - 1; i >= 0; i--) {
      const a = s.arcs[i];
      a.life += dt;
      if (a.life >= a.maxLife) s.arcs.splice(i, 1);
    }

    /* 闪光 */
    for (let i = s.flashes.length - 1; i >= 0; i--) {
      const f = s.flashes[i];
      f.life += dt;
      if (f.life >= f.maxLife) s.flashes.splice(i, 1);
    }

    /* 管壁残影 */
    for (let i = s.wallGhosts.length - 1; i >= 0; i--) {
      const g = s.wallGhosts[i];
      g.life += dt;
      if (g.life >= g.maxLife) s.wallGhosts.splice(i, 1);
    }
  }

  /* ============================================================
     渲染 —— 光线
     ============================================================ */
  _drawRays(s) {
    const ctx = s.ctx;
    for (let i = 0; i < s.rays.length; i++) {
      const r = s.rays[i];
      if (!r.active) continue;
      const a = r.alpha * (1 - r.life / r.maxLife);
      if (a <= 0.012) continue;

      if (r.mode === 'burst') { this._drawBurstRay(s, r, a); continue; }

      const p = r.pts;
      if (p.length < 4) continue;

      /* 外层辉光 */
      ctx.globalAlpha = a * 0.26;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.width * 5.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      for (let k = 2; k < p.length; k += 2) ctx.lineTo(p[k], p[k + 1]);
      ctx.stroke();

      /* 内层纯色 */
      ctx.globalAlpha = a * 0.95;
      ctx.lineWidth = r.width;
      ctx.stroke();

      /* 点阵光子（沿路径均匀分布的亮点） */
      let total = 0;
      const segLens = [];
      for (let k = 0; k + 3 < p.length; k += 2) {
        const L = Math.hypot(p[k + 2] - p[k], p[k + 3] - p[k + 1]);
        segLens.push(L);
        total += L;
      }
      if (total > 16 && segLens.length > 0) {
        const n = Math.min(CONFIG.rayMaxDots, Math.floor(total / 16));
        if (n > 0) {
          const sp = getSprite(s, '#FFFFFF', 8, true);
          ctx.globalAlpha = a * 0.75;
          let acc = 0, si = 0;
          for (let j = 1; j <= n; j++) {
            const target = total * (j / (n + 1));
            while (si < segLens.length - 1 && acc + segLens[si] < target) {
              acc += segLens[si];
              si++;
            }
            const segL = segLens[si] || 1;
            const tt = clamp((target - acc) / segL, 0, 1);
            const sx = p[si * 2] + (p[si * 2 + 2] - p[si * 2]) * tt;
            const sy = p[si * 2 + 1] + (p[si * 2 + 3] - p[si * 2 + 1]) * tt;
            ctx.drawImage(sp, sx - 2.6, sy - 2.6, 5.2, 5.2);
          }
        }
      }
    }
  }

  /* 爆发光线：白 → 青 → 紫 沿长度渐变 */
  _drawBurstRay(s, r, a) {
    const ctx = s.ctx;
    const L = r.grown;
    if (L < 1) return;

    ctx.lineCap = 'round';

    /* 外层辉光 */
    ctx.globalAlpha = a * 0.22;
    ctx.strokeStyle = r.leak ? CONFIG.warm.critical : '#4FE3FF';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(r.ox, r.oy);
    ctx.lineTo(r.ox + r.dx * L, r.oy + r.dy * L);
    ctx.stroke();

    /* 内层：三段颜色渐变 */
    const cols = r.leak
      ? [CONFIG.warm.critical, CONFIG.warm.critical, CONFIG.warm.critical]
      : ['#FFFFFF', '#4FE3FF', '#9B5CFF'];

    ctx.lineWidth = 1.6;
    for (let k = 0; k < 3; k++) {
      const t0 = k / 3, t1 = (k + 1) / 3;
      const x1 = r.ox + r.dx * L * t0, y1 = r.oy + r.dy * L * t0;
      const x2 = r.ox + r.dx * L * t1, y2 = r.oy + r.dy * L * t1;
      ctx.globalAlpha = a * (0.95 - k * 0.22);
      ctx.strokeStyle = cols[k];
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  }

  /* ============================================================
     渲染 —— 介质（透镜 / 导波管）
     ============================================================ */
  _drawMedia(s) {
    const ctx = s.ctx;
    const lens = s.lens;
    const guide = s.guide;

    /* ---- 导波管 ---- */
    if (guide.active) {
      const gx = guide.x + s.shakeX, gy = guide.y + s.shakeY;
      const top = gy - guide.gap / 2;
      const bot = gy + guide.gap / 2;
      const x1 = gx - guide.len / 2;
      const x2 = gx + guide.len / 2;
      const p = guide.p;

      /* 管内外辉光 */
      const grd = ctx.createLinearGradient(0, top, 0, bot);
      grd.addColorStop(0, 'rgba(255,140,26,0.05)');
      grd.addColorStop(0.5, 'rgba(255,180,60,' + (0.05 + 0.10 * p) + ')');
      grd.addColorStop(1, 'rgba(255,140,26,0.05)');
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 1;
      ctx.fillStyle = grd;
      ctx.fillRect(x1, top, x2 - x1, guide.gap);

      /* 导波介质区域 */
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 0.10 + 0.12 * p;
      ctx.fillStyle = 'rgb(42,26,10)';
      ctx.fillRect(x1, top, x2 - x1, guide.gap);

      /* 两条壁 */
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.45 + 0.35 * p;
      ctx.strokeStyle = CONFIG.warm.wall;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x1, top); ctx.lineTo(x2, top);
      ctx.moveTo(x1, bot); ctx.lineTo(x2, bot);
      ctx.stroke();

      /* 壁面反射标记（每 20px 一个小刻度） */
      ctx.globalAlpha = 0.28 + 0.25 * p;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = x1; x <= x2; x += 20) {
        ctx.moveTo(x, top);
        ctx.lineTo(x, top + 5);
        ctx.moveTo(x, bot);
        ctx.lineTo(x, bot - 5);
      }
      ctx.stroke();
    }

    /* ---- 导波管残影 ---- */
    for (let i = 0; i < s.wallGhosts.length; i++) {
      const g = s.wallGhosts[i];
      const t = 1 - g.life / g.maxLife;
      const gx = g.x, gy = g.y;
      const top = gy - g.gap / 2;
      const bot = gy + g.gap / 2;
      /* 长度从两端向中间缩短 */
      const shrink = 1 - t;
      const x1 = gx - g.len / 2 * shrink;
      const x2 = gx + g.len / 2 * shrink;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.22 * t;
      ctx.strokeStyle = CONFIG.warm.wall;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x1, top); ctx.lineTo(x2, top);
      ctx.moveTo(x1, bot); ctx.lineTo(x2, bot);
      ctx.stroke();
    }

    /* ---- 透镜介质 ---- */
    if (lens.active) {
      const x = lens.x + s.shakeX, y = lens.y + s.shakeY;
      const a = lens.a, b = lens.b;

      /* 介质填充 */
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 0.10 + 0.15 * lens.p;
      ctx.fillStyle = 'rgb(26,42,74)';
      ctx.beginPath();
      ctx.ellipse(x, y, a, b, 0, 0, Math.PI * 2);
      ctx.fill();

      /* 介质边界 */
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.5 + 0.4 * lens.p;
      ctx.strokeStyle = CONFIG.cold.boundary;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(x, y, a, b, 0, 0, Math.PI * 2);
      ctx.stroke();

      /* 边界上的法线标记 */
      ctx.globalAlpha = 0.30 + 0.25 * lens.p;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const marks = 18;
      for (let i = 0; i < marks; i++) {
        const t = (i / marks) * Math.PI * 2;
        const px = x + Math.cos(t) * a;
        const py = y + Math.sin(t) * b;
        let nx = Math.cos(t) / a;
        let ny = Math.sin(t) / b;
        const nl = Math.hypot(nx, ny) || 1;
        nx /= nl; ny /= nl;
        ctx.moveTo(px, py);
        ctx.lineTo(px + nx * 7, py + ny * 7);
      }
      ctx.stroke();

      /* 焦点光点 + 品红光环 */
      const fx = lens.focusX + s.shakeX;
      const fy = lens.focusY + s.shakeY;
      const pulse = 0.9 + 0.1 * Math.sin(s.T * (1 + lens.p * 3) * 10);
      const fr = lens.focusR * pulse;

      const halo = getSprite(s, '#FF4FD8', 40, true);
      ctx.globalAlpha = 0.35 + 0.45 * lens.p;
      const hs = 90 + 60 * lens.p;
      ctx.drawImage(halo, fx - hs / 2, fy - hs / 2, hs, hs);

      const core = getSprite(s, '#FFFFFF', 16, true);
      ctx.globalAlpha = 0.7 + 0.3 * lens.p;
      const cs = fr * 6;
      ctx.drawImage(core, fx - cs / 2, fy - cs / 2, cs, cs);
    }

    /* ---- 临时球形介质（光路重定向） ---- */
    for (let i = 0; i < s.redirects.length; i++) {
      const d = s.redirects[i];
      const t = 1 - d.life / d.maxLife;
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 0.14 * t;
      ctx.fillStyle = 'rgb(26,42,74)';
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.5 * t;
      ctx.strokeStyle = CONFIG.cold.refract;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.stroke();
    }

    /* ---- 介质碎片 ---- */
    for (let i = 0; i < s.shards.length; i++) {
      const sh = s.shards[i];
      const t = 1 - sh.life / sh.maxLife;
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 0.20 * t;
      ctx.fillStyle = 'rgb(26,42,74)';
      ctx.beginPath();
      for (let k = 0; k < sh.pts.length; k += 2) {
        const px = sh.x + (sh.pts[k] * Math.cos(sh.rot) - sh.pts[k + 1] * Math.sin(sh.rot)) * sh.size;
        const py = sh.y + (sh.pts[k] * Math.sin(sh.rot) + sh.pts[k + 1] * Math.cos(sh.rot)) * sh.size;
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();

      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.55 * t;
      ctx.strokeStyle = CONFIG.cold.refract;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  /* ============================================================
     渲染 —— 特效（色散环 / 锯齿光爆 / 光弧 / 闪光）
     ============================================================ */
  _drawEffects(s) {
    const ctx = s.ctx;

    /* 色散环 —— 由多条光谱弧组成 */
    const SPECTRUM = ['#FF3D3D', '#FF8C1A', '#FFD24A', '#3DFF7A', '#4FE3FF', '#9B5CFF'];
    for (let i = 0; i < s.rings.length; i++) {
      const g = s.rings[i];
      const t = 1 - g.life / g.maxLife;
      if (t <= 0) continue;
      ctx.lineWidth = 2;
      for (let k = 0; k < SPECTRUM.length; k++) {
        const base = (k / SPECTRUM.length) * Math.PI * 2;
        const span = (Math.PI * 2 / SPECTRUM.length) * 0.72;
        ctx.globalAlpha = 0.55 * t;
        ctx.strokeStyle = SPECTRUM[k];
        ctx.beginPath();
        ctx.arc(g.x, g.y, g.r + k * 1.6, base, base + span);
        ctx.stroke();
      }
    }

    /* 锯齿光爆环 */
    for (let i = 0; i < s.sawRings.length; i++) {
      const g = s.sawRings[i];
      const t = 1 - g.life / g.maxLife;
      if (t <= 0) continue;
      ctx.globalAlpha = 0.7 * t;
      ctx.strokeStyle = CONFIG.warm.multi;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let k = 0; k < g.segs.length; k++) {
        const sg = g.segs[k];
        const r = g.r + sg.off;
        const x1 = g.x + Math.cos(sg.a) * r;
        const y1 = g.y + Math.sin(sg.a) * r;
        const x2 = g.x + Math.cos(sg.a) * (r + sg.len);
        const y2 = g.y + Math.sin(sg.a) * (r + sg.len);
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      }
      ctx.stroke();
    }

    /* 折射光弧 */
    for (let i = 0; i < s.arcs.length; i++) {
      const a = s.arcs[i];
      const t = 1 - a.life / a.maxLife;
      if (t <= 0) continue;
      let d = a.a1 - a.a0;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      ctx.globalAlpha = 0.7 * t;
      ctx.strokeStyle = a.color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.r0 + (a.r1 - a.r0) * (1 - t), a.a0, a.a0 + d * (1 - t * 0.4), d < 0);
      ctx.stroke();
    }

    /* 闪光（棱镜闪点 / 焦点过曝 / 临界闪光） */
    for (let i = 0; i < s.flashes.length; i++) {
      const f = s.flashes[i];
      const t = 1 - f.life / f.maxLife;
      if (t <= 0) continue;
      if (f.hex) {
        /* 六边形棱镜闪光 */
        ctx.globalAlpha = 0.85 * t;
        ctx.strokeStyle = f.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2 - Math.PI / 2;
          const px = f.x + Math.cos(a) * f.r * (0.6 + 0.4 * t);
          const py = f.y + Math.sin(a) * f.r * (0.6 + 0.4 * t);
          if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
      }
      const sp = getSprite(s, f.color, 24, true);
      ctx.globalAlpha = 0.75 * t;
      const sz = f.r * 3;
      ctx.drawImage(sp, f.x - sz / 2, f.y - sz / 2, sz, sz);
    }
  }

  /* ============================================================
     尺寸 —— 只同步动效自己的 W / H，画布尺寸与 DPR 由基类维护
     ============================================================ */
  onResize(width, height) {
    const s = this.state;
    if (!s) return;
    s.W = width;
    s.H = height;
  }

  /* ============================================================
     主更新
     ============================================================ */
  update(dt, s) {
    if (!s) return;

    s.T += dt;

    // 拖尾生成放在冻结帧判定之前：原型里它发生在 mousemove 事件中，
    // 与 update() 的冻结逻辑无关。
    this._emitTrail(s);

    /* 冻结帧（松开瞬间所有光线凝固一帧） */
    if (s.freezeT > 0) {
      s.freezeT -= dt;
      return;
    }

    this._stepTimers(s, dt);
    this._stepRedirects(s, dt);
    this._stepRays(s, dt);
    this._stepMotes(s, dt);
    this._stepEffects(s, dt);

    /* 蓄力 */
    if (s.charging.on) {
      s.charging.t += dt;
      const p = clamp(s.charging.t / CONFIG.chargeMax, 0, 1);

      /* 微震 */
      if (p > CONFIG.microShakeStart) {
        const k = (p - CONFIG.microShakeStart) / (1 - CONFIG.microShakeStart);
        const amp = CONFIG.microShakeAmp * k;
        s.shakeX = (Math.random() - 0.5) * amp * 2;
        s.shakeY = (Math.random() - 0.5) * amp * 2;
      } else {
        s.shakeX = 0; s.shakeY = 0;
      }

      if (s.charging.btn === 0) this._updateLens(s, dt);
      else this._updateGuide(s, dt);
    } else {
      s.shakeX *= Math.pow(0.001, dt);
      s.shakeY *= Math.pow(0.001, dt);
      if (Math.abs(s.shakeX) < 0.05) s.shakeX = 0;
      if (Math.abs(s.shakeY) < 0.05) s.shakeY = 0;
    }
  }

  /* ============================================================
     渲染
     ============================================================ */
  render(s) {
    if (!s) return;
    const ctx = s.ctx;

    // 清屏：原型在这里就是 clearRect（透明光标层，没有任何整屏铺底）。
    // 画布缓冲与 DPR 缩放由基类维护，这里统一使用 CSS 像素坐标。
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, s.W, s.H);

    this._drawMedia(s);

    ctx.globalCompositeOperation = 'lighter';
    this._drawRays(s);
    this._drawMotes(s);
    this._drawEffects(s);

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }
}

if (!customElements.get('cursor-refract')) {
  customElements.define('cursor-refract', CursorRefract);
}

export default CursorRefract;
