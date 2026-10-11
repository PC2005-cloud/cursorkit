/**
 * cursor-sun —— 鼠标光标太阳动效（左键核聚变 / 右键日珥）。
 *
 * 由 html/太阳.html 原型移植：算法流程、数值、视觉表现与原文件一一对应。
 * 作为光标层组件，原型页面自身的行为已剔除：
 *   - 原型用不透明上下文（{ alpha: false }）并在每帧铺一层 #000 底色来承载整页背景；
 *     移植后基类的 canvas 是透明的，render() 改为 clearRect，绝不覆盖宿主页面；
 *   - 不拦截 contextmenu，宿主页面的右键菜单不受影响；
 *   - 画布创建、DPR 适配、尺寸同步、监听注册、rAF 循环、鼠标速度平滑
 *     以及「>300px 跳变归零 / 6000 封顶」全部由基类负责。
 *
 * 原型监听 mousemove / mousedown / mouseup，因此声明 inputFamily = 'mouse'。
 * 所有运行状态都放在 setup() 返回的 state 上，多实例互不干扰。
 */

import { CursorEffectElement } from '../core/base.js';
import { TAU, clamp, lerp, rand } from '../core/utils.js';

/* ==================================================================
   CONFIG —— 顶部集中配置
   ================================================================== */
const CONFIG = {
  // 全局
  MAX_PARTICLES: 2400,      // 粒子池上限
  MAX_ARCS: 60,             // 日珥拱环池上限
  DPR_CAP: 2,               // devicePixelRatio 上限

  // ---- 左键：核聚变 ----
  FUSION: {
    chargeTime: 2.5,        // 蓄力总时长(s)
    sunMinR: 20,            // 初始太阳半径
    sunMaxR: 150,           // 蓄满太阳半径
    coreMinR: 6,            // 核心最小半径
    coreMaxR: 30,           // 核心最大半径
    corePulseHz: 5,         // 核心脉动频率(Hz)
    granuleMin: 20,         // 米粒最少数量
    granuleMax: 120,        // 米粒最多数量
    granuleRMin: 4,         // 米粒半径范围
    granuleRMax: 12,
    granuleLifeMin: 2,      // 米粒寿命范围(s)
    granuleLifeMax: 5,
    granulePeriodMin: 1,    // 米粒亮度循环周期(s)
    granulePeriodMax: 3,
    convSpeedMin: 20,       // 对流上升速度(px/s)
    convSpeedMax: 50,
    sunspotStart: 1.2,      // 黑子出现时间(s)
    sunspotRMin: 10,        // 黑子半径范围
    sunspotRMax: 40,
    smallArcStart: 1.5,     // 小日珥拱环出现时间(s)
    precursorStart: 2.0,    // 耀斑前兆时间(s)
    shakeStart: 0.55,       // 微震起始比例
    flareBase: 100,         // 耀斑粒子基础数量
    flarePower: 300,        // 耀斑粒子随 power 增量
    flareSpeedBase: 600,    // 耀斑粒子基础速度
    flareSpeedPower: 1500,
    cmeBase: 200,           // 日冕物质抛射粒子基础数量
    cmePower: 400,
    cmeSpeedBase: 400,
    cmeSpeedPower: 1000,
    waveMaxRBase: 200,      // 辐射波最大半径
    waveMaxRPower: 500
  },

  // ---- 右键：日珥 ----
  PROM: {
    chargeTime: 2.5,
    sunR: 35,               // 日珥模式固定太阳半径
    arcStart: 0.3,          // 第一条拱环出现时间(s)
    arcMin: 1,              // 拱环最少数量
    arcMax: 12,             // 拱环最多数量
    arcHeightMin: 80,       // 拱环高度范围(px)
    arcHeightMax: 300,
    arcPartsMin: 15,        // 每条拱环粒子数范围
    arcPartsMax: 30,
    arcFlowMin: 100,        // 拱环流动速度(px/s)
    arcFlowMax: 200,
    magLines: 3,            // 每条拱环磁场线数量
    driftSpeed: 5,          // 足点漂移速度(px/s)
    reconnectBase: 500,     // 重联抛出基础速度
    reconnectPower: 1200,
    windBase: 100,          // 等离子体风粒子数
    windPower: 250,
    windSpeedBase: 200,
    windSpeedPower: 500
  },

  // ---- 鼠标拖尾 ----
  TRAIL: {
    spacing: 9,             // 每多少像素生成一个光球粒子
    speedMin: 50,           // 辐射扩散速度
    speedMax: 150,
    lifeMin: 0.8,
    lifeMax: 1.5,
    gravity: 30             // 轻微重力(px/s²)
  },

  // ---- 磁力线编织 ----
  WEAVE: {
    lineCount: 6,           // 临时磁场线数量
    lenMin: 200,
    lenMax: 300,
    radius: 250,            // 捕获半径
    captureTime: 0.2,       // 吸附时间(s)
    flowTime: 0.3,          // 沿磁场线流动时间(s)
    residualLife: 0.4,      // 磁场线残留寿命(s)
    residualCount: 8        // 残留数量
  },

  // ---- 配色 ----
  COLOR: {
    // 左键：恒星温度色阶
    fusion: {
      core:     '#FFFFFF',   // 核心白热
      inner:    '#FFF8E0',   // 内层金白
      gold:     '#FFD24A',   // 中层金黄
      orange:   '#FF8C1A',   // 外层橙
      red:      '#FF3D3D',   // 最外红
      spotCore: '#4A1A0A',   // 黑子深棕黑
      spotPen:  '#8A4A1A',   // 半影暗棕
      halo:     '#FFE8B0'    // 辐射光晕
    },
    // 右键：等离子体 + 磁场色
    prom: {
      core:      '#FFFFFF',  // 日珥内芯白热
      magenta:   '#FF2E9E',  // 日珥主体品红
      purple:    '#9B5CFF',  // 日珥外层紫
      field:     '#4FE3FF',  // 磁场线青
      foot:      '#FFD24A',  // 日珥足点金
      reconnect: '#FFFFFF',  // 磁场重联闪白
      corona:    '#A8E8FF'   // 日冕淡青
    }
  }
};

/* ==================================================================
   工具函数（纯函数，无实例状态）
   ================================================================== */
function bezPoint(x0, y0, cx, cy, x1, y1, t) {
  const mt = 1 - t;
  const a = mt * mt, b = 2 * mt * t, c = t * t;
  return { x: a * x0 + b * cx + c * x1, y: a * y0 + b * cy + c * y1 };
}
function bezTan(x0, y0, cx, cy, x1, y1, t) {
  const mt = 1 - t;
  let tx = 2 * mt * (cx - x0) + 2 * t * (x1 - cx);
  let ty = 2 * mt * (cy - y0) + 2 * t * (y1 - cy);
  const l = Math.hypot(tx, ty) || 1;
  return { x: tx / l, y: ty / l };
}
function rgba(r, g, b, a) { return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')'; }

/* ==================================================================
   离屏纹理预渲染
   ================================================================== */
// 原型在第 180 行附近用全局 document 的 createElement 预渲染辉光贴图。
// 移植后改用元素自身的 ownerDocument 创建：不触碰任何全局对象，
// 每个实例各自持有一份，且绝不挂进 DOM。
// 这里的 c.width / c.height / getContext 都只作用于离屏贴图画布，与主画布无关。
function makeGlow(doc, rgb, size) {
  const c = doc.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gr.addColorStop(0.00, 'rgba(' + rgb + ',1)');
  gr.addColorStop(0.16, 'rgba(' + rgb + ',0.78)');
  gr.addColorStop(0.40, 'rgba(' + rgb + ',0.30)');
  gr.addColorStop(0.70, 'rgba(' + rgb + ',0.07)');
  gr.addColorStop(1.00, 'rgba(' + rgb + ',0)');
  g.fillStyle = gr;
  // 贴图自身的整块填充：它落在离屏画布上，不是视口铺底，必须保留
  g.fillRect(0, 0, size, size);
  return c;
}
function buildTextures(doc) {
  const S = 64;
  return {
    white:   makeGlow(doc, '255,255,255', S),
    warm:    makeGlow(doc, '255,232,176', S),
    gold:    makeGlow(doc, '255,210,74',  S),
    orange:  makeGlow(doc, '255,140,26',  S),
    red:     makeGlow(doc, '255,61,61',   S),
    cyan:    makeGlow(doc, '79,227,255',  S),
    magenta: makeGlow(doc, '255,46,158',  S),
    purple:  makeGlow(doc, '155,92,255',  S),
    pale:    makeGlow(doc, '168,232,255', S)
  };
}

/* ==================================================================
   米粒组织调色板（16 级亮度）
   ================================================================== */
const GRAN_INNER = [];
const GRAN_OUTER = [];
(function buildGranulePalette() {
  const iA = [255, 140, 26], iB = [255, 255, 255];   // 暗 → 亮
  const oA = [74, 26, 10],   oB = [255, 140, 26];
  for (let i = 0; i < 16; i++) {
    const t = i / 15;
    GRAN_INNER.push('rgb(' +
      Math.round(lerp(iA[0], iB[0], t)) + ',' +
      Math.round(lerp(iA[1], iB[1], t)) + ',' +
      Math.round(lerp(iA[2], iB[2], t)) + ')');
    GRAN_OUTER.push('rgb(' +
      Math.round(lerp(oA[0], oB[0], t)) + ',' +
      Math.round(lerp(oA[1], oB[1], t)) + ',' +
      Math.round(lerp(oA[2], oB[2], t)) + ')');
  }
})();

export class CursorSun extends CursorEffectElement {
  // 原型用的是 mousemove / mousedown / mouseup（不是 pointer 事件族），
  // 不声明这一行，基类会去监听 pointermove，动效将完全收不到鼠标输入。
  inputFamily = 'mouse';

  /* ==================================================================
     初始化
     ================================================================== */
  // 只建池与状态，不注册任何监听（监听、DPR 缩放、rAF 全归基类）
  setup({ canvas, ctx, width, height, input }) {
    // 与原型一致：初始光标位置取视口中心。
    // 基类的 input 从 (0, 0) 起算，若不在这里对齐，首帧的位移会按「从左上角跳过来」计算，
    // 速度与拖尾生成量会和原型不同。
    input.x = input.lx = width * 0.5;
    input.y = input.ly = height * 0.5;

    // ---- 粒子池 ----
    const particles = [];
    const freeList = [];
    for (let i = 0; i < CONFIG.MAX_PARTICLES; i++) {
      particles.push({
        _i: i,
        active: false,
        type: '',
        x: 0, y: 0, vx: 0, vy: 0,
        px: 0, py: 0,
        r: 2,
        life: 0, maxLife: 1,
        drag: 0,
        grav: 0,
        trail: 0,
        tex: null,
        alpha: 1,
        timer: 0,
        // 磁场编织
        captured: false,
        tvt: 0,
        capX: 0, capY: 0,
        tx: 0, ty: 0,
        lineIdx: -1,
        lineT: 0.5,
        svx: 0, svy: 0,
        // 通用槽位
        a: 0, b: 0, c: 0, d: 0
      });
      freeList.push(i);
    }

    // ---- 拱环池 ----
    const arcPool = [];
    for (let i = 0; i < CONFIG.MAX_ARCS; i++) {
      arcPool.push({
        active: false,
        a0: 0, a1: 0,
        h: 80,
        phase: 0,
        flow: 0,
        parts: [],
        magCount: 2,
        born: 0,
        drift: 0,
        driftDir: 1,
        small: false,
        unstable: 0
      });
    }

    return {
      // 本实例的画布上下文（已按 DPR 缩放过，统一使用 CSS 像素坐标）
      ctx,

      // 画布尺寸（CSS 像素），由基类 onResize 同步
      W: width,
      H: height,

      input,

      // 离屏辉光贴图（每个实例一份）
      tex: buildTextures(canvas.ownerDocument),

      // 粒子池 + 空闲索引表
      particles,
      freeList,

      // 拱环池
      arcPool,

      // 全局时间（原型的 T）
      T: 0,

      // 原型用 trailInit 标记「是否已经收到过第一次移动」
      trailInit: false,

      // 延迟事件队列 { t, fn }
      timeline: [],

      // ---- 太阳对象 ----
      sun: {
        active: false,
        mode: 'fusion',
        x: 0, y: 0,
        baseX: 0, baseY: 0,
        t: 0,
        charging: false,
        R: 20,
        appear: 0,
        granules: [],
        sunspots: [],
        arcs: [],
        granuleAcc: 0,
        overload: 0,
        dying: false,
        dyingT: 0
      },

      // ---- 磁场线编织 ----
      weave: {
        active: false,
        t: 0,
        lines: [],
        captured: []
      },

      // ---- 磁场线残留 { x0,y0,cx,cy,x1,y1, life, maxLife } ----
      residuals: [],

      // ---- 日冕残影 { x, y, r0, r1, life, maxLife, tex, alpha0 } ----
      ghosts: []
    };
  }

  /* ==================================================================
     粒子池
     ================================================================== */
  _alloc(s) {
    if (s.freeList.length === 0) return null;
    const p = s.particles[s.freeList.pop()];
    p.active = true;
    p.type = '';
    p.life = 0;
    p.maxLife = 1;
    p.drag = 0;
    p.grav = 0;
    p.trail = 0;
    p.tex = null;
    p.alpha = 1;
    p.timer = 0;
    p.captured = false;
    p.tvt = 0;
    p.lineIdx = -1;
    p.lineT = 0.5;
    p.a = 0; p.b = 0; p.c = 0; p.d = 0;
    return p;
  }

  _release(s, p) {
    if (!p.active) return;
    p.active = false;
    s.freeList.push(p._i);
  }

  _getFreeArc(s) {
    const arcPool = s.arcPool;
    for (let i = 0; i < arcPool.length; i++) {
      if (!arcPool[i].active) return arcPool[i];
    }
    return null;
  }

  /* ==================================================================
     输入（按键）—— 鼠标速度由基类算好，这里只处理左右键交互
     ================================================================== */
  onPointerDown(e) {
    const s = this.state;
    if (!s) return;

    // 原型以 mousedown 时的 mx / my（即最后一次 mousemove 的位置）作为原点，
    // 与基类的 input.x / input.y 语义一致
    if (e.button === 0) {
      this._onLeftDown(s, s.input.x, s.input.y);
    } else if (e.button === 2) {
      this._onRightDown(s, s.input.x, s.input.y);
    }
  }

  onPointerUp(e) {
    const s = this.state;
    if (!s) return;
    const sun = s.sun;

    if (e.button === 0 && sun.active && sun.mode === 'fusion') {
      this._onLeftUp(s);
    } else if (e.button === 2 && sun.active && sun.mode === 'prom') {
      this._onRightUp(s);
    }
  }

  // 失焦清理蓄力状态（原型 window blur 的行为）
  onBlur() {
    const s = this.state;
    if (!s) return;
    const sun = s.sun;

    if (sun.active) {
      for (const a of sun.arcs) a.active = false;
      sun.arcs.length = 0;
      sun.granules.length = 0;
      sun.sunspots.length = 0;
      sun.active = false;
      sun.charging = false;
      sun.appear = 0;
      sun.dying = false;
    }
    s.weave.active = false;
    s.weave.captured.length = 0;
    s.weave.lines.length = 0;
  }

  /* ==================================================================
     尺寸 —— 只同步动效自己的 W / H，画布尺寸与 DPR 由基类维护
     ================================================================== */
  onResize(width, height) {
    const s = this.state;
    if (!s) return;
    s.W = width;
    s.H = height;
  }

  /* ==================================================================
     交互：左键按下 —— 单击瞬间（小太阳 / 光球辐射 / 辐射环 / 日冕闪光 / 磁力线编织）
     ================================================================== */
  _onLeftDown(s, x, y) {
    const sun = s.sun;
    if (sun.active) return;

    // 小太阳诞生
    this._startSun(s, x, y, 'fusion');

    // 向外辐射的光球粒子
    const n = Math.floor(rand(8, 15));
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * TAU + rand(-0.2, 0.2);
      const spd = rand(150, 400);
      const p = this._alloc(s);
      if (!p) break;
      p.type = 'photon';
      p.x = x; p.y = y; p.px = x; p.py = y;
      p.vx = Math.cos(ang) * spd;
      p.vy = Math.sin(ang) * spd;
      p.r = rand(1, 3);
      p.maxLife = 0.8;
      p.trail = rand(0.6, 1.2);
      p.drag = 1.2;
      p.grav = CONFIG.TRAIL.gravity * 0.5;
      p.tex = s.tex.white;
    }

    // 辐射环：12~18 个小光点组成的圆环，从光标向外扩散到 60px
    const ringN = Math.floor(rand(12, 19));
    for (let i = 0; i < ringN; i++) {
      const ang = (i / ringN) * TAU;
      const p = this._alloc(s);
      if (!p) break;
      p.type = 'ring';
      p.x = x; p.y = y; p.px = x; p.py = y;
      const spd = 150;
      p.vx = Math.cos(ang) * spd;
      p.vy = Math.sin(ang) * spd;
      p.r = rand(1.2, 2.4);
      p.maxLife = 0.4;
      p.trail = 0.9;
      p.drag = 2.2;
      p.a = ang;
      p.b = 60;      // 最大扩散半径
      p.tex = s.tex.white;
    }

    // 日冕闪光
    this._spawnFlash(s, x, y, 15, 15, 0.15);

    // 磁力线编织
    this._doMagneticWeave(s, x, y);
  }

  /* ==================================================================
     交互：右键按下 —— 日珥
     ================================================================== */
  _onRightDown(s, x, y) {
    if (s.sun.active) return;
    this._startSun(s, x, y, 'prom');
  }

  /* ==================================================================
     太阳生命周期
     ================================================================== */
  _startSun(s, x, y, mode) {
    const sun = s.sun;
    sun.active = true;
    sun.mode = mode;
    sun.x = x; sun.y = y;
    sun.baseX = x; sun.baseY = y;
    sun.t = 0;
    sun.charging = true;
    sun.appear = 0;
    sun.R = mode === 'fusion' ? CONFIG.FUSION.sunMinR : CONFIG.PROM.sunR;
    sun.granules.length = 0;
    sun.sunspots.length = 0;
    for (const a of sun.arcs) a.active = false;
    sun.arcs.length = 0;
    sun.granuleAcc = 0;
    sun.overload = 0;
    sun.dying = false;
    sun.dyingT = 0;
  }

  _endSun(s) {
    const sun = s.sun;
    sun.active = false;
    sun.charging = false;
    for (const a of sun.arcs) a.active = false;
    sun.arcs.length = 0;
    sun.granules.length = 0;
    sun.sunspots.length = 0;
  }

  _onLeftUp(s) {
    const sun = s.sun;
    if (!sun.active) return;
    sun.charging = false;
    if (sun.t < 0.12) {
      this._endSun(s);
      return;
    }
    const power = Math.pow(clamp(sun.t, 0, CONFIG.FUSION.chargeTime) / CONFIG.FUSION.chargeTime, 1.6);
    this._fusionBurst(s, power);
    // 拖尾被磁力线编织
    this._doMagneticWeave(s, sun.x, sun.y);
    sun.dying = true;
    sun.dyingT = 0;
  }

  _onRightUp(s) {
    const sun = s.sun;
    if (!sun.active) return;
    sun.charging = false;
    if (sun.t < 0.12) {
      // 快速点击：只做 1~2 条拱环快速升起后断裂
      if (sun.arcs.length === 0) {
        this._addArc(s, 0, 2, false);
        const R = sun.R * sun.appear;
        const a = sun.arcs[0];
        s.timeline.push({ t: 0.08, fn: () => { this._reconnectArc(s, a, 0.15, R); } });
      }
      sun.dying = true;
      sun.dyingT = 0;
      return;
    }
    const power = Math.pow(clamp(sun.t, 0, CONFIG.PROM.chargeTime) / CONFIG.PROM.chargeTime, 1.6);
    this._promBurst(s, power);
    this._doMagneticWeave(s, sun.x, sun.y);
    sun.dying = true;
    sun.dyingT = 0;
  }

  /* ==================================================================
     通用生成器
     ================================================================== */
  _spawnFlash(s, x, y, r0, r1, life) {
    const p = this._alloc(s);
    if (!p) return;
    p.type = 'flash';
    p.x = x; p.y = y; p.px = x; p.py = y;
    p.vx = 0; p.vy = 0;
    p.r = r0;
    p.a = r0;
    p.b = r1;
    p.maxLife = life;
    p.tex = s.tex.white;
  }

  _spawnSpark(s, x, y, r, tex, life) {
    const p = this._alloc(s);
    if (!p) return;
    p.type = 'spark';
    p.x = x; p.y = y; p.px = x; p.py = y;
    p.vx = rand(-30, 30);
    p.vy = rand(-30, 30);
    p.r = r;
    p.maxLife = life;
    p.tex = tex || s.tex.gold;
  }

  /* ==================================================================
     左键爆发 —— 耀斑
     ================================================================== */
  _fusionBurst(s, power) {
    const sun = s.sun;
    const cx = sun.x, cy = sun.y;
    const R = sun.R * sun.appear;

    // 核心过曝
    sun.overload = 1;

    // ---- 耀斑粒子：从黑子位置射出 ----
    const flareN = Math.floor(CONFIG.FUSION.flareBase + CONFIG.FUSION.flarePower * power);
    const spotCount = Math.max(1, sun.sunspots.length);
    for (let i = 0; i < flareN; i++) {
      let sx = cx, sy = cy;
      let baseAng = Math.random() * TAU;
      if (sun.sunspots.length > 0) {
        const spt = sun.sunspots[i % spotCount];
        const ang = spt.a;
        const d = spt.u * R;
        sx = cx + Math.cos(ang) * d;
        sy = cy + Math.sin(ang) * d;
        baseAng = ang;
      }
      const ang = baseAng + rand(-1.0, 1.0);
      const spd = (CONFIG.FUSION.flareSpeedBase + CONFIG.FUSION.flareSpeedPower * power) * rand(0.7, 1.25);
      const p = this._alloc(s);
      if (!p) break;
      p.type = 'flare';
      p.x = sx; p.y = sy; p.px = sx; p.py = sy;
      p.vx = Math.cos(ang) * spd;
      p.vy = Math.sin(ang) * spd;
      p.r = rand(1, 3);
      p.maxLife = rand(0.9, 1.7);
      p.trail = rand(0.9, 1.4);
      p.drag = 0.45;
      p.timer = 0.1;
      p.a = baseAng;  // 用于弧形轨迹
      p.b = rand(-1, 1) * 260;  // 侧向加速度
    }

    // ---- 日冕物质抛射（CME）----
    const cmeAng = Math.random() * TAU;
    const cmeN = Math.floor(CONFIG.FUSION.cmeBase + CONFIG.FUSION.cmePower * power);
    const cmeSpd = CONFIG.FUSION.cmeSpeedBase + CONFIG.FUSION.cmeSpeedPower * power;
    for (let i = 0; i < cmeN; i++) {
      const ang = cmeAng + rand(-0.55, 0.55);
      const spd = cmeSpd * rand(0.6, 1.15);
      const sx = cx + Math.cos(cmeAng) * R * 0.9;
      const sy = cy + Math.sin(cmeAng) * R * 0.9;
      const p = this._alloc(s);
      if (!p) break;
      p.type = 'cme';
      p.x = sx; p.y = sy; p.px = sx; p.py = sy;
      p.vx = Math.cos(ang) * spd;
      p.vy = Math.sin(ang) * spd;
      p.r = rand(1.2, 3);
      p.maxLife = rand(1.2, 2.4);
      p.trail = rand(0.5, 1.0);
      p.drag = 0.35;
      p.a = cmeAng;
    }

    // ---- 辐射波 ----
    const waveR = CONFIG.FUSION.waveMaxRBase + CONFIG.FUSION.waveMaxRPower * power;
    const waveN = 46;
    for (let i = 0; i < waveN; i++) {
      const ang = (i / waveN) * TAU + rand(-0.05, 0.05);
      const p = this._alloc(s);
      if (!p) break;
      p.type = 'wave';
      p.x = cx; p.y = cy; p.px = cx; p.py = cy;
      p.vx = Math.cos(ang) * 120;
      p.vy = Math.sin(ang) * 120;
      p.r = rand(1.2, 2.6);
      p.maxLife = 0.6;
      p.trail = 1.1;
      p.drag = 1.6;
      p.a = ang;
      p.b = waveR;
      p.c = R;
    }

    // ---- 米粒风暴 ----
    for (const g of sun.granules) {
      const d = g.u * R;
      const ang = g.a;
      const gx = cx + Math.cos(ang) * d;
      const gy = cy + Math.sin(ang) * d;
      const p = this._alloc(s);
      if (!p) break;
      p.type = 'gran';
      p.x = gx; p.y = gy; p.px = gx; p.py = gy;
      const sa = Math.atan2(gy - cy, gx - cx) + rand(-0.5, 0.5);
      const spd = rand(200, 500);
      p.vx = Math.cos(sa) * spd;
      p.vy = Math.sin(sa) * spd;
      p.r = g.r;
      p.maxLife = 0.8;
      p.drag = 0.9;
      p.a = 1;  // 亮度
    }

    // ---- 日冕残影 ----
    s.ghosts.push({
      x: cx, y: cy,
      r0: 200, r1: 400,
      life: 0, maxLife: 1.5,
      tex: s.tex.pale,
      alpha0: 0.15
    });

    // ---- 逐层炸散（核心 → 光球 → 光晕）----
    sun.overload = 1;
    s.timeline.push({ t: 0.03, fn: () => { sun.overload = 1; } });
  }

  /* ==================================================================
     右键爆发 —— 磁场重联
     ================================================================== */
  _promBurst(s, power) {
    const sun = s.sun;
    const R = sun.R * sun.appear;

    // 按高度排序，从高到低依次重联（重联瀑布）
    const arcs = sun.arcs.slice().sort(function (a, b) { return b.h - a.h; });
    for (let i = 0; i < arcs.length; i++) {
      const a = arcs[i];
      const delay = i * 0.05;
      const pw = power * (1 - (i / Math.max(1, arcs.length)) * 0.5);
      s.timeline.push({ t: delay, fn: () => { this._reconnectArc(s, a, pw, R); } });
    }

    // 磁场网络爆发：所有磁场线绷断成短线段
    const magSegs = 30;
    for (let i = 0; i < magSegs; i++) {
      const ang = Math.random() * TAU;
      const d = R * rand(0.5, 1.4);
      const sx = sun.x + Math.cos(ang) * d;
      const sy = sun.y + Math.sin(ang) * d;
      const p = this._alloc(s);
      if (!p) break;
      p.type = 'magseg';
      p.x = sx; p.y = sy; p.px = sx; p.py = sy;
      const sa = ang + rand(-0.9, 0.9);
      const spd = rand(600, 1200);
      p.vx = Math.cos(sa) * spd;
      p.vy = Math.sin(sa) * spd;
      p.r = rand(0.6, 1.2);
      p.maxLife = 0.5;
      p.trail = 1.4;
      p.drag = 1.4;
      p.a = sa;
    }

    // 日冕扩张
    s.ghosts.push({
      x: sun.x, y: sun.y,
      r0: R * 2, r1: R * 4,
      life: 0, maxLife: 1.2,
      tex: s.tex.pale,
      alpha0: 0.14
    });

    // 足点电火花
    for (const a of sun.arcs) {
      const a0 = a.a0 + a.drift, a1 = a.a1 + a.drift;
      const Ax = sun.x + Math.cos(a0) * R, Ay = sun.y + Math.sin(a0) * R;
      const Bx = sun.x + Math.cos(a1) * R, By = sun.y + Math.sin(a1) * R;
      this._spawnSpark(s, Ax, Ay, 5, s.tex.gold, 0.2);
      this._spawnSpark(s, Bx, By, 5, s.tex.gold, 0.2);
    }

    // 等离子体风
    const windN = Math.floor(CONFIG.PROM.windBase + CONFIG.PROM.windPower * power);
    const windSpd = CONFIG.PROM.windSpeedBase + CONFIG.PROM.windSpeedPower * power;
    for (let i = 0; i < windN; i++) {
      const ang = Math.random() * TAU;
      const sx = sun.x + Math.cos(ang) * R;
      const sy = sun.y + Math.sin(ang) * R;
      const p = this._alloc(s);
      if (!p) break;
      p.type = 'cme';
      p.x = sx; p.y = sy; p.px = sx; p.py = sy;
      const spd = windSpd * rand(0.6, 1.2);
      p.vx = Math.cos(ang) * spd;
      p.vy = Math.sin(ang) * spd;
      p.r = rand(1.2, 3);
      p.maxLife = rand(0.8, 1.6);
      p.trail = rand(0.5, 0.9);
      p.drag = 0.6;
      p.a = 1;   // 1 = 品红/紫配色
    }

    // 太阳本体过曝
    sun.overload = 1;
  }

  /* ==================================================================
     重联单条拱环
     ================================================================== */
  _reconnectArc(s, a, power, R) {
    const sun = s.sun;
    if (!a.active) return;
    a.active = false;
    const idx = sun.arcs.indexOf(a);
    if (idx >= 0) sun.arcs.splice(idx, 1);

    const cx = sun.x, cy = sun.y;
    const a0 = a.a0 + a.drift, a1 = a.a1 + a.drift;
    const Ax = cx + Math.cos(a0) * R, Ay = cy + Math.sin(a0) * R;
    const Bx = cx + Math.cos(a1) * R, By = cy + Math.sin(a1) * R;
    const midA = (a0 + a1) / 2;
    const nx = Math.cos(midA), ny = Math.sin(midA);
    const Mx = (Ax + Bx) / 2, My = (Ay + By) / 2;
    const Cx = Mx + nx * 2 * a.h, Cy = My + ny * 2 * a.h;

    // 重联闪光
    const apex = bezPoint(Ax, Ay, Cx, Cy, Bx, By, 0.5);
    this._spawnFlash(s, apex.x, apex.y, 5, 30, 0.15);

    // 断裂段抛出
    const speed = CONFIG.PROM.reconnectBase + CONFIG.PROM.reconnectPower * power;
    for (let i = 0; i < a.parts.length; i++) {
      const pt = a.parts[i];
      const u = (pt.off + a.flow) % 1;
      const t = Math.acos(clamp(1 - 2 * u, -1, 1)) / Math.PI;
      const pos = bezPoint(Ax, Ay, Cx, Cy, Bx, By, t);
      const tan = bezTan(Ax, Ay, Cx, Cy, Bx, By, t);
      const side = t < 0.5 ? -1 : 1;
      const distN = Math.abs(t - 0.5) * 2;

      const p = this._alloc(s);
      if (!p) break;
      p.type = 'arcseg';
      p.x = pos.x; p.y = pos.y; p.px = pos.x; p.py = pos.y;
      p.vx = tan.x * side * speed * distN + nx * speed * 0.55 + rand(-90, 90);
      p.vy = tan.y * side * speed * distN + ny * speed * 0.55 + rand(-90, 90);
      p.r = rand(1.5, 4);
      p.maxLife = rand(0.8, 1.6);
      p.trail = rand(0.7, 1.3);
      p.drag = 0.55;
      p.a = t;
      p.b = Math.random();  // 扩散随机量
    }

    // 足点电火花
    this._spawnSpark(s, Ax, Ay, 5, s.tex.gold, 0.2);
    this._spawnSpark(s, Bx, By, 5, s.tex.gold, 0.2);
  }

  /* ==================================================================
     磁力线编织（点击冲击）
     ================================================================== */
  _doMagneticWeave(s, x, y) {
    const N = CONFIG.WEAVE.lineCount;
    const lines = [];
    const baseAngle = Math.random() * TAU;
    for (let i = 0; i < N; i++) {
      const ang = baseAngle + (i / N) * TAU + rand(-0.12, 0.12);
      const len = rand(CONFIG.WEAVE.lenMin, CONFIG.WEAVE.lenMax);
      const ex = x + Math.cos(ang) * len;
      const ey = y + Math.sin(ang) * len;
      const midx = (x + ex) / 2, midy = (y + ey) / 2;
      const pa = ang + Math.PI / 2;
      const cv = rand(-70, 70);
      const cxp = midx + Math.cos(pa) * cv;
      const cyp = midy + Math.sin(pa) * cv;
      lines.push({ x0: x, y0: y, cx: cxp, cy: cyp, x1: ex, y1: ey });
    }

    const weave = s.weave;
    weave.lines = lines;
    weave.t = 0;
    weave.active = true;
    weave.captured.length = 0;

    const R2 = CONFIG.WEAVE.radius * CONFIG.WEAVE.radius;

    // 每条线的分组
    const groups = [];
    for (let i = 0; i < lines.length; i++) groups.push([]);

    for (let i = 0; i < s.particles.length; i++) {
      const p = s.particles[i];
      if (!p.active || p.type !== 'photon' || p.captured) continue;
      const dx = p.x - x, dy = p.y - y;
      if (dx * dx + dy * dy > R2) continue;

      // 找最近的磁场线
      let bestLine = -1, bestD = Infinity, bestT = 0.5;
      for (let j = 0; j < lines.length; j++) {
        const L = lines[j];
        for (let k = 1; k <= 8; k++) {
          const tt = k / 9;
          const pt = bezPoint(L.x0, L.y0, L.cx, L.cy, L.x1, L.y1, tt);
          const ddx = p.x - pt.x, ddy = p.y - pt.y;
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 < bestD) { bestD = d2; bestLine = j; bestT = tt; }
        }
      }
      if (bestLine < 0) continue;
      groups[bestLine].push({ p: p, t: bestT });
    }

    // 每条线上的粒子均匀排列成链
    for (let j = 0; j < lines.length; j++) {
      const g = groups[j];
      if (g.length === 0) continue;
      g.sort(function (a, b) { return a.t - b.t; });
      const L = lines[j];
      for (let k = 0; k < g.length; k++) {
        const tt = (k + 0.5) / g.length;
        const pt = bezPoint(L.x0, L.y0, L.cx, L.cy, L.x1, L.y1, tt);
        const p = g[k].p;
        p.captured = true;
        p.tvt = 0;
        p.capX = p.x; p.capY = p.y;
        p.tx = pt.x; p.ty = pt.y;
        p.lineIdx = j;
        p.lineT = tt;
        p.svx = p.vx; p.svy = p.vy;
        p.vx = 0; p.vy = 0;
        weave.captured.push(p);
      }
    }
  }

  _updateWeave(s, dt) {
    const weave = s.weave;
    if (!weave.active) return;
    weave.t += dt;

    // 单个粒子的捕获推进在 _updateParticles 里处理
    // 全部完成后关闭
    if (weave.t > CONFIG.WEAVE.captureTime + CONFIG.WEAVE.flowTime) {
      weave.active = false;
      // 生成磁场线残留
      const n = Math.min(CONFIG.WEAVE.residualCount, weave.lines.length);
      for (let i = 0; i < n; i++) {
        const L = weave.lines[i];
        s.residuals.push({
          x0: L.x0, y0: L.y0, cx: L.cx, cy: L.cy, x1: L.x1, y1: L.y1,
          life: 0,
          maxLife: CONFIG.WEAVE.residualLife
        });
      }
      weave.lines.length = 0;
    }
  }

  /* ==================================================================
     太阳系统更新
     ================================================================== */
  _updateSun(s, dt) {
    const sun = s.sun;
    if (!sun.active) return;

    if (sun.appear < 1) {
      sun.appear = Math.min(1, sun.appear + dt / 0.18);
    }

    if (sun.charging) {
      sun.t += dt;
      sun.baseX = s.input.x;
      sun.baseY = s.input.y;

      const p = Math.min(sun.t / CONFIG.FUSION.chargeTime, 1);

      // 微震
      if (p > CONFIG.FUSION.shakeStart) {
        const amp = ((p - CONFIG.FUSION.shakeStart) / (1 - CONFIG.FUSION.shakeStart)) * 3;
        sun.x = sun.baseX + rand(-amp, amp);
        sun.y = sun.baseY + rand(-amp, amp);
      } else {
        sun.x = sun.baseX;
        sun.y = sun.baseY;
      }

      if (sun.mode === 'fusion') this._updateFusionCharge(s, dt, p);
      else this._updatePromCharge(s, dt, p);
    }

    // 过曝衰减
    if (sun.overload > 0) sun.overload = Math.max(0, sun.overload - dt * 12);

    // 消亡
    if (sun.dying) {
      sun.dyingT += dt;
      const dur = sun.mode === 'fusion' ? 0.35 : 0.5;
      if (sun.dyingT > dur) {
        this._endSun(s);
        return;
      }
      sun.appear = 1 - sun.dyingT / dur;
    }
  }

  /* ---- 左键蓄力 ---- */
  _updateFusionCharge(s, dt, p) {
    const sun = s.sun;
    sun.R = CONFIG.FUSION.sunMinR +
            (CONFIG.FUSION.sunMaxR - CONFIG.FUSION.sunMinR) * Math.pow(p, 0.75);

    // 米粒组织：20 → 120
    const targetG = Math.floor(CONFIG.FUSION.granuleMin +
      (CONFIG.FUSION.granuleMax - CONFIG.FUSION.granuleMin) * p);
    sun.granuleAcc += dt * 46;
    while (sun.granules.length < targetG && sun.granuleAcc >= 1) {
      sun.granuleAcc -= 1;
      this._addGranule(s);
    }
    if (sun.granules.length > CONFIG.FUSION.granuleMax) {
      sun.granules.length = CONFIG.FUSION.granuleMax;
    }

    // 黑子
    if (sun.t > CONFIG.FUSION.sunspotStart) {
      const targetS = Math.min(3, 1 + Math.floor((sun.t - CONFIG.FUSION.sunspotStart) / 0.45));
      while (sun.sunspots.length < targetS) this._addSunspot(s);
    }

    // 小日珥拱环
    if (sun.t > CONFIG.FUSION.smallArcStart) {
      const targetA = Math.min(4, 1 + Math.floor((sun.t - CONFIG.FUSION.smallArcStart) / 0.3));
      while (sun.arcs.length < targetA) {
        this._addArc(s, sun.arcs.length, 4, true);
      }
    }

    // 耀斑前兆：黑子区域内部粒子加速运动（由 sunspot 脉动体现）
  }

  /* ---- 右键蓄力 ---- */
  _updatePromCharge(s, dt, p) {
    const sun = s.sun;
    sun.R = CONFIG.PROM.sunR;

    // 拱环数量 1 → 12
    if (sun.t > CONFIG.PROM.arcStart) {
      const prog = Math.min(1, (sun.t - CONFIG.PROM.arcStart) / (CONFIG.PROM.chargeTime - CONFIG.PROM.arcStart));
      const targetA = Math.floor(CONFIG.PROM.arcMin +
        (CONFIG.PROM.arcMax - CONFIG.PROM.arcMin) * prog);
      while (sun.arcs.length < targetA) {
        this._addArc(s, sun.arcs.length, targetA, false);
      }
    }

    // 拱环高度 80 → 300
    const hTarget = CONFIG.PROM.arcHeightMin +
      (CONFIG.PROM.arcHeightMax - CONFIG.PROM.arcHeightMin) * p;
    for (const a of sun.arcs) {
      if (a.small) continue;
      a.h = lerp(a.h, hTarget, Math.min(1, dt * 1.6));
    }

    // 足点漂移
    const driftRate = CONFIG.PROM.driftSpeed / Math.max(8, sun.R);
    for (const a of sun.arcs) {
      a.drift += dt * driftRate * a.driftDir;
    }

    // 磁场线数量
    for (const a of sun.arcs) {
      a.magCount = sun.t > 1.5 ? CONFIG.PROM.magLines : 2;
    }

    // 不稳定
    for (const a of sun.arcs) {
      a.unstable = sun.t > CONFIG.PROM.precursorStart ? 1 : 0;
    }
  }

  /* ---- 米粒组织 ---- */
  _addGranule(s) {
    const sun = s.sun;
    let u = 0.28, a = 0;
    for (let attempt = 0; attempt < 20; attempt++) {
      u = 0.28 + Math.sqrt(Math.random()) * 0.66;
      a = Math.random() * TAU;
      let ok = true;
      for (let i = 0; i < sun.granules.length; i++) {
        const g = sun.granules[i];
        const du = u - g.u;
        let da = a - g.a;
        if (da > Math.PI) da -= TAU;
        if (da < -Math.PI) da += TAU;
        const d2 = du * du + da * da * 0.5;
        if (d2 < 0.0032) { ok = false; break; }
      }
      if (ok) break;
    }
    sun.granules.push({
      u: u,
      a: a,
      r: rand(CONFIG.FUSION.granuleRMin, CONFIG.FUSION.granuleRMax),
      phase: Math.random() * TAU,
      period: rand(CONFIG.FUSION.granulePeriodMin, CONFIG.FUSION.granulePeriodMax),
      life: rand(CONFIG.FUSION.granuleLifeMin, CONFIG.FUSION.granuleLifeMax),
      age: 0,
      convT: Math.random() * 0.35
    });
  }

  _updateGranules(s, dt) {
    const sun = s.sun;
    const R = sun.R * sun.appear;
    for (let i = sun.granules.length - 1; i >= 0; i--) {
      const g = sun.granules[i];
      g.age += dt;
      if (g.age > g.life) {
        sun.granules.splice(i, 1);
        continue;
      }
      // 对流循环：上升热流
      g.convT -= dt;
      if (g.convT <= 0) {
        g.convT = rand(0.18, 0.45);
        if (s.freeList.length > 500) this._spawnConvection(s, g, R);
      }
    }
  }

  _spawnConvection(s, g, R) {
    const sun = s.sun;
    const d = g.u * R;
    const ang = g.a;
    const x = sun.x + Math.cos(ang) * d;
    const y = sun.y + Math.sin(ang) * d;
    const dir = Math.random() * TAU;
    const spd = rand(CONFIG.FUSION.convSpeedMin, CONFIG.FUSION.convSpeedMax);
    const p = this._alloc(s);
    if (!p) return;
    p.type = 'conv';
    p.x = x; p.y = y; p.px = x; p.py = y;
    p.vx = Math.cos(dir) * spd;
    p.vy = Math.sin(dir) * spd;
    p.r = rand(0.9, 2.1);
    p.maxLife = rand(0.25, 0.5);
    p.trail = 0.5;
  }

  /* ---- 黑子 ---- */
  _addSunspot(s) {
    const parts = [];
    const n = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      parts.push({
        dx: rand(-1, 1) * (n > 1 ? 1 : 0),
        dy: rand(-1, 1) * (n > 1 ? 1 : 0),
        sc: n === 1 ? 1 : rand(0.5, 0.8)
      });
    }
    s.sun.sunspots.push({
      u: rand(0.28, 0.72),
      a: Math.random() * TAU,
      r: rand(CONFIG.FUSION.sunspotRMin, CONFIG.FUSION.sunspotRMax),
      phase: Math.random() * TAU,
      parts: parts
    });
  }

  /* ---- 拱环 ---- */
  _addArc(s, index, total, small) {
    const a = this._getFreeArc(s);
    if (!a) return;
    const mid = (index / Math.max(1, total)) * TAU + rand(-0.25, 0.25);
    const half = small ? rand(0.16, 0.28) : rand(0.30, 0.55);
    a.active = true;
    a.a0 = mid - half;
    a.a1 = mid + half;
    a.phase = Math.random() * TAU;
    a.h = small ? rand(30, 60) : CONFIG.PROM.arcHeightMin;
    a.flow = Math.random();
    a.born = 0;
    a.drift = rand(-0.1, 0.1);
    a.driftDir = Math.random() < 0.5 ? -1 : 1;
    a.small = small;
    a.magCount = 2;
    a.unstable = 0;

    const n = small ? Math.floor(rand(10, 17)) : Math.floor(rand(15, 31));
    a.parts.length = 0;
    for (let i = 0; i < n; i++) {
      a.parts.push({ off: i / n });
    }
    s.sun.arcs.push(a);
  }

  _updateArcs(s, dt) {
    const sun = s.sun;
    for (let i = 0; i < sun.arcs.length; i++) {
      const a = sun.arcs[i];
      if (!a.active) continue;
      a.born = Math.min(1, a.born + dt / 0.25);
      // 流动
      const speed = rand(CONFIG.PROM.arcFlowMin, CONFIG.PROM.arcFlowMax);
      const R = sun.R * sun.appear;
      const len = Math.max(60, a.h * 2.2 + R * 1.2);
      a.flow = (a.flow + (speed * dt) / len) % 1;
    }
  }

  /* ==================================================================
     粒子更新
     ================================================================== */
  _updateParticles(s, dt) {
    const sun = s.sun;
    const weave = s.weave;
    const particles = s.particles;

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (!p.active) continue;

      p.life += dt;
      if (p.life >= p.maxLife) {
        this._release(s, p);
        continue;
      }

      // ---- 磁场线编织捕获 ----
      if (p.captured) {
        p.tvt += dt;
        const capT = CONFIG.WEAVE.captureTime;
        const flowT = CONFIG.WEAVE.flowTime;
        if (p.tvt < capT) {
          const u = 1 - Math.pow(1 - p.tvt / capT, 3);
          p.px = p.x; p.py = p.y;
          p.x = lerp(p.capX, p.tx, u);
          p.y = lerp(p.capY, p.ty, u);
        } else if (p.tvt < capT + flowT) {
          const L = weave.lines[p.lineIdx];
          if (L) {
            const nt = clamp(p.lineT + (p.tvt - capT) * 0.4, 0, 1);
            const pt = bezPoint(L.x0, L.y0, L.cx, L.cy, L.x1, L.y1, nt);
            p.px = p.x; p.py = p.y;
            p.x = pt.x; p.y = pt.y;
          }
        } else {
          p.captured = false;
          p.vx = p.svx;
          p.vy = p.svy;
          p.maxLife = Math.max(p.maxLife, p.life + 0.5);
        }
        continue;
      }

      // ---- 特殊行为 ----
      if (p.type === 'flare') {
        // 弧形轨迹
        const perp = p.a + Math.PI / 2;
        p.vx += Math.cos(perp) * p.b * dt;
        p.vy += Math.sin(perp) * p.b * dt;

        // 次级粒子
        p.timer -= dt;
        if (p.timer <= 0 && p.life < p.maxLife * 0.65 && s.freeList.length > 500) {
          p.timer = 0.1;
          const cn = Math.random() < 0.5 ? 1 : 2;
          for (let k = 0; k < cn; k++) {
            const sp = this._alloc(s);
            if (!sp) break;
            sp.type = 'flareSub';
            sp.x = p.x; sp.y = p.y; sp.px = p.x; sp.py = p.y;
            sp.vx = p.vx * 0.28 + rand(-90, 90);
            sp.vy = p.vy * 0.28 + rand(-90, 90);
            sp.r = rand(0.8, 1.8);
            sp.maxLife = rand(0.3, 0.65);
            sp.trail = 0.8;
            sp.drag = 1.2;
          }
        }
      } else if (p.type === 'conv') {
        // 到达边缘后减速变暗
        const sp = Math.hypot(p.vx, p.vy);
        if (sp > 6) { p.vx *= 0.985; p.vy *= 0.985; }
      } else if (p.type === 'ring' || p.type === 'wave') {
        // 限制最大半径
        const dx = p.x - sun.x, dy = p.y - sun.y;
        const d = Math.hypot(dx, dy);
        if (p.type === 'wave') {
          p.b = p.b;
        }
        if (d > p.b && d > 0) {
          const k = p.b / d;
          p.x = sun.x + dx * k;
          p.y = sun.y + dy * k;
          p.vx *= 0.5; p.vy *= 0.5;
        }
      } else if (p.type === 'photon') {
        // 被太阳吸引（污染拖尾）
        if (sun.active && sun.appear > 0.4) {
          const dx = sun.x - p.x, dy = sun.y - p.y;
          const d = Math.hypot(dx, dy) || 1;
          if (d < 260) {
            const f = 420 * (1 - d / 260);
            p.vx += (dx / d) * f * dt;
            p.vy += (dy / d) * f * dt;
          }
        }
      } else if (p.type === 'arcseg' || p.type === 'cme') {
        if (p.a === 1) {
          // 等离子体：逐步冷却
          p.drag = 0.55;
        }
      }

      // ---- 通用物理 ----
      p.px = p.x; p.py = p.y;
      p.vy += p.grav * dt;
      if (p.drag > 0) {
        const k = Math.exp(-p.drag * dt);
        p.vx *= k;
        p.vy *= k;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }

    // 磁场线残留
    for (let i = s.residuals.length - 1; i >= 0; i--) {
      s.residuals[i].life += dt;
      if (s.residuals[i].life >= s.residuals[i].maxLife) s.residuals.splice(i, 1);
    }

    // 日冕残影
    for (let i = s.ghosts.length - 1; i >= 0; i--) {
      s.ghosts[i].life += dt;
      if (s.ghosts[i].life >= s.ghosts[i].maxLife) s.ghosts.splice(i, 1);
    }

    // 延迟事件
    for (let i = s.timeline.length - 1; i >= 0; i--) {
      s.timeline[i].t -= dt;
      if (s.timeline[i].t <= 0) {
        const fn = s.timeline[i].fn;
        s.timeline.splice(i, 1);
        fn();
      }
    }
  }

  /* ==================================================================
     鼠标拖尾
     ================================================================== */
  _updateTrail(s, dt) {
    const inp = s.input;

    // 与原型一致：收到第一次移动之前不生成拖尾，并就地建立基准点。
    // 否则首帧会从初始中心点向真实光标位置拉出一条长直线。
    if (!s.trailInit) {
      if (inp.x !== inp.lx || inp.y !== inp.ly) s.trailInit = true;
      return;
    }

    // 基类在帧末把 lx/ly 对齐到 x/y，语义与原型每帧刷新的 lastMX / lastMY 一致
    const dx = inp.x - inp.lx;
    const dy = inp.y - inp.ly;
    const dist = Math.hypot(dx, dy);
    if (dist < 1.2) return;

    const ux = dx / dist, uy = dy / dist;
    const spacing = CONFIG.TRAIL.spacing;
    let travelled = 0;
    let count = 0;

    while (travelled < dist && count < 48) {
      const step = Math.min(spacing, dist - travelled);
      travelled += step;
      const px = inp.lx + ux * travelled;
      const py = inp.ly + uy * travelled;
      this._spawnTrailPhoton(s, px, py);
      count++;
    }
  }

  _spawnTrailPhoton(s, x, y) {
    const inp = s.input;
    const p = this._alloc(s);
    if (!p) return;
    p.type = 'photon';
    p.x = x; p.y = y; p.px = x; p.py = y;

    // 向外辐射方向
    const ox = x - inp.x, oy = y - inp.y;
    let ang;
    if (ox * ox + oy * oy > 4) ang = Math.atan2(oy, ox);
    else ang = Math.random() * TAU;
    ang += (Math.random() - 0.5) * 1.0;

    const spd = rand(CONFIG.TRAIL.speedMin, CONFIG.TRAIL.speedMax);
    p.vx = Math.cos(ang) * spd;
    p.vy = Math.sin(ang) * spd;
    p.grav = CONFIG.TRAIL.gravity;
    p.r = rand(1, 3);
    p.trail = rand(0.6, 1.1);
    p.maxLife = rand(CONFIG.TRAIL.lifeMin, CONFIG.TRAIL.lifeMax);
  }

  /* ==================================================================
     渲染 —— 太阳本体（左键 / 右键）
     ================================================================== */
  _drawCoronaAndHalo(s) {
    const sun = s.sun;
    if (!sun.active) return;
    const ctx = s.ctx;
    const R = sun.R * sun.appear;
    if (R < 2) return;
    const cx = sun.x, cy = sun.y;
    const p = Math.min(sun.t / CONFIG.FUSION.chargeTime, 1);

    // 日冕（蓄力 > 1s，或右键 > 1.5s 出现）
    const coronaOn = (sun.mode === 'fusion' && sun.t > 1.0) ||
                     (sun.mode === 'prom' && sun.t > 1.5) ||
                     sun.dying;
    if (coronaOn) {
      const cd = sun.mode === 'fusion' ? 3.0 : 3.0;
      const size = R * cd * 2;
      let ca = sun.mode === 'fusion' ? 0.045 + 0.035 * p : 0.055;
      if (sun.dying) ca *= Math.max(0, 1 - sun.dyingT / 0.5);
      ctx.globalAlpha = ca;
      ctx.drawImage(s.tex.pale, cx - size / 2, cy - size / 2, size, size);
    }

    // 光晕（1.3 ~ 1.8 倍半径）
    const haloScale = 1.3 + 0.5 * p;
    const hs = R * haloScale * 2.4;
    let ha = sun.mode === 'fusion' ? (0.20 + 0.20 * p) : 0.24;
    if (sun.overload > 0) ha *= (1 + sun.overload * 1.6);
    if (sun.dying) ha *= Math.max(0, 1 - sun.dyingT / 0.5);
    ctx.globalAlpha = ha;
    ctx.drawImage(s.tex.warm, cx - hs / 2, cy - hs / 2, hs, hs);
  }

  _drawSunBody(s) {
    const sun = s.sun;
    if (!sun.active) return;
    const ctx = s.ctx;
    const R = sun.R * sun.appear;
    if (R < 1.5) return;
    const cx = sun.x, cy = sun.y;

    // ---- 光球层（波动边缘多边形）----
    const N = 22;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const ang = (i / N) * TAU;
      const wob = 1 + 0.018 * Math.sin(ang * 5 + s.T * 2.4) +
                      0.012 * Math.sin(ang * 8 - s.T * 1.7);
      const rr = R * wob;
      const x = cx + Math.cos(ang) * rr;
      const y = cy + Math.sin(ang) * rr;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();

    const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    const C = CONFIG.COLOR.fusion;
    grd.addColorStop(0.00, C.core);
    grd.addColorStop(0.12, C.inner);
    grd.addColorStop(0.36, C.gold);
    grd.addColorStop(0.66, C.orange);
    grd.addColorStop(1.00, C.red);
    ctx.fillStyle = grd;
    ctx.fill();

    // ---- 裁剪到光球层内部 ----
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.995, 0, TAU);
    ctx.clip();

    // ---- 米粒组织 ----
    const scale = 0.55 + 0.45 * (R / 150);
    for (let i = 0; i < sun.granules.length; i++) {
      const g = sun.granules[i];
      const d = g.u * R;
      const x = cx + Math.cos(g.a) * d;
      const y = cy + Math.sin(g.a) * d;
      const br = 0.5 + 0.5 * Math.sin(g.phase + s.T * TAU / g.period);

      const lifeT = g.age / g.life;
      let fade = 1;
      if (lifeT < 0.15) fade = lifeT / 0.15;
      else if (lifeT > 0.85) fade = (1 - lifeT) / 0.15;
      fade = clamp(fade, 0, 1);

      const idx = clamp(Math.floor(br * 15.999), 0, 15);
      const gr = g.r * scale;

      ctx.globalAlpha = fade * 0.95;
      ctx.fillStyle = GRAN_OUTER[idx];
      ctx.beginPath();
      ctx.arc(x, y, gr, 0, TAU);
      ctx.fill();

      ctx.fillStyle = GRAN_INNER[idx];
      ctx.beginPath();
      ctx.arc(x, y, gr * 0.55, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // ---- 黑子 ----
    for (let i = 0; i < sun.sunspots.length; i++) {
      const spt = sun.sunspots[i];
      const d = spt.u * R;
      const x = cx + Math.cos(spt.a) * d;
      const y = cy + Math.sin(spt.a) * d;
      const pulse = 0.78 + 0.22 * Math.sin(s.T * TAU * 0.5 + spt.phase);
      const sr = spt.r * (0.4 + 0.6 * (R / 150));

      for (let k = 0; k < spt.parts.length; k++) {
        const part = spt.parts[k];
        const px = x + part.dx * R * 0.035;
        const py = y + part.dy * R * 0.035;
        const pr = sr * part.sc;

        ctx.globalAlpha = 0.62 * pulse * sun.appear;
        ctx.fillStyle = CONFIG.COLOR.fusion.spotPen;
        ctx.beginPath();
        ctx.arc(px, py, pr * 1.4, 0, TAU);
        ctx.fill();

        ctx.globalAlpha = 0.95 * sun.appear;
        ctx.fillStyle = CONFIG.COLOR.fusion.spotCore;
        ctx.beginPath();
        ctx.arc(px, py, pr, 0, TAU);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    ctx.restore();

    // ---- 核心 ----
    const p = Math.min(sun.t / CONFIG.FUSION.chargeTime, 1);
    const corePulse = 1 + 0.05 * Math.sin(s.T * TAU * CONFIG.FUSION.corePulseHz);
    let coreR = (CONFIG.FUSION.coreMinR +
      (CONFIG.FUSION.coreMaxR - CONFIG.FUSION.coreMinR) * p) * corePulse * sun.appear;

    if (sun.overload > 0) {
      coreR = coreR * (1 + sun.overload * 1.0) + sun.overload * 30;
    }

    if (coreR > 0.5) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, TAU);
      ctx.fill();
    }
  }

  _drawCoreGlow(s) {
    const sun = s.sun;
    if (!sun.active) return;
    const ctx = s.ctx;
    const R = sun.R * sun.appear;
    if (R < 2) return;
    const p = Math.min(sun.t / CONFIG.FUSION.chargeTime, 1);
    const coreR = CONFIG.FUSION.coreMinR +
      (CONFIG.FUSION.coreMaxR - CONFIG.FUSION.coreMinR) * p;
    let size = coreR * 7 * sun.appear;
    if (sun.overload > 0) size *= (1 + sun.overload * 1.2);
    let a = 0.5 + 0.3 * p;
    if (sun.overload > 0) a = Math.min(1, a + sun.overload * 0.6);
    ctx.globalAlpha = a;
    ctx.drawImage(s.tex.white, sun.x - size / 2, sun.y - size / 2, size, size);
  }

  /* ==================================================================
     渲染 —— 日珥拱环 + 磁场线
     ================================================================== */
  _drawArcs(s) {
    const sun = s.sun;
    if (!sun.active) return;
    const ctx = s.ctx;
    const R = sun.R * sun.appear;
    if (R < 2) return;
    const cx = sun.x, cy = sun.y;

    for (let i = 0; i < sun.arcs.length; i++) {
      const a = sun.arcs[i];
      if (!a.active) continue;

      const a0 = a.a0 + a.drift;
      const a1 = a.a1 + a.drift;
      const Ax = cx + Math.cos(a0) * R, Ay = cy + Math.sin(a0) * R;
      const Bx = cx + Math.cos(a1) * R, By = cy + Math.sin(a1) * R;
      const midA = (a0 + a1) / 2;
      const nx = Math.cos(midA), ny = Math.sin(midA);
      const Mx = (Ax + Bx) / 2, My = (Ay + By) / 2;
      const h = a.h * a.born;
      const Cx = Mx + nx * 2 * h, Cy = My + ny * 2 * h;

      // ---- 磁场线（青色，比拱环略高）----
      for (let m = 0; m < a.magCount; m++) {
        const off = 6 + m * 6;
        const puls = 1 + 0.02 * Math.sin(s.T * 2.6 + a.phase + m * 1.3);
        const hh = (h + off) * puls;
        const mcx = Mx + nx * 2 * hh;
        const mcy = My + ny * 2 * hh;

        ctx.beginPath();
        for (let k = 0; k <= 18; k++) {
          const t = k / 18;
          const pt = bezPoint(Ax, Ay, mcx, mcy, Bx, By, t);
          if (k === 0) ctx.moveTo(pt.x, pt.y);
          else ctx.lineTo(pt.x, pt.y);
        }
        const alpha = (0.55 - m * 0.12) * a.born;
        ctx.strokeStyle = rgba(79, 227, 255, alpha);
        ctx.lineWidth = 1 - m * 0.22;
        ctx.stroke();
      }

      // ---- 日珥等离子体粒子 ----
      for (let k = 0; k < a.parts.length; k++) {
        const part = a.parts[k];
        const u = (part.off + a.flow) % 1;
        const t = Math.acos(clamp(1 - 2 * u, -1, 1)) / Math.PI;
        const pos = bezPoint(Ax, Ay, Cx, Cy, Bx, By, t);

        const bell = Math.sin(t * Math.PI);
        const bright = Math.pow(bell, 0.8);

        // 闪烁
        let flick = 1;
        if (Math.random() < 0.006 + sun.t * 0.004) flick = 1.5;

        // 不稳定抖动
        let jx = 0, jy = 0;
        if (a.unstable > 0) {
          const amp = a.unstable * 2.5;
          jx = rand(-amp, amp);
          jy = rand(-amp, amp);
        }

        const pr = (1.5 + 2.5 * bright) * a.born;
        const size = pr * 7;

        // 颜色：两端紫 → 弧顶品红偏白
        let tex;
        if (bright > 0.72) tex = s.tex.white;
        else if (bright > 0.4) tex = s.tex.magenta;
        else tex = s.tex.purple;

        ctx.globalAlpha = (0.55 + 0.45 * bright) * a.born * flick;
        ctx.drawImage(tex, pos.x + jx - size / 2, pos.y + jy - size / 2, size, size);
      }
    }
    ctx.globalAlpha = 1;
  }

  /* ==================================================================
     渲染 —— 粒子
     ================================================================== */
  _drawParticles(s) {
    const ctx = s.ctx;
    const TEX = s.tex;
    const particles = s.particles;

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (!p.active) continue;

      const lt = p.life / p.maxLife;
      let alpha = 1;

      switch (p.type) {

        /* ---- 光球粒子：带拖尾的亮点 ---- */
        case 'photon': {
          if (lt > 0.62) alpha = (1 - lt) / 0.38;
          const tex = lt < 0.36 ? TEX.white : (lt < 0.68 ? TEX.gold : TEX.orange);

          if (p.captured) {
            const size = p.r * 7;
            ctx.globalAlpha = alpha * 1.5;
            ctx.drawImage(TEX.cyan, p.x - size / 2, p.y - size / 2, size, size);
            ctx.globalAlpha = alpha * 0.5;
            ctx.strokeStyle = 'rgba(79,227,255,0.8)';
            ctx.lineWidth = p.r * 1.1;
            ctx.beginPath();
            ctx.moveTo(p.px, p.py);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
          } else {
            // 拖尾
            const tx = p.x - p.vx * 0.045 * p.trail;
            const ty = p.y - p.vy * 0.045 * p.trail;
            ctx.globalAlpha = alpha * 0.45;
            ctx.strokeStyle = lt < 0.4 ? '#FFF8E0' : (lt < 0.72 ? '#FFD24A' : '#FF8C1A');
            ctx.lineWidth = p.r * 1.05;
            ctx.beginPath();
            ctx.moveTo(tx, ty);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();

            const size = p.r * 6.5;
            ctx.globalAlpha = alpha;
            ctx.drawImage(tex, p.x - size / 2, p.y - size / 2, size, size);
          }
          break;
        }

        /* ---- 辐射环 ---- */
        case 'ring': {
          alpha = 1 - lt;
          ctx.globalAlpha = alpha * 0.5;
          ctx.strokeStyle = '#FFD24A';
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(p.px, p.py);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          const size = p.r * 7;
          ctx.globalAlpha = alpha;
          ctx.drawImage(TEX.warm, p.x - size / 2, p.y - size / 2, size, size);
          break;
        }

        /* ---- 辐射波 ---- */
        case 'wave': {
          alpha = Math.pow(1 - lt, 0.7);
          const size = p.r * 8;
          ctx.globalAlpha = alpha * 0.85;
          ctx.drawImage(lt < 0.4 ? TEX.white : (lt < 0.75 ? TEX.gold : TEX.orange),
            p.x - size / 2, p.y - size / 2, size, size);
          break;
        }

        /* ---- 耀斑粒子 ---- */
        case 'flare': {
          alpha = lt < 0.65 ? 1 : (1 - lt) / 0.35;
          const tx = p.x - p.vx * 0.055;
          const ty = p.y - p.vy * 0.055;
          const col = lt < 0.25 ? '#FFFFFF' : (lt < 0.55 ? '#FFD24A' : '#FF8C1A');
          ctx.globalAlpha = alpha * 0.55;
          ctx.strokeStyle = col;
          ctx.lineWidth = p.r * 1.1;
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();

          const size = p.r * 7;
          ctx.globalAlpha = alpha;
          ctx.drawImage(lt < 0.3 ? TEX.white : (lt < 0.65 ? TEX.gold : TEX.orange),
            p.x - size / 2, p.y - size / 2, size, size);
          break;
        }

        /* ---- 耀斑次级粒子 ---- */
        case 'flareSub': {
          alpha = (1 - lt) * 0.85;
          const size = p.r * 6;
          ctx.globalAlpha = alpha;
          ctx.drawImage(TEX.gold, p.x - size / 2, p.y - size / 2, size, size);
          break;
        }

        /* ---- 日冕物质抛射 / 等离子体风 ---- */
        case 'cme': {
          alpha = Math.pow(1 - lt, 1.2) * 0.85;
          let tex;
          if (p.a === 1) {
            // 等离子体：品红 → 紫
            tex = lt < 0.35 ? TEX.magenta : TEX.purple;
          } else {
            tex = lt < 0.3 ? TEX.white : (lt < 0.6 ? TEX.gold : TEX.orange);
          }
          const size = p.r * 7;
          ctx.globalAlpha = alpha;
          ctx.drawImage(tex, p.x - size / 2, p.y - size / 2, size, size);
          break;
        }

        /* ---- 对流粒子 ---- */
        case 'conv': {
          alpha = lt < 0.7 ? 0.9 : (1 - lt) / 0.3 * 0.9;
          const tex = lt < 0.45 ? TEX.white : (lt < 0.8 ? TEX.gold : TEX.orange);
          const size = p.r * 6;
          ctx.globalAlpha = alpha;
          ctx.drawImage(tex, p.x - size / 2, p.y - size / 2, size, size);
          break;
        }

        /* ---- 米粒风暴（保持内外结构）---- */
        case 'gran': {
          alpha = Math.pow(1 - lt, 1.1);
          const bright = Math.max(0, 1 - lt * 1.2);
          const idx = clamp(Math.floor(bright * 15.999), 0, 15);
          const gr = p.r * (0.6 + 0.4 * bright);
          ctx.globalAlpha = alpha * 0.95;
          ctx.fillStyle = GRAN_OUTER[idx];
          ctx.beginPath();
          ctx.arc(p.x, p.y, gr, 0, TAU);
          ctx.fill();
          ctx.fillStyle = GRAN_INNER[idx];
          ctx.beginPath();
          ctx.arc(p.x, p.y, gr * 0.55, 0, TAU);
          ctx.fill();
          break;
        }

        /* ---- 日珥断裂段 ---- */
        case 'arcseg': {
          alpha = Math.pow(1 - lt, 1.1) * 0.9;
          // 品红 → 紫 → 淡青
          let tex;
          if (lt < 0.3) tex = TEX.magenta;
          else if (lt < 0.65) tex = TEX.purple;
          else tex = TEX.pale;
          const size = p.r * 7;
          ctx.globalAlpha = alpha;
          ctx.drawImage(tex, p.x - size / 2, p.y - size / 2, size, size);
          break;
        }

        /* ---- 磁场线段 ---- */
        case 'magseg': {
          alpha = (1 - lt) * 0.7;
          const tx = p.x - p.vx * 0.03;
          const ty = p.y - p.vy * 0.03;
          ctx.globalAlpha = alpha;
          ctx.strokeStyle = '#4FE3FF';
          ctx.lineWidth = p.r;
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          break;
        }

        /* ---- 闪光 ---- */
        case 'flash': {
          const u = lt;
          const r = lerp(p.a, p.b, u);
          const size = r * 5;
          ctx.globalAlpha = (1 - u) * 0.95;
          ctx.drawImage(TEX.white, p.x - size / 2, p.y - size / 2, size, size);
          break;
        }

        /* ---- 火花 ---- */
        case 'spark': {
          alpha = (1 - lt) * 0.95;
          const size = p.r * 6;
          ctx.globalAlpha = alpha;
          ctx.drawImage(p.tex, p.x - size / 2, p.y - size / 2, size, size);
          break;
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  /* ==================================================================
     渲染 —— 磁场线 / 残留 / 残影
     ================================================================== */
  _drawWeave(s) {
    const weave = s.weave;
    if (!weave.active) return;
    const ctx = s.ctx;
    const capT = CONFIG.WEAVE.captureTime;
    const fade = weave.t < capT ? 1 : Math.max(0, 1 - (weave.t - capT) / CONFIG.WEAVE.flowTime);

    for (let i = 0; i < weave.lines.length; i++) {
      const L = weave.lines[i];
      ctx.beginPath();
      for (let k = 0; k <= 16; k++) {
        const t = k / 16;
        const pt = bezPoint(L.x0, L.y0, L.cx, L.cy, L.x1, L.y1, t);
        if (k === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      }
      ctx.strokeStyle = rgba(79, 227, 255, 0.45 * fade);
      ctx.lineWidth = 1;
      ctx.stroke();

      // 轻微脉动
      ctx.strokeStyle = rgba(168, 232, 255, 0.18 * fade);
      ctx.lineWidth = 3.5;
      ctx.stroke();
    }
  }

  _drawResiduals(s) {
    const ctx = s.ctx;
    for (let i = 0; i < s.residuals.length; i++) {
      const r = s.residuals[i];
      const a = (1 - r.life / r.maxLife) * 0.2;
      ctx.beginPath();
      for (let k = 0; k <= 14; k++) {
        const t = k / 14;
        const pt = bezPoint(r.x0, r.y0, r.cx, r.cy, r.x1, r.y1, t);
        if (k === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      }
      ctx.strokeStyle = rgba(79, 227, 255, a);
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
  }

  _drawGhosts(s) {
    const ctx = s.ctx;
    for (let i = 0; i < s.ghosts.length; i++) {
      const g = s.ghosts[i];
      const u = g.life / g.maxLife;
      const r = lerp(g.r0, g.r1, u);
      const a = g.alpha0 * (1 - u);
      const size = r * 2;
      ctx.globalAlpha = a;
      ctx.drawImage(g.tex, g.x - size / 2, g.y - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
  }

  /* ==================================================================
     更新 / 渲染
     ================================================================== */
  update(dt, s) {
    if (!s) return;

    s.T += dt;

    this._updateTrail(s, dt);
    this._updateSun(s, dt);
    this._updateArcs(s, dt);
    this._updateGranules(s, dt);
    this._updateWeave(s, dt);
    this._updateParticles(s, dt);
  }

  render(s) {
    if (!s) return;
    const ctx = s.ctx;

    // 清屏：原型在这里铺了一层 #000 底色（它是整页背景动效，靠不透明画布承载底色）。
    // 移植成光标层后必须透明，只清除上一帧内容，绝不覆盖宿主页面。
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, s.W, s.H);

    // ---- 加法混合层 ----
    ctx.globalCompositeOperation = 'lighter';

    this._drawGhosts(s);
    this._drawCoronaAndHalo(s);
    this._drawWeave(s);
    this._drawResiduals(s);
    this._drawParticles(s);
    this._drawArcs(s);

    // ---- 太阳本体（不透明）----
    ctx.globalCompositeOperation = 'source-over';
    this._drawSunBody(s);

    // ---- 核心辉光 ----
    ctx.globalCompositeOperation = 'lighter';
    this._drawCoreGlow(s);

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}

if (!customElements.get('cursor-sun')) {
  customElements.define('cursor-sun', CursorSun);
}

export default CursorSun;
