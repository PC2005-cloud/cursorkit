/**
 * cursor-code —— 鼠标光标代码动效（左键编译语法树 / 右键崩溃堆栈）。
 *
 * 由 html/代码.html 原型移植：算法流程、数值、视觉表现与原文件一一对应。
 * 作为光标层组件，原型页面自身的行为已剔除：
 *   - 原型 render() 本身就是 clearRect 起手（深色底 #0B0E14 来自页面 body，不是画布铺底），
 *     移植后同样只清屏，绝不覆盖宿主页面；
 *   - 不拦截 contextmenu，宿主页面的右键菜单不受影响；
 *   - 画布创建、DPR 适配、尺寸同步、监听注册、rAF 循环
 *     以及「>300px 跳变归零 / 6000 封顶」全部由基类负责。
 *
 * 原型监听 mousemove / mousedown / mouseup，因此声明 inputFamily = 'mouse'。
 * 所有运行状态都放在 setup() 返回的 state 上，多实例互不干扰。
 */

import { CursorEffectElement } from '../core/base.js';
import { TAU, clamp, lerp, rand, randInt, mixColor } from '../core/utils.js';

/* =========================================================================
   CONFIG —— 全局参数集中管理
   ========================================================================= */
const CONFIG = {
  /* ---- 全局 ---- */
  maxParticles: 1200,        // 字符粒子对象池上限
  dprMax: 2,                 // 设备像素比上限（移植后由基类封顶，数值保持一致）
  fontFamily: "'Courier New', Consolas, Monaco, monospace",
  baseFont: 14,

  /* ---- 左键（编译）IDE 暗色主题配色 ---- */
  ideColors: ['#C792EA', '#C3E88D', '#F78C6C', '#82AAFF', '#546E7A', '#7AC8E0', '#FFFFFF'],
  ide: {
    keyword: '#C792EA', string: '#C3E88D', number: '#F78C6C',
    func: '#82AAFF', comment: '#546E7A', success: '#3DFF7A',
    binary: '#7AC8E0', white: '#FFFFFF'
  },

  /* ---- 右键（崩溃）错误色 ---- */
  errColors: ['#FFD24A', '#FF3D5A', '#FF0040', '#6A6A8A', '#FFFFFF'],
  err: {
    warn: '#FFD24A', error: '#FF3D5A', fatal: '#FF0040',
    stack: '#6A6A8A', panic: '#FFFFFF', core: '#0A0000'
  },

  /* ---- 字符集 ---- */
  sets: {
    lower: 'abcdefghijklmnopqrstuvwxyz',
    upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    digit: '0123456789',
    symbol: '{}()[]<>=+-*/;:.,!&|^%$#@?~_\\',
    binary: '01',
    err: '!@#$%^&*()_+{}|:"<>?'
  },

  /* ---- 拖尾 ---- */
  trail: {
    spacing: 13, sizeMin: 10, sizeMax: 16, lifeMin: 0.8, lifeMax: 1.5
  },

  /* ---- 单击 ---- */
  click: { typeMin: 8, typeMax: 14, typeDur: 0.30, hold: 0.30, fade: 0.30 },

  /* ---- 点击冲击：重排 Refactor ---- */
  refactor: { radius: 250, cellW: 11, cellH: 18 },

  /* ---- 编译（左键） ---- */
  compile: {
    chargeMax: 2.5, spawnInterval: 0.05, spawnMin: 1, spawnMax: 3,
    spawnRadiusMin: 60, spawnRadiusMax: 160,
    cols: 12, slotW: 11, slotH: 21, indentPerRow: 1.5,
    maxCodeChars: 140, treeMaxLevel: 5, treeMaxNodes: 82,
    treeRootLen: 72, treeLenDecay: 0.72, treeSpread: Math.PI / 6
  },

  /* ---- 崩溃（右键） ---- */
  crash: {
    chargeMax: 2.5, frameH: 22, frameWMin: 120, frameWMax: 180,
    maxFrames: 25, spawnInterval: 0.1, baseOffset: 90,
    burstGap: 0.03, coreW: 80, coreH: 60, coreLife: 1.5
  },

  /* ---- 通用阈值 ---- */
  clickThreshold: 0.12
};

/* =========================================================================
   基础工具（纯函数，无实例状态）
   ========================================================================= */
const pick = a => a[(Math.random() * a.length) | 0];
const easeOut = t => 1 - (1 - t) * (1 - t) * (1 - t);
const dist2 = (ax, ay, bx, by) => { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };

// hex → [r, g, b] 的记忆化缓存：纯查表，输出只由入参决定，多实例共享无副作用
const _rgbCache = Object.create(null);
function rgbOf(hex) {
  let v = _rgbCache[hex];
  if (!v) {
    const n = parseInt(hex.slice(1), 16);
    v = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    _rgbCache[hex] = v;
  }
  return v;
}

// 与原型的 mixHex 逐字对齐：两位颜色线性混合后截断取整，返回 rgb() 字符串
function mixHex(a, b, t) {
  const c = mixColor(rgbOf(a), rgbOf(b), t);
  return 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')';
}

const FONT_STR = 'bold ' + CONFIG.baseFont + 'px ' + CONFIG.fontFamily;

/* =========================================================================
   字符池（字符集 + 粒子对象池）
   ========================================================================= */
const CHAR_SETS = {
  lower: CONFIG.sets.lower.split(''),
  upper: CONFIG.sets.upper.split(''),
  digit: CONFIG.sets.digit.split(''),
  symbol: CONFIG.sets.symbol.split(''),
  binary: CONFIG.sets.binary.split(''),
  err: CONFIG.sets.err.split('')
};
CHAR_SETS.trail = CHAR_SETS.lower.concat(CHAR_SETS.upper, CHAR_SETS.digit, CHAR_SETS.symbol);
CHAR_SETS.compile = CHAR_SETS.lower.concat(CHAR_SETS.digit, CHAR_SETS.symbol);

const TREE_WORDS = ['if', 'for', 'fn', 'let', 'var', 'int', 'def', 'new', 'try', 'do', 'x', 'y', 'i', 'n', 'f', 'g', 'a', 'b', '0', '1', '[]', '{}', '()', '->', '=>', '&&', '||', '++', '--', '::', '#', '$', '*', '&', '?'];

const MODE_FREE = 0;
const MODE_BURST = 1;
const MODE_RECT = 2;
const MODE_LOG = 3;
const MODE_FROZEN = 4;

function createParticle() {
  return {
    active: false,
    mode: MODE_FREE,
    ch: 'a',
    x: 0, y: 0,
    vx: 0, vy: 0,
    rot: 0, vrot: 0,
    size: 14,
    color: '#FFFFFF',
    alpha: 1,
    life: 0, maxLife: 1,
    w: 8, h: 4,
    text: '',
    rf: false,
    rfStartX: 0, rfStartY: 0,
    rfSlotX: 0, rfSlotY: 0,
    frozenT: 0   // 冻结累计时长（安全超时用）
  };
}

/* =========================================================================
   堆栈系统用到的函数名
   ========================================================================= */
const FUNC_NAMES = ['main()', 'foo()', 'bar()', 'recurse()', 'process()', 'render()',
                    'update()', 'handle()', 'parse()', 'compile()', 'execute()',
                    'init()', 'draw()', 'loop()', 'exec()', 'walk()', 'eval()'];

function frameColor(r) {
  if (r < 0.34) return mixHex(CONFIG.err.stack, CONFIG.err.warn, r / 0.34);
  if (r < 0.67) return mixHex(CONFIG.err.warn, '#FF8C1A', (r - 0.34) / 0.33);
  return mixHex('#FF8C1A', CONFIG.err.error, (r - 0.67) / 0.33);
}

// 单击时打出的随机代码行
function randomCodeLine(n) {
  const tpl = [
    'const x = 42;', 'let y = 0;', 'if (a > b) {', 'return foo();',
    'for (i=0;i<n;i)', 'fn(x) => y;', 'var s = "hi";', 'x += 1;',
    'while (1) {', 'print(a[0]);', 'a.b.c = 1;', '} else {',
    'let t = new Map();', 'arr.map(f);'
  ];
  let s = pick(tpl);
  let guard = 0;
  while (s.length < n && guard++ < 6) s += pick(tpl);
  return s.slice(0, n).split('');
}

export class CursorCode extends CursorEffectElement {
  /** 主题光标：终端绿描边 + 墨点装饰 */
  cursorTheme() {
    return {
      edge: '#7cf29a',
      fill: 'rgba(8, 26, 16, .88)',
      glow: '#4ade80',
      deco: { color: [124, 242, 154], style: 'ink', rate: 13, speedGain: 0.2 }
    };
  }

  // 原型用的是 mousemove / mousedown / mouseup（不是 pointer 事件族），
  // 不声明这一行，基类会去监听 pointermove，动效将完全收不到鼠标输入。
  inputFamily = 'mouse';

  /* ==================================================================
     初始化
     ================================================================== */
  // 只建池与状态，不注册任何监听（监听、DPR 缩放、rAF 全归基类）
  setup({ ctx, width, height, input }) {
    // 与原型一致：初始光标位置取视口中心（原型 mouse.x/y 与 px/py 都取中心）。
    // 基类的 input 从 (0, 0) 起算，若不在这里对齐，首帧的位移会按「从左上角跳过来」计算，
    // 速度与拖尾生成量会和原型不同。
    input.x = input.lx = width * 0.5;
    input.y = input.ly = height * 0.5;

    // 原型的 resize() 会设置文本对齐方式；基类重设画布缓冲会清空上下文状态，
    // 所以这里与 onResize 都要写一次。
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // 字符粒子对象池
    const particles = [];
    const freeList = [];
    for (let i = 0; i < CONFIG.maxParticles; i++) {
      const p = createParticle();
      particles.push(p);
      freeList.push(p);
    }

    return {
      // 本实例的画布上下文（已按 DPR 缩放过，统一使用 CSS 像素坐标）
      ctx,

      // 画布尺寸（CSS 像素），由基类 onResize 同步
      W: width,
      H: height,

      input,

      // 全局时间（原型的 now，按 dt 累加）
      now: 0,

      // 拖尾累积距离
      trailAccum: 0,

      // 有效光标位置（含蓄力微震偏移）
      mx: width * 0.5,
      my: height * 0.5,

      // 粒子池：空闲表复用
      particles,
      freeList,

      // 编译（左键）
      compile: {
        armed: false, active: false, frozen: false, freezeT: 0, t: 0,
        chars: [], nodes: [], maxLevel: 0, spawnAcc: 0, charCount: 0, rot: 0,
        rootX: 0, rootY: 0
      },

      // 崩溃（右键）
      crash: {
        armed: false, active: false, frozen: false, freezeT: 0, t: 0,
        frames: [], spawnT: 0, baseX: 0, baseY: 0, memFill: 0.2
      },

      // 重排 / Refactor（点击冲击）
      refactor: {
        active: false, start: 0, list: [],
        cx: 0, cy: 0, foldX: 0, foldY: 0, bw: 0, bh: 0, guides: []
      },

      // Core Dump 乱码方块
      coreDump: {
        active: false, t: 0, x: 0, y: 0,
        life: CONFIG.crash.coreLife, cells: [], timer: 0
      },

      // 余韵（爆发后的持续输出）
      afterglow: { t: 0, acc: 0, small: true },

      // 单击打字机
      typewriter: null,

      // 光标竖线 / 残影
      carets: [],

      // 缩进波 / 冲击波
      waves: [],

      // 崩溃爆炸延迟队列
      crashBurstQueue: [],

      // 单击 / 蓄力的按住计时（原型 leftHold / rightHold）
      leftHold: 0,
      rightHold: 0
    };
  }

  /* ==================================================================
     粒子池
     ================================================================== */
  _spawnP(s) {
    return s.freeList.pop() || null;
  }

  _despawn(s, p) {
    if (!p.active) return;
    p.active = false;
    p.rf = false;
    p.frozenT = 0;
    s.freeList.push(p);
  }

  /* ==================================================================
     字符绘制
     ================================================================== */
  /**
   * 原型的 drawCharAt 用一次矩阵写入把 DPR、缩放、旋转、位移一并写死；
   * 移植后主画布的 DPR 变换由基类维护，这里改用 translate / rotate / scale 叠加，
   * 得到的设备变换与原型完全一致（DPR × 缩放 × 旋转 × 位移），
   * 又不会覆盖基类的变换。
   */
  _drawCharAt(s, ch, x, y, size, color, alpha, rot) {
    if (alpha <= 0.02 || !ch) return;
    const ctx = s.ctx;
    const k = size / CONFIG.baseFont;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(k, k);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.font = FONT_STR;
    ctx.fillText(ch, 0, 0);
    ctx.restore();
  }

  // 原型的变换复位函数会把 DPR 变换与 globalAlpha 一起复位。
  // 移植后变换由 save / restore 保证（永远停在基类的 DPR 变换上），这里只需复位透明度。
  _resetAlpha(s) {
    s.ctx.globalAlpha = 1;
  }

  /* ==================================================================
     拖尾系统
     ================================================================== */
  _spawnTrailChar(s, x, y) {
    const p = this._spawnP(s);
    if (!p) return;
    p.active = true;
    p.rf = false;
    p.frozenT = 0;
    p.mode = MODE_FREE;
    p.ch = pick(CHAR_SETS.trail);
    p.x = x + rand(-3, 3);
    p.y = y + rand(-3, 3);
    p.vx = rand(-22, 22);
    p.vy = rand(-45, -12);
    p.rot = rand(-0.35, 0.35);
    p.vrot = rand(-1.4, 1.4);
    p.size = rand(CONFIG.trail.sizeMin, CONFIG.trail.sizeMax);
    p.color = pick(CONFIG.ideColors);
    p.alpha = 1;
    p.life = 0;
    p.maxLife = rand(CONFIG.trail.lifeMin, CONFIG.trail.lifeMax);
  }

  _updateTrail(s) {
    const inp = s.input;
    const mdx = inp.x - inp.lx;
    const mdy = inp.y - inp.ly;
    const mdist = Math.hypot(mdx, mdy);
    if (mdist < 1.2) { s.trailAccum = 0; return; }

    s.trailAccum += mdist;
    const sp = CONFIG.trail.spacing;
    const n = Math.floor(s.trailAccum / sp);
    s.trailAccum -= n * sp;
    const count = Math.min(n, 10);

    for (let i = 0; i < count; i++) {
      const back = (count - i) * sp;
      const t = clamp(1 - back / mdist, 0, 1);
      const x = lerp(inp.lx, inp.x, t);
      const y = lerp(inp.ly, inp.y, t);
      this._spawnTrailChar(s, x, y);
    }
  }

  /* ==================================================================
     粒子更新（含冻结粒子安全超时释放）
     ================================================================== */
  _updateParticles(s, dt) {
    const particles = s.particles;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (!p.active) continue;

      /* 冻结粒子：由重排系统接管；加 2 秒安全超时防止僵尸残留 */
      if (p.mode === MODE_FROZEN) {
        p.frozenT += dt;
        if (p.frozenT < 2.0) continue;
        /* 超时释放成爆发态 */
        p.mode = MODE_BURST;
        p.rf = false;
        p.frozenT = 0;
        p.alpha = 1;
        p.life = 0;
        p.maxLife = rand(0.4, 0.7);
        const a = rand(0, TAU);
        const sp = rand(80, 200);
        p.vx = Math.cos(a) * sp;
        p.vy = Math.sin(a) * sp;
        p.vrot = rand(-5, 5);
        /* 继续走下面的更新逻辑 */
      }

      p.life += dt;
      if (p.life >= p.maxLife) { this._despawn(s, p); continue; }
      const lt = p.life / p.maxLife;

      if (p.mode === MODE_FREE) {
        p.y -= 18 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        const d = Math.pow(0.2, dt);
        p.vx *= d; p.vy *= d;
        p.rot += p.vrot * dt;
        p.alpha = 1 - lt * lt;
      } else if (p.mode === MODE_BURST) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        const d = Math.pow(0.05, dt);
        p.vx *= d; p.vy *= d;
        p.vy += 30 * dt;
        p.rot += p.vrot * dt;
        p.alpha = lt < 0.55 ? 1 : 1 - (lt - 0.55) / 0.45;
      } else if (p.mode === MODE_RECT) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        const d = Math.pow(0.18, dt);
        p.vx *= d; p.vy *= d;
        p.vy += 160 * dt;
        p.rot += p.vrot * dt;
        p.alpha = 1 - lt;
      } else if (p.mode === MODE_LOG) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        const d = Math.pow(0.35, dt);
        p.vx *= d; p.vy *= d;
        p.alpha = lt < 0.6 ? 1 : 1 - (lt - 0.6) / 0.4;
      }
    }
  }

  /* ==================================================================
     语法树系统（左键核心）
     ================================================================== */
  _startCompile(s) {
    const c = s.compile;
    c.active = true;
    c.frozen = false;
    c.t = 0;
    c.chars.length = 0;
    c.nodes.length = 0;
    c.maxLevel = 0;
    c.spawnAcc = 0;
    c.charCount = 0;
    c.rot = 0;
    c.rootX = s.mx;
    c.rootY = s.my;
    c.nodes.push({
      ax: 0, ay: -30, pax: 0, pay: 0,
      ch: pick(TREE_WORDS),
      color: CONFIG.ide.func,
      size: 15, level: 0, angle: -Math.PI / 2,
      len: CONFIG.compile.treeRootLen,
      born: s.now, parent: -1, leaf: true,
      seed: Math.random() * 10, wx: s.mx, wy: s.my - 30
    });
  }

  _slotPos(s, idx) {
    const C = CONFIG.compile;
    const row = Math.floor(idx / C.cols);
    const col = idx % C.cols;
    const indent = Math.min(row, 6) * C.indentPerRow;
    return {
      x: s.mx - 88 + (col + indent) * C.slotW,
      y: s.my + 34 + row * C.slotH
    };
  }

  _spawnCompileChar(s) {
    const C = CONFIG.compile;
    const c = s.compile;
    const idx = c.charCount++;
    const ang = Math.random() * TAU;
    const dist = rand(C.spawnRadiusMin, C.spawnRadiusMax);
    const slot = this._slotPos(s, idx);
    c.chars.push({
      idx: idx, ch: pick(CHAR_SETS.compile),
      color: pick(CONFIG.ideColors),
      x: s.mx + Math.cos(ang) * dist,
      y: s.my + Math.sin(ang) * dist,
      tx: slot.x, ty: slot.y,
      rot: rand(-Math.PI, Math.PI),
      size: rand(10, 16), alpha: 0, age: 0
    });
  }

  _growLevel(s, level) {
    const C = CONFIG.compile;
    const nodes = s.compile.nodes;
    const len0 = nodes.length;
    for (let i = 0; i < len0; i++) {
      const p = nodes[i];
      if (p.level !== level - 1) continue;
      p.leaf = false;
      const n = randInt(2, 3);
      for (let j = 0; j < n; j++) {
        if (nodes.length >= C.treeMaxNodes) break;
        const a = p.angle + (n > 1 ? (j - (n - 1) / 2) * (C.treeSpread * 2) / (n - 1) : 0);
        const len = p.len * C.treeLenDecay;
        const ox = Math.cos(a) * len;
        const oy = Math.sin(a) * len;
        nodes.push({
          ax: p.ax + ox, ay: p.ay + oy,
          pax: p.ax, pay: p.ay,
          ch: pick(TREE_WORDS),
          color: pick(CONFIG.ideColors),
          size: rand(12, 16), level: level, angle: a, len: len,
          born: s.now, parent: i, leaf: true,
          seed: Math.random() * 10, wx: 0, wy: 0
        });
      }
    }
  }

  _updateCompile(s, dt) {
    const c = s.compile;
    if (!c.active) return;

    if (c.frozen) {
      c.freezeT -= dt;
      if (c.freezeT <= 0) this._doCompileBurst(s);
      return;
    }

    c.t += dt;
    const t = c.t;
    c.rootX = s.mx;
    c.rootY = s.my;

    c.spawnAcc += dt;
    const si = CONFIG.compile.spawnInterval;
    while (c.spawnAcc >= si) {
      c.spawnAcc -= si;
      if (c.charCount >= CONFIG.compile.maxCodeChars) break;
      const n = randInt(CONFIG.compile.spawnMin, CONFIG.compile.spawnMax);
      for (let i = 0; i < n && c.charCount < CONFIG.compile.maxCodeChars; i++) {
        this._spawnCompileChar(s);
      }
    }

    const k = 1 - Math.pow(0.0015, dt);
    for (let i = 0; i < c.chars.length; i++) {
      const ch = c.chars[i];
      ch.age += dt;
      const slot = this._slotPos(s, ch.idx);
      ch.tx = slot.x; ch.ty = slot.y;
      ch.x = lerp(ch.x, ch.tx, k);
      ch.y = lerp(ch.y, ch.ty, k);
      ch.rot *= Math.pow(0.01, dt);
      ch.alpha = Math.min(1, ch.age * 6);
    }

    if (t > 1.0) {
      const target = clamp(Math.floor((t - 1.0) / 0.2) + 1, 1, CONFIG.compile.treeMaxLevel);
      while (c.maxLevel < target) {
        c.maxLevel++;
        this._growLevel(s, c.maxLevel);
      }
    }

    c.rot += 0.15 * dt;
  }

  _compilePulse(s) {
    return clamp((s.compile.t - 2.0) / 0.3, 0, 1);
  }

  _drawTree(s) {
    const ctx = s.ctx;
    const c = s.compile;
    const nodes = c.nodes;
    if (!nodes.length) return;
    const rot = c.rot;
    const cosR = Math.cos(rot), sinR = Math.sin(rot);
    const cx = s.mx, cy = s.my;
    const pulse = this._compilePulse(s);
    const successOn = c.t > 1.95;

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const k = easeOut(clamp((s.now - n.born) / 0.18, 0, 1));
      const rx = lerp(n.pax, n.ax, k);
      const ry = lerp(n.pay, n.ay, k);
      n.wx = cx + rx * cosR - ry * sinR;
      n.wy = cy + rx * sinR + ry * cosR;
    }

    if (successOn) {
      this._resetAlpha(s);
      const g = ctx.createRadialGradient(cx, cy - 90, 8, cx, cy - 90, 190);
      g.addColorStop(0, 'rgba(61,255,122,0.14)');
      g.addColorStop(0.6, 'rgba(61,255,122,0.05)');
      g.addColorStop(1, 'rgba(61,255,122,0)');
      ctx.fillStyle = g;
      ctx.fillRect(cx - 220, cy - 300, 440, 400);
    }

    this._resetAlpha(s);
    ctx.lineWidth = 1;
    for (let i = 1; i < nodes.length; i++) {
      const n = nodes[i];
      const p = nodes[n.parent];
      const k = clamp((s.now - n.born) / 0.18, 0, 1);
      if (k <= 0) continue;
      const lit = pulse > 0 && (n.level / CONFIG.compile.treeMaxLevel) <= pulse;
      ctx.globalAlpha = (lit ? 0.85 : 0.30) * k;
      ctx.strokeStyle = lit ? CONFIG.ide.success : (successOn ? mixHex('#546E7A', '#3DFF7A', 0.4) : CONFIG.ide.comment);
      ctx.beginPath();
      ctx.moveTo(p.wx, p.wy);
      ctx.lineTo(n.wx, n.wy);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const k = easeOut(clamp((s.now - n.born) / 0.18, 0, 1));
      if (k <= 0.02) continue;
      const lit = pulse > 0 && (n.level / CONFIG.compile.treeMaxLevel) <= pulse;

      this._resetAlpha(s);
      ctx.globalAlpha = 0.9 * k;
      ctx.fillStyle = lit ? CONFIG.ide.success : n.color;
      ctx.beginPath();
      ctx.arc(n.wx, n.wy, 1.8, 0, TAU);
      ctx.fill();

      let ch = n.ch;
      let col = lit ? CONFIG.ide.success : n.color;
      if (n.leaf && c.t > 2.0) {
        const phase = Math.floor(s.now * 5 + n.seed) % 2;
        if (phase === 0) {
          ch = Math.random() < 0.5 ? '0' : '1';
          col = CONFIG.ide.binary;
        }
      }
      this._drawCharAt(s, ch, n.wx, n.wy, n.size, col, k, 0);
    }

    if (c.t > 2.3 && nodes.length > 1) {
      let top = nodes[0];
      for (let i = 1; i < nodes.length; i++) if (nodes[i].wy < top.wy) top = nodes[i];
      const pr = 5 + Math.sin(s.now * 6) * 2;
      this._resetAlpha(s);
      const g2 = ctx.createRadialGradient(top.wx, top.wy, 0, top.wx, top.wy, pr * 3);
      g2.addColorStop(0, 'rgba(61,255,122,1)');
      g2.addColorStop(0.4, 'rgba(61,255,122,0.5)');
      g2.addColorStop(1, 'rgba(61,255,122,0)');
      ctx.fillStyle = g2;
      ctx.beginPath();
      ctx.arc(top.wx, top.wy, pr * 3, 0, TAU);
      ctx.fill();
    }
  }

  _drawCodeLines(s) {
    const c = s.compile;
    const successOn = c.t > 1.95;
    const pulse = this._compilePulse(s);
    for (let i = 0; i < c.chars.length; i++) {
      const ch = c.chars[i];
      const lit = successOn && (ch.idx % 12) / 12 <= pulse;
      this._drawCharAt(s, ch.ch, ch.x, ch.y, ch.size, lit ? CONFIG.ide.success : ch.color, ch.alpha, ch.rot);
    }
  }

  /* ==================================================================
     堆栈系统（右键核心）
     ================================================================== */
  _startCrash(s) {
    const c = s.crash;
    c.active = true;
    c.frozen = false;
    c.t = 0;
    c.frames.length = 0;
    c.spawnT = 0;
    c.baseX = s.mx;
    c.baseY = s.my + CONFIG.crash.baseOffset;
    c.memFill = 0.2;
    this._addFrame(s);
  }

  _addFrame(s) {
    const C = CONFIG.crash;
    const c = s.crash;
    const i = c.frames.length;
    const ratio = clamp(i / (C.maxFrames - 1), 0, 1);
    c.frames.push({
      name: pick(FUNC_NAMES), line: randInt(1, 240),
      w: lerp(C.frameWMax, C.frameWMin, ratio),
      color: frameColor(ratio), born: s.now, ratio: ratio
    });
  }

  _updateCrash(s, dt) {
    const c = s.crash;
    if (!c.active) return;
    if (c.frozen) {
      c.freezeT -= dt;
      if (c.freezeT <= 0) this._doCrashBurst(s);
      return;
    }
    c.t += dt;
    const t = c.t;
    const ratio = clamp(t / CONFIG.crash.chargeMax, 0, 1);
    c.baseX = lerp(c.baseX, s.mx, 1 - Math.pow(0.02, dt));
    c.baseY = s.my + CONFIG.crash.baseOffset;

    c.spawnT -= dt;
    if (c.spawnT <= 0 && c.frames.length < CONFIG.crash.maxFrames) {
      c.spawnT = CONFIG.crash.spawnInterval;
      this._addFrame(s);
    }
    c.memFill = lerp(0.2, 1.0, ratio);
  }

  _drawCrash(s) {
    const ctx = s.ctx;
    const c = s.crash;
    const frames = c.frames;
    const n = frames.length;
    if (!n) return;
    const C = CONFIG.crash;
    const h = C.frameH;
    const bx = c.baseX;
    const by = c.baseY;
    const t = c.t;
    const flashing = t > 2.0 && Math.floor(t * 6.5) % 2 === 0;

    for (let i = 0; i < n; i++) {
      const f = frames[i];
      const topness = n > 1 ? i / (n - 1) : 0;
      const y = by - (i + 1) * h;
      const shakeAmp = topness * topness * (0.6 + t * 1.6);
      const jx = (Math.random() - 0.5) * shakeAmp * 3;
      const jy = (Math.random() - 0.5) * shakeAmp * 4;
      const x = bx - f.w / 2 + jx;
      const yy = y + jy;
      const grow = clamp((s.now - f.born) / 0.08, 0, 1);

      this._resetAlpha(s);
      const col = flashing ? CONFIG.err.fatal : f.color;

      ctx.globalAlpha = 0.10 * grow;
      ctx.fillStyle = col;
      ctx.fillRect(x, yy, f.w * grow, h);

      ctx.globalAlpha = 0.95 * grow;
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, yy + 0.5, f.w - 1, h - 1);

      if (grow > 0.6) {
        const a = (grow - 0.6) / 0.4;
        ctx.globalAlpha = a;
        ctx.font = 'bold 12px ' + CONFIG.fontFamily;
        ctx.fillStyle = col;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        let name = f.name;
        let line = f.line;
        if (i >= n - 1 && t > 1.5) {
          if (Math.floor(t * 20) % 2 === 0) name = pick(FUNC_NAMES);
          line = f.line + Math.floor((t - 1.5) * 60);
        }
        ctx.fillText(name, x + 8, yy + h / 2);
        ctx.textAlign = 'right';
        ctx.fillText(':' + line, x + f.w - 8, yy + h / 2);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
      }

      if (t > 2.0 && i >= n - 4) {
        this._resetAlpha(s);
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = CONFIG.err.fatal;
        ctx.lineWidth = 1;
        for (let k = 0; k < 2; k++) {
          ctx.beginPath();
          const sx = x + rand(4, f.w - 4);
          ctx.moveTo(sx, yy + 2);
          ctx.lineTo(sx + rand(-6, 6), yy + h - 2);
          ctx.stroke();
        }
      }
    }

    if (t > 1.4) {
      const crackP = clamp((t - 1.4) / 1.0, 0, 1);
      this._resetAlpha(s);
      ctx.strokeStyle = CONFIG.err.error;
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.6 * crackP;
      for (let i = 0; i < n; i++) {
        if (Math.random() > crackP * 0.55) continue;
        const y = by - i * h;
        const x0 = bx + rand(-62, 62);
        const len = rand(5, 20);
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x0 + len * (Math.random() < 0.5 ? -1 : 1), y + rand(-3, 3));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    const totalH = n * h;
    const maxW = C.frameWMax;
    const mbX = bx + maxW / 2 + 16;
    this._resetAlpha(s);
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.fillRect(mbX, by - totalH, 6, totalH);
    const fillH = totalH * c.memFill;
    const grad = ctx.createLinearGradient(mbX, by, mbX, by - totalH);
    grad.addColorStop(0, '#3DFF7A');
    grad.addColorStop(0.5, '#FFD24A');
    grad.addColorStop(1, '#FF3D5A');
    ctx.fillStyle = grad;
    ctx.fillRect(mbX, by - fillH, 6, fillH);
    ctx.globalAlpha = 1;

    if (t > 1.5 && Math.random() < clamp((t - 1.5) / 1.0, 0, 1) * 0.35) {
      const idx = randInt(0, n - 1);
      const f = frames[idx];
      const side = Math.random() < 0.5 ? -1 : 1;
      const lx = bx + side * f.w / 2;
      const ly = by - (idx + 0.5) * h;
      const p = this._spawnP(s);
      if (p) {
        p.active = true; p.rf = false; p.frozenT = 0;
        p.mode = MODE_BURST;
        p.ch = Math.random() < 0.5 ? (Math.random() < 0.5 ? '0' : '1') : pick(CHAR_SETS.err);
        p.color = pick(CONFIG.errColors);
        p.x = lx; p.y = ly;
        p.vx = side * rand(30, 80);
        p.vy = rand(-40, 40);
        p.size = rand(9, 13);
        p.alpha = 1; p.life = 0; p.maxLife = rand(0.4, 0.7);
        p.rot = 0; p.vrot = rand(-3, 3);
      }
    }

    if (t > 2.0 && Math.floor(t * 8) % 2 === 0) {
      this._drawCharAt(s, '!', bx, by - n * h - 18, 20, CONFIG.err.fatal, 1, 0);
    }
  }

  /* ==================================================================
     重排 / Refactor（点击冲击）
     ================================================================== */
  /* 强制收尾：把当前冻结的粒子全部转为爆发态，避免僵尸残留 */
  _forceEndRefactor(s) {
    const r = s.refactor;
    if (!r.active) return;
    const list = r.list;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p.active) continue;
      p.mode = MODE_BURST;
      p.rf = false;
      p.frozenT = 0;
      p.alpha = 1;
      p.life = 0;
      p.maxLife = rand(0.35, 0.65);
      const a = rand(0, TAU);
      const sp = rand(100, 280);
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp;
      p.vrot = rand(-6, 6);
    }
    r.list = [];
    r.active = false;
  }

  _startRefactor(s, cx, cy) {
    const r = s.refactor;

    /* ★ 关键修复：若上一次重排尚未结束，先强制收尾，释放所有冻结粒子 */
    if (r.active) this._forceEndRefactor(s);

    const R2 = CONFIG.refactor.radius * CONFIG.refactor.radius;
    const list = [];
    const particles = s.particles;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (!p.active || p.mode !== MODE_FREE) continue;
      if (dist2(p.x, p.y, cx, cy) < R2) list.push(p);
    }
    if (list.length < 4) return;

    const n = list.length;
    const cols = Math.min(16, Math.max(4, Math.ceil(Math.sqrt(n * 2.6))));
    const rows = Math.ceil(n / cols);
    const cw = CONFIG.refactor.cellW;
    const chh = CONFIG.refactor.cellH;
    const bw = cols * cw;
    const bh = rows * chh;
    const left = cx - bw / 2;
    const top = cy - bh / 2;

    for (let i = 0; i < n; i++) {
      const p = list[i];
      const row = Math.floor(i / cols);
      const col = i % cols;
      p.rf = true;
      p.mode = MODE_FROZEN;
      p.frozenT = 0;
      p.alpha = 1;
      p.rfStartX = p.x;
      p.rfStartY = p.y;
      p.rfSlotX = left + col * cw + cw / 2;
      p.rfSlotY = top + row * chh + chh / 2;
    }

    r.active = true;
    r.start = s.now;
    r.cx = cx;
    r.cy = cy;
    r.bw = bw;
    r.bh = bh;
    r.foldX = cx;
    r.foldY = top + chh / 2;
    r.list = list;

    r.guides = [];
    const gn = randInt(3, 5);
    for (let i = 0; i < gn; i++) {
      r.guides.push({
        x: left + (i + 1) * 2.4 * cw * 0.5,
        y0: top, y1: top + bh, born: s.now
      });
    }
  }

  _updateRefactor(s, dt) {
    const r = s.refactor;
    if (!r.active) return;
    const el = s.now - r.start;
    const list = r.list;

    const T_GATHER = 0.20;
    const T_FLASH  = T_GATHER + 0.08;
    const T_HOLD   = T_FLASH + 0.05;
    const T_FOLD   = T_HOLD + 0.15;
    const T_BOOM   = T_FOLD + 0.10;

    if (el < T_GATHER) {
      const k = easeOut(clamp(el / 0.20, 0, 1));
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        p.x = lerp(p.rfStartX, p.rfSlotX, k);
        p.y = lerp(p.rfStartY, p.rfSlotY, k);
        p.rot = lerp(p.rot, 0, k);
        p.alpha = 1;
      }
    } else if (el < T_FLASH) {
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        p.x = p.rfSlotX; p.y = p.rfSlotY;
        p.color = CONFIG.ide.white;
        p.rot = 0;
        p.alpha = 1;
      }
    } else if (el < T_HOLD) {
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        p.x = p.rfSlotX; p.y = p.rfSlotY;
        p.alpha = 1;
      }
    } else if (el < T_FOLD) {
      const k = easeOut((el - T_HOLD) / 0.15);
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        p.x = lerp(p.rfSlotX, r.foldX, k);
        p.y = lerp(p.rfSlotY, r.foldY, k);
        p.size = lerp(p.size, 8, k);
        p.alpha = 1 - k * 0.65;
      }
    } else if (el < T_BOOM) {
      for (let i = 0; i < list.length; i++) {
        list[i].alpha = 1 - (el - T_FOLD) / 0.10;
      }
    } else {
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        p.mode = MODE_BURST;
        p.rf = false;
        p.frozenT = 0;
        p.alpha = 1;
        p.life = 0;
        p.maxLife = rand(0.45, 0.85);
        const a = Math.atan2(p.y - r.foldY, p.x - r.foldX) + rand(-0.5, 0.5);
        const sp = rand(120, 330);
        p.vx = Math.cos(a) * sp;
        p.vy = Math.sin(a) * sp;
        p.vrot = rand(-8, 8);
      }
      for (let i = 0; i < randInt(8, 12); i++) {
        this._spawnBurst(s, r.foldX, r.foldY, rand(0, TAU), rand(90, 280),
          pick(CHAR_SETS.compile), pick(CONFIG.ideColors), rand(10, 14));
      }
      r.active = false;
      r.list = [];
    }
  }

  _drawRefactorGuides(s) {
    const r = s.refactor;
    if (!r.active) return;
    const ctx = s.ctx;
    const el = s.now - r.start;
    if (el > 0.35) return;
    this._resetAlpha(s);
    ctx.lineWidth = 1;
    ctx.strokeStyle = CONFIG.ide.comment;
    ctx.globalAlpha = 0.5 * (1 - el / 0.35);
    for (let i = 0; i < r.guides.length; i++) {
      const g = r.guides[i];
      ctx.beginPath();
      ctx.moveTo(g.x, g.y0);
      ctx.lineTo(g.x, g.y1);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /* ==================================================================
     爆发：通用生成
     ================================================================== */
  _spawnBurst(s, x, y, ang, speed, ch, color, size) {
    const p = this._spawnP(s);
    if (!p) return;
    p.active = true;
    p.rf = false;
    p.frozenT = 0;
    p.mode = MODE_BURST;
    p.ch = ch;
    p.color = color;
    p.x = x; p.y = y;
    const sp = speed * rand(0.8, 1.2);
    p.vx = Math.cos(ang) * sp;
    p.vy = Math.sin(ang) * sp;
    p.rot = rand(-0.6, 0.6);
    p.vrot = rand(-7, 7);
    p.size = size || rand(12, 18);
    p.alpha = 1;
    p.life = 0;
    p.maxLife = rand(0.6, 1.2);
  }

  /* 光标竖线 / 残影 */
  _spawnCaret(s, x, y, color, life, h) {
    s.carets.push({ x: x, y: y, color: color, life: life, maxLife: life, h: h || 18, t: 0 });
  }

  _updateCarets(s, dt) {
    const carets = s.carets;
    for (let i = carets.length - 1; i >= 0; i--) {
      const c = carets[i];
      c.t += dt;
      c.life -= dt;
      if (c.life <= 0) carets.splice(i, 1);
    }
  }

  _drawCarets(s) {
    const ctx = s.ctx;
    this._resetAlpha(s);
    for (let i = 0; i < s.carets.length; i++) {
      const c = s.carets[i];
      const blink = Math.sin(c.t * 4 * Math.PI) > -0.2;
      if (!blink) continue;
      ctx.globalAlpha = clamp(c.life / c.maxLife, 0, 1);
      ctx.fillStyle = c.color;
      ctx.fillRect(c.x - 1, c.y - c.h / 2, 2, c.h);
    }
    ctx.globalAlpha = 1;
  }

  /* 缩进波 / 冲击波 */
  _spawnIndentWaves(s, cx, cy, power) {
    const n = randInt(3, 5);
    for (let i = 0; i < n; i++) {
      s.waves.push({
        type: 'indent', x: cx, y: cy + 30 - i * 14,
        w: 40 + i * 22, t: 0, life: 0.4, delay: i * 0.04
      });
    }
  }

  _updateWaves(s, dt) {
    const waves = s.waves;
    for (let i = waves.length - 1; i >= 0; i--) {
      const w = waves[i];
      w.t += dt;
      if (w.t >= w.life + w.delay) waves.splice(i, 1);
    }
  }

  _drawWaves(s) {
    const ctx = s.ctx;
    this._resetAlpha(s);
    for (let i = 0; i < s.waves.length; i++) {
      const w = s.waves[i];
      if (w.type !== 'indent') continue;
      if (w.t < w.delay) continue;
      const k = (w.t - w.delay) / w.life;
      ctx.globalAlpha = 0.4 * (1 - k);
      ctx.strokeStyle = CONFIG.ide.success;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(w.x - w.w / 2, w.y - k * 20);
      ctx.lineTo(w.x + w.w / 2, w.y - k * 20);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /* 二进制绿光波 */
  _spawnBinaryRing(s, cx, cy, maxR, power) {
    const count = 40 + Math.floor(power * 60);
    const speed = maxR / 0.5;
    for (let i = 0; i < count; i++) {
      const p = this._spawnP(s);
      if (!p) return;
      const a = (i / count) * TAU + rand(-0.06, 0.06);
      p.active = true;
      p.rf = false;
      p.frozenT = 0;
      p.mode = MODE_BURST;
      p.ch = Math.random() < 0.5 ? '0' : '1';
      p.color = CONFIG.ide.success;
      p.x = cx; p.y = cy;
      p.vx = Math.cos(a) * speed;
      p.vy = Math.sin(a) * speed;
      p.size = rand(10, 14);
      p.alpha = 1;
      p.life = 0;
      p.maxLife = 0.5;
      p.rot = rand(0, TAU);
      p.vrot = rand(-3, 3);
    }
  }

  /* ==================================================================
     交互：单击（打字机 + 光标 + 重排）
     ================================================================== */
  _startTypewriter(s, x, y) {
    const n = randInt(CONFIG.click.typeMin, CONFIG.click.typeMax);
    const text = randomCodeLine(n);
    const chars = [];
    for (let i = 0; i < n; i++) {
      chars.push({
        ch: text[i],
        color: pick(CONFIG.ideColors),
        x: x + 12 + i * 11,
        y: y + 18,
        showAt: s.now + (i / n) * CONFIG.click.typeDur,
        size: 14, i: i
      });
    }
    s.typewriter = {
      chars: chars,
      start: s.now,
      end: s.now + CONFIG.click.typeDur + CONFIG.click.hold + CONFIG.click.fade + 0.1,
      enterAt: s.now + CONFIG.click.typeDur,
      enterShown: false, x: x, y: y
    };
  }

  _updateTypewriter(s) {
    if (!s.typewriter) return;
    if (s.now > s.typewriter.end) s.typewriter = null;
  }

  _drawTypewriter(s) {
    const tw = s.typewriter;
    if (!tw) return;
    const total = tw.chars.length;
    for (let i = 0; i < total; i++) {
      const c = tw.chars[i];
      if (s.now < c.showAt) continue;
      const appear = clamp((s.now - c.showAt) * 30, 0, 1);
      const fadeStart = tw.start + CONFIG.click.typeDur + CONFIG.click.hold + i * (CONFIG.click.fade / total);
      let alpha = appear;
      let yOff = 0;
      if (s.now > fadeStart) {
        const k = clamp((s.now - fadeStart) / CONFIG.click.fade, 0, 1);
        alpha = appear * (1 - k);
        yOff = -k * 22;
      }
      this._drawCharAt(s, c.ch, c.x, c.y + yOff, c.size, c.color, alpha, 0);
    }
    const enterT = s.now - tw.enterAt;
    if (enterT > 0 && enterT < 0.2) {
      this._drawCharAt(s, '↵', tw.x + 14 + total * 11, tw.y + 18, 14, CONFIG.ide.comment, 1 - enterT / 0.2, 0);
    }
  }

  /* ==================================================================
     交互：左键 —— 编译
     ================================================================== */
  _doCompileBurst(s) {
    const c = s.compile;
    const power = Math.pow(clamp(c.t, 0, CONFIG.compile.chargeMax) / CONFIG.compile.chargeMax, 1.6);
    const cx = s.mx, cy = s.my;

    const cosR = Math.cos(c.rot), sinR = Math.sin(c.rot);
    for (let i = 0; i < c.nodes.length; i++) {
      const n = c.nodes[i];
      n.wx = cx + n.ax * cosR - n.ay * sinR;
      n.wy = cy + n.ax * sinR + n.ay * cosR;
    }

    const speedBase = 400 + 1000 * power;

    for (let i = 0; i < c.nodes.length; i++) {
      const n = c.nodes[i];
      const a = Math.atan2(n.wy - cy, n.wx - cx) + rand(-0.12, 0.12);
      this._spawnBurst(s, n.wx, n.wy, a, speedBase, Math.random() < 0.5 ? '0' : '1', CONFIG.ide.binary, n.size);
    }
    for (let i = 0; i < c.chars.length; i++) {
      const ch = c.chars[i];
      const a = Math.atan2(ch.y - cy, ch.x - cx) + rand(-0.12, 0.12);
      this._spawnBurst(s, ch.x, ch.y, a, speedBase, Math.random() < 0.5 ? '0' : '1', CONFIG.ide.binary, ch.size);
    }

    for (let i = 0; i < 18; i++) {
      const a = rand(0, TAU);
      const r = rand(0, 40);
      this._spawnBurst(s, cx + Math.cos(a) * r, cy + Math.sin(a) * r, a, rand(150, 400),
        Math.random() < 0.5 ? '0' : '1', CONFIG.ide.white, rand(14, 20));
    }

    this._spawnBinaryRing(s, cx, cy, 150 + 400 * power, power);
    this._spawnIndentWaves(s, cx, cy, power);
    this._spawnCaret(s, cx, cy, CONFIG.ide.success, 0.6, 20);

    s.afterglow.t = 1.5;
    s.afterglow.acc = 0;
    s.afterglow.small = true;

    c.active = false;
    c.frozen = false;
    c.nodes.length = 0;
    c.chars.length = 0;
  }

  /* ==================================================================
     交互：右键 —— 崩溃
     ================================================================== */
  _explodeAt(s, x, y, w, color, name) {
    const ctx = s.ctx;
    const cx = x;
    const cy = y;

    const pieces = randInt(4, 6);
    for (let i = 0; i < pieces; i++) {
      const p = this._spawnP(s);
      if (!p) break;
      p.active = true; p.rf = false; p.frozenT = 0;
      p.mode = MODE_RECT;
      p.x = cx + rand(-w / 3, w / 3);
      p.y = cy + rand(-6, 6);
      const a = rand(0, TAU);
      const sp = rand(80, 300);
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp - 60;
      p.rot = rand(0, TAU);
      p.vrot = rand(-9, 9);
      p.color = color;
      p.alpha = 1;
      p.life = 0;
      p.maxLife = rand(0.5, 0.9);
      p.w = rand(6, 14);
      p.h = rand(3, 6);
      // 修复原型的池复用脏值：render 里 MODE_RECT 用 size / baseFont 作为缩放系数，
      // 但原型这个生成点唯独没给 size 赋值，碎片会继承上一位使用者的字号，
      // 矩形大小随池历史漂移（干净池下构造函数默认 size = baseFont，即缩放 1:1）。
      p.size = CONFIG.baseFont;
    }

    const chars = randInt(6, 10);
    const src = name || 'main()';
    for (let i = 0; i < chars; i++) {
      const a = rand(0, TAU);
      this._spawnBurst(s, cx, cy, a, rand(300, 700),
        src[i % src.length], CONFIG.err.error, rand(12, 16));
    }

    this._resetAlpha(s);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rand(8, 15));
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.5, 'rgba(255,61,90,0.5)');
    g.addColorStop(1, 'rgba(255,61,90,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, 15, 0, TAU);
    ctx.fill();

    for (let i = 0; i < randInt(3, 5); i++) {
      this._spawnBurst(s, cx, cy, rand(0, TAU), rand(200, 520),
        pick(CHAR_SETS.err), pick(CONFIG.errColors), rand(10, 14));
    }

    if (Math.random() < 0.3) {
      const p = this._spawnP(s);
      if (p) {
        p.active = true; p.rf = false; p.frozenT = 0;
        p.mode = MODE_LOG;
        p.text = pick([
          'Error: stack overflow at line ' + randInt(1, 999),
          'panic: goroutine stack exceeds limit',
          'Segmentation fault (core dumped)',
          'Uncaught RangeError: Maximum call stack',
          'FATAL: recursion depth exceeded'
        ]);
        p.x = cx; p.y = cy;
        p.vx = rand(-60, 60);
        p.vy = rand(-120, -40);
        p.alpha = 1;
        p.life = 0;
        p.maxLife = 0.3;
        p.color = CONFIG.err.error;
        p.size = 11;
      }
    }
  }

  _doCrashBurst(s) {
    const c = s.crash;
    const power = Math.pow(clamp(c.t, 0, CONFIG.crash.chargeMax) / CONFIG.crash.chargeMax, 1.6);
    const frames = c.frames;
    const n = frames.length;
    const baseX = c.baseX;
    const baseY = c.baseY;
    const h = CONFIG.crash.frameH;

    if (n > 0) {
      const y = baseY - n * h + h / 2;
      this._spawnBurst(s, baseX, y - 40, -Math.PI / 2, rand(200, 400), '!', CONFIG.err.panic, 20);
      for (let i = 0; i < randInt(6, 10); i++) {
        this._spawnBurst(s, baseX, y - 40, rand(-Math.PI, 0), rand(200, 500),
          pick(CHAR_SETS.err), CONFIG.err.error, rand(12, 18));
      }
    }

    for (let i = n - 1; i >= 0; i--) {
      const f = frames[i];
      const y = baseY - (i + 0.5) * h;
      s.crashBurstQueue.push({
        x: baseX, y: y, w: f.w, color: f.color, name: f.name,
        delay: (n - 1 - i) * CONFIG.crash.burstGap, t: 0, done: false
      });
    }

    const waveCount = randInt(1, 2);
    for (let i = 0; i < waveCount; i++) {
      s.waves.push({
        type: 'ring', x: baseX, y: baseY, r: 0,
        maxR: 150 + 400 * power, t: 0, life: 0.5, delay: i * 0.08
      });
    }

    this._spawnCoreDump(s, baseX, baseY - 30);

    s.afterglow.t = 1.5;
    s.afterglow.acc = 0;
    s.afterglow.small = false;

    c.active = false;
    c.frozen = false;
    c.frames.length = 0;
  }

  _updateCrashBurstQueue(s, dt) {
    const queue = s.crashBurstQueue;
    for (let i = queue.length - 1; i >= 0; i--) {
      const q = queue[i];
      q.t += dt;
      if (!q.done && q.t >= q.delay) {
        q.done = true;
        this._explodeAt(s, q.x, q.y, q.w, q.color, q.name);
      }
      if (q.t > 2) queue.splice(i, 1);
    }
  }

  /* ==================================================================
     Core Dump 乱码方块
     ================================================================== */
  _spawnCoreDump(s, x, y) {
    const cd = s.coreDump;
    cd.active = true;
    cd.t = 0;
    cd.x = x;
    cd.y = y;
    cd.cells = [];
    for (let r = 0; r < 6; r++) {
      const row = [];
      for (let col = 0; col < 9; col++) row.push(pick(CHAR_SETS.err));
      cd.cells.push(row);
    }
    cd.timer = 0;
  }

  _updateCoreDump(s, dt) {
    const cd = s.coreDump;
    if (!cd.active) return;
    cd.t += dt;
    if (cd.t >= cd.life) { cd.active = false; return; }
    cd.timer -= dt;
    if (cd.timer <= 0) {
      cd.timer = 0.1;
      for (let r = 0; r < 6; r++) {
        for (let col = 0; col < 9; col++) {
          if (Math.random() < 0.25) cd.cells[r][col] = pick(CHAR_SETS.err);
        }
      }
    }
  }

  _drawCoreDump(s) {
    const cd = s.coreDump;
    if (!cd.active) return;
    const ctx = s.ctx;
    const W2 = CONFIG.crash.coreW;
    const H2 = CONFIG.crash.coreH;
    const x = cd.x - W2 / 2;
    const y = cd.y - H2 / 2;
    const a = 1 - cd.t / cd.life;

    this._resetAlpha(s);
    ctx.globalAlpha = 0.8 * a;
    ctx.fillStyle = CONFIG.err.core;
    ctx.fillRect(x, y, W2, H2);
    ctx.globalAlpha = 0.6 * a;
    ctx.strokeStyle = CONFIG.err.error;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, W2 - 1, H2 - 1);

    this._resetAlpha(s);
    ctx.font = 'bold 9px ' + CONFIG.fontFamily;
    ctx.fillStyle = CONFIG.err.error;
    ctx.globalAlpha = 0.9 * a;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const cw = W2 / 9;
    for (let r = 0; r < 6; r++) {
      for (let col = 0; col < 9; col++) {
        ctx.fillText(cd.cells[r][col], x + col * cw + 3, y + 6 + r * 9);
      }
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = 1;
  }

  /* ==================================================================
     余韵（爆发后的持续输出）
     ================================================================== */
  _updateAfterglow(s, dt) {
    const ag = s.afterglow;
    if (ag.t <= 0) return;
    ag.t -= dt;
    ag.acc += dt;
    if (ag.acc > 0.06) {
      ag.acc = 0;
      const p = this._spawnP(s);
      if (p) {
        p.active = true; p.rf = false; p.frozenT = 0;
        p.mode = MODE_BURST;
        if (ag.small) {
          p.ch = Math.random() < 0.5 ? '0' : '1';
          p.color = CONFIG.ide.binary;
        } else {
          p.ch = pick(CHAR_SETS.err);
          p.color = pick(CONFIG.errColors);
        }
        p.x = s.mx + rand(-24, 24);
        p.y = s.my + rand(-8, 12);
        p.vx = rand(-25, 25);
        p.vy = rand(-70, -25);
        p.size = rand(10, 15);
        p.alpha = 1;
        p.life = 0;
        p.maxLife = rand(0.6, 1.0);
        p.rot = rand(-0.4, 0.4);
        p.vrot = rand(-2, 2);
      }
    }
  }

  /* ==================================================================
     输入（按键）—— 鼠标速度由基类算好，这里只处理左右键
     ================================================================== */
  onPointerDown(e) {
    const s = this.state;
    if (!s) return;
    // 原型的监听按 button 分发，与基类的事件语义一致
    if (e.button === 0) this._onLeftDown(s);
    else if (e.button === 2) this._onRightDown(s);
  }

  onPointerUp(e) {
    const s = this.state;
    if (!s) return;
    if (e.button === 0) this._onLeftUp(s);
    else if (e.button === 2) this._onRightUp(s);
  }

  // 失焦：按键状态已丢失，取消蓄力并收起未冻结的进行中动效（原型 window blur 行为）
  onBlur() {
    const s = this.state;
    if (!s) return;
    s.compile.armed = false;
    s.crash.armed = false;
    if (s.compile.active && !s.compile.frozen) {
      s.compile.active = false;
      s.compile.nodes.length = 0;
      s.compile.chars.length = 0;
    }
    if (s.crash.active && !s.crash.frozen) {
      s.crash.active = false;
      s.crash.frames.length = 0;
    }
  }

  _onLeftDown(s) {
    const c = s.compile;
    const cr = s.crash;
    if (c.active || cr.active || c.armed || cr.armed) return;
    s.leftHold = 0;
    c.armed = true;
    this._spawnCaret(s, s.input.x, s.input.y, CONFIG.ide.white, 0.5, 18);
  }

  _onLeftUp(s) {
    const c = s.compile;
    if (c.armed) {
      c.armed = false;
      this._doClick(s);
      return;
    }
    if (c.active && !c.frozen) {
      c.frozen = true;
      c.freezeT = 0.03;
    }
  }

  _onRightDown(s) {
    const c = s.compile;
    const cr = s.crash;
    if (c.active || cr.active || c.armed || cr.armed) return;
    s.rightHold = 0;
    cr.armed = true;
  }

  _onRightUp(s) {
    const cr = s.crash;
    if (cr.armed) {
      cr.armed = false;
      this._doSmallCrash(s);
      return;
    }
    if (cr.active && !cr.frozen) {
      cr.frozen = true;
      cr.freezeT = 0.03;
    }
  }

  _doClick(s) {
    const x = s.input.x, y = s.input.y;
    this._spawnCaret(s, x, y, CONFIG.ide.white, 0.5, 18);
    this._startTypewriter(s, x, y);
    this._startRefactor(s, x, y);
  }

  _doSmallCrash(s) {
    const cx = s.input.x;
    const cy = s.input.y + 70;
    const n = 5;
    const h = CONFIG.crash.frameH;
    for (let i = 0; i < n; i++) {
      const f = {
        name: pick(FUNC_NAMES), line: randInt(1, 99),
        w: lerp(CONFIG.crash.frameWMax, CONFIG.crash.frameWMin, i / (n - 1)),
        color: frameColor(i / (n - 1))
      };
      s.crashBurstQueue.push({
        x: cx, y: cy - (i + 0.5) * h, w: f.w, color: f.color,
        name: f.name, delay: i * 0.05, t: 0, done: false
      });
    }
    s.waves.push({ type: 'ring', x: cx, y: cy, maxR: 180, t: 0, life: 0.45, delay: 0 });
    this._spawnCoreDump(s, cx, cy - 20);
  }

  /* ==================================================================
     尺寸 —— 只同步动效自己的 W / H，画布尺寸与 DPR 由基类维护
     ================================================================== */
  onResize(width, height) {
    const s = this.state;
    if (!s) return;
    s.W = width;
    s.H = height;
    // 基类重设画布缓冲会清空上下文状态，与原型 resize() 一样重新写入文本对齐
    const ctx = s.ctx;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
  }

  /* ==================================================================
     更新主循环
     ================================================================== */
  update(dt, s) {
    if (!s) return;
    const inp = s.input;

    s.now += dt;

    // 蓄力微震：只作用于「有效光标」，真实光标坐标不受影响
    let chargeT = 0;
    if (s.compile.active) chargeT = s.compile.t;
    else if (s.crash.active) chargeT = s.crash.t;

    let jx = 0, jy = 0;
    const shakeStart = CONFIG.compile.chargeMax * 0.55;
    if (chargeT > shakeStart) {
      const amp = 1 + (chargeT - shakeStart) / (CONFIG.compile.chargeMax - shakeStart) * 2;
      jx = (Math.random() - 0.5) * amp * 2;
      jy = (Math.random() - 0.5) * amp * 2;
    }
    s.mx = inp.x + jx;
    s.my = inp.y + jy;

    // 短按判定：按住超过阈值转为蓄力（编译 / 崩溃）
    if (s.compile.armed) {
      s.leftHold += dt;
      if (s.leftHold >= CONFIG.clickThreshold) {
        s.compile.armed = false;
        this._startCompile(s);
      }
    }
    if (s.crash.armed) {
      s.rightHold += dt;
      if (s.rightHold >= CONFIG.clickThreshold) {
        s.crash.armed = false;
        this._startCrash(s);
      }
    }

    // 蓄力期间不生成拖尾
    if (!s.compile.active && !s.crash.active) {
      this._updateTrail(s);
    } else {
      s.trailAccum = 0;
    }

    this._updateParticles(s, dt);
    this._updateRefactor(s, dt);
    if (s.compile.active) this._updateCompile(s, dt);
    this._updateCrash(s, dt);
    this._updateCarets(s, dt);
    this._updateWaves(s, dt);
    this._updateCoreDump(s, dt);
    this._updateAfterglow(s, dt);
    this._updateCrashBurstQueue(s, dt);
    this._updateTypewriter(s);

    // 光标上一帧位置由基类在帧末写回 input.lx / input.ly，
    // 语义与原型在 update() 末尾的 mouse.px = mouse.x 完全一致。
  }

  /* ==================================================================
     渲染
     ================================================================== */
  render(s) {
    if (!s) return;
    const ctx = s.ctx;

    // 清屏：原型在这里也是 clearRect 起手（深色底来自页面 body，不是画布铺底），
    // 移植后同样只清除上一帧内容，绝不覆盖宿主页面。
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, s.W, s.H);

    // 冲击波环
    for (let i = 0; i < s.waves.length; i++) {
      const w = s.waves[i];
      if (w.type !== 'ring') continue;
      if (w.t < w.delay) continue;
      const k = (w.t - w.delay) / w.life;
      if (k > 1) continue;
      const r = w.maxR * easeOut(k);
      ctx.globalAlpha = (1 - k) * 0.8;
      ctx.strokeStyle = CONFIG.err.error;
      ctx.lineWidth = 3 * (1 - k) + 1;
      ctx.beginPath();
      ctx.arc(w.x, w.y, r, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    this._drawWaves(s);

    this._drawRefactorGuides(s);

    if (s.crash.active) this._drawCrash(s);
    if (s.compile.active) {
      this._drawCodeLines(s);
      this._drawTree(s);
    }

    this._drawTypewriter(s);
    this._drawCoreDump(s);

    for (let i = 0; i < s.particles.length; i++) {
      const p = s.particles[i];
      if (!p.active) continue;
      if (p.mode === MODE_RECT) {
        // 与 _drawCharAt 同理：原型一次性写死变换，
        // 这里改用 translate / rotate / scale 叠加，设备变换完全一致
        const k = p.size / CONFIG.baseFont;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.scale(k, k);
        ctx.globalAlpha = Math.max(0, p.alpha);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      } else if (p.mode === MODE_LOG) {
        this._resetAlpha(s);
        ctx.globalAlpha = Math.max(0, p.alpha);
        ctx.fillStyle = p.color;
        ctx.font = 'bold ' + p.size + 'px ' + CONFIG.fontFamily;
        ctx.textAlign = 'left';
        ctx.fillText(p.text, p.x, p.y);
        ctx.textAlign = 'center';
      } else {
        this._drawCharAt(s, p.ch, p.x, p.y, p.size, p.color, p.alpha, p.rot);
      }
    }
    this._resetAlpha(s);

    this._drawCarets(s);
    ctx.globalAlpha = 1;
  }
}

if (!customElements.get('cursor-code')) {
  customElements.define('cursor-code', CursorCode);
}

export default CursorCode;
