/**
 * cursor-orb —— 鼠标光标光球动效（左键时间冻结 / 右键延迟爆发）。
 *
 * 由 html/光球.html 原型移植：算法流程、数值、视觉表现与原文件一一对应。
 * 作为光标层组件，原型页面自身的行为已剔除：
 *   - 不携带页面底色：原型的深色底来自 body 的 CSS 背景（第 8~15 行），
 *     render() 里本来就没有整屏铺底，移植后 canvas 保持透明，不遮挡宿主页面；
 *   - 不拦截 contextmenu（第 369 行），基类统一处理并保留 Shift/Ctrl 放行；
 *   - 画布创建、DPR 适配、尺寸同步（第 130~144 行）、监听注册、rAF 循环、
 *     鼠标速度平滑以及「>300px 跳变归零 / 6000 封顶」全部由基类负责。
 *
 * 原型监听 mousemove / mousedown / mouseup，因此声明 inputFamily = 'mouse'。
 * 所有运行状态都放在 setup() 返回的 state 上，多实例互不干扰。
 */

import { CursorEffectElement } from '../core/base.js';
import { TAU, clamp, lerp, rand, mixColor } from '../core/utils.js';

/* =========================================================================
   CONFIG —— 所有可调参数集中于此（数值与原型第 34~107 行逐一对应）
   ========================================================================= */
const CONFIG = {
  /* ---- 性能 ---- */
  MAX_PARTICLES: 1000,        // 主粒子对象池上限
  MAX_HISTORY: 12,            // 历史队列固定容量（环形缓冲区）
  HISTORY_INTERVAL: 0.015,    // 历史采样间隔（秒）——决定残影在空间上的间距
  DPR_CAP: 2,                 // 设备像素比上限（现由基类统一封顶，保留原值）

  /* ---- 残影 ---- */
  HIST_NORMAL: 6,             // 常态残影层数
  HIST_CHARGED: 12,           // 蓄力时残影层数
  GHOST_SIZE_FALLOFF: 0.9,    // 每老一层的尺寸衰减系数
  GHOST_A_MIN: 0.10,          // 常态：最老残影 alpha
  GHOST_A_MAX: 0.40,          // 常态：最新残影 alpha
  GHOST_A_MIN_C: 0.40,        // 蓄力：最老残影 alpha
  GHOST_A_MAX_C: 0.70,        // 蓄力：最新残影 alpha

  /* ---- 主粒子 ---- */
  P_R_MIN: 3,
  P_R_MAX: 6,
  LIFE_MIN: 1.5,
  LIFE_MAX: 3.0,
  GRAVITY: 22,                // 轻微重力 px/s²
  DRAG: 0.62,                 // 每秒保留的速度比例（阻力）

  /* ---- 配色 · 左键（时间冻结）冰蓝紫组 ---- */
  L_MAIN:  [79, 227, 255],    // 冰青
  L_SUB:   [155, 92, 255],    // 紫
  L_HI:    [255, 255, 255],   // 高光
  L_DARK:  [42, 42, 90],      // 深蓝紫
  L_GHOST: [74, 74, 138],     // 残影淡色 灰蓝紫

  /* ---- 配色 · 右键（延迟爆发）橙金红组 ---- */
  R_MAIN:  [255, 140, 26],    // 橙
  R_SUB:   [255, 61, 93],     // 红
  R_HI:    [255, 210, 74],    // 金
  R_DARK:  [74, 26, 26],      // 暗红
  R_GHOST: [138, 74, 42],     // 残影淡色 暗橙

  /* ---- 时间冻结（左键）---- */
  CHARGE_MAX: 2.5,            // 蓄力时长上限（秒）
  FREEZE_R0: 80,              // 时间场初始半径
  FREEZE_R1: 300,             // 时间场最大半径
  FREEZE_EDGE: 30,            // 时间场边缘过渡带宽度
  TIME_SCALE_MIN: 0.05,       // 时间流速最小值
  TIME_SCALE_OVER: 1.5,       // 松开瞬间的过冲值
  MIN_CHARGE_T: 0.12,         // 低于此蓄力视为普通单击

  /* ---- 延迟爆发（右键）---- */
  DELAY_R0: 100,              // 延迟场初始半径
  DELAY_R1: 350,              // 延迟场最大半径
  DELAY_EDGE: 40,             // 延迟场边缘过渡带宽度
  DELAY_T_MIN: 0.10,          // 最小延迟时间
  DELAY_T_MAX: 0.50,          // 最大延迟时间
  DELAY_LAYERS: 6,            // 延迟残影层数上限
  DELAY_GAP_MIN: 5,           // 延迟层最小间距
  DELAY_GAP_MAX: 25,          // 延迟层最大间距
  DELAY_FREEZE_T: 0.03,       // 松开瞬间凝固时长
  DELAY_CHAIN_T: 0.30,        // 连锁反应总时长

  /* ---- 单击 ---- */
  CLICK_MIN: 8,
  CLICK_MAX: 14,
  CLICK_SPEED_MIN: 200,
  CLICK_SPEED_MAX: 500,

  /* ---- 时间回溯（点击冲击）---- */
  REWIND_RADIUS: 250,
  REWIND_DURATION: 0.40,

  /* ---- 爆发 ---- */
  BURST_BASE: 400,
  BURST_POWER: 1000,
  BURST_GHOST_SLOW: 0.8       // 残影副本比主粒子慢 20%
};

const MAXP = CONFIG.MAX_PARTICLES;
const MAXH = CONFIG.MAX_HISTORY;
const MOUSE_HIST = 96;        // 鼠标位置历史容量（供右键「延迟」采样）

/* =========================================================================
   工具函数（颜色）
   ========================================================================= */
function rgbStr(c) {
  return 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')';
}

/* =========================================================================
   粒子池 —— 对象池 + 每个主粒子的历史队列（环形缓冲区）
   ========================================================================= */
function makeParticle() {
  return {
    active: false,
    x: 0, y: 0, vx: 0, vy: 0,
    life: 0, maxLife: 1,
    r: 4,
    side: 0,                       // 0 = 左键体系(冰蓝) / 1 = 右键体系(橙金)
    hx: new Float32Array(MAXH),    // 历史队列 X（环形缓冲）
    hy: new Float32Array(MAXH),    // 历史队列 Y
    hHead: 0,                      // 下一个写入位置
    hCount: 0,                     // 已写入数量
    hAcc: 0,                       // 采样累加器
    rewind: 0,                     // 时间回溯计时
    gox: new Float32Array(MAXH),   // 残影相对历史位置的偏移（时间回溯展开用）
    goy: new Float32Array(MAXH),
    spark: 0,                      // 时间光斑标记
    sparkR: 0
  };
}

export class CursorOrb extends CursorEffectElement {
  // 原型用的是 mousemove / mousedown / mouseup（不是 pointer 事件族），
  // 不声明这一行，基类会去监听 pointermove，动效将完全收不到鼠标输入。
  inputFamily = 'mouse';

  /* =========================================================================
     初始化
     ========================================================================= */
  // 只建池与状态，不注册任何监听（监听、DPR 缩放、rAF 全归基类）
  setup({ ctx, width, height, input }) {
    // 与原型一致：初始光标位置取视口中心。
    // 基类的 input 从 (0, 0) 起算，若不在这里对齐，首帧的位移会按「从左上角跳过来」计算，
    // 速度与拖尾生成量会和原型不同。
    input.x = input.lx = width * 0.5;
    input.y = input.ly = height * 0.5;

    const particles = new Array(MAXP);
    const freeList = [];
    for (let i = 0; i < MAXP; i++) {
      const p = makeParticle();
      particles[i] = p;
      freeList.push(p);
    }

    return {
      // 本实例的画布上下文（已按 DPR 缩放过，统一使用 CSS 像素坐标）
      ctx,

      // 画布尺寸（CSS 像素），由基类 onResize 同步
      W: width,
      H: height,

      input,

      // 粒子池 + 空闲表
      particles,
      freeList,

      // 辅助视觉实体：时间涟漪环 / 时钟闪点 / 残影碎片
      rings: [],
      flashes: [],
      shards: [],

      // 鼠标位置历史（供右键「延迟」采样）
      mouseHist: {
        x: new Float32Array(MOUSE_HIST),
        y: new Float32Array(MOUSE_HIST),
        t: new Float32Array(MOUSE_HIST),
        head: 0,
        count: 0
      },

      now: 0,                 // 全局累计时间
      curTS: 1,               // 当前全局时间流速

      // 光标方向的平滑值（原型 mouse.dirX / dirY）
      dirX: 1, dirY: 0,

      jitterX: 0, jitterY: 0,

      // 时间场（左键）
      freeze: {
        active: false,
        t: 0,
        charge: 0,            // 0~1
        x: 0, y: 0,
        radius: 0,
        recoil: 0             // 松开后的过冲计时
      },

      // 延迟场（右键）
      delayF: {
        active: false,
        t: 0,
        charge: 0,            // 0~1
        x: 0, y: 0,
        radius: 0,
        // 释放阶段
        releasing: false,
        relT: -1,
        relPower: 0,
        relFrozen: 0,
        targets: [],
        burstDone: false
      },

      // 残影 / 延迟残影配色查找表（每帧重算，按实例隔离）
      ghostLUT_L: new Array(MAXH),
      ghostLUT_R: new Array(MAXH),
      delayLUT: new Array(CONFIG.DELAY_LAYERS)
    };
  }

  /* =========================================================================
     粒子池操作
     ========================================================================= */
  /** 取得一个可用粒子；池满时回收生命值最低的 */
  _acquireParticle(s) {
    if (s.freeList.length > 0) return s.freeList.pop();
    let worst = -1, worstV = 1e9;
    for (let i = 0; i < MAXP; i++) {
      const p = s.particles[i];
      if (!p.active) continue;
      const v = p.life / p.maxLife;
      if (v < worstV) { worstV = v; worst = i; }
    }
    if (worst < 0) return null;
    return s.particles[worst];
  }

  /** 生成一个主粒子（并立刻开启它的历史队列） */
  _spawnParticle(s, x, y, vx, vy, side) {
    const p = this._acquireParticle(s);
    if (!p) return null;
    p.active = true;
    p.x = x; p.y = y;
    p.vx = vx; p.vy = vy;
    p.maxLife = rand(CONFIG.LIFE_MIN, CONFIG.LIFE_MAX);
    p.life = p.maxLife;
    p.r = rand(CONFIG.P_R_MIN, CONFIG.P_R_MAX);
    p.side = side;
    p.hHead = 0;
    p.hCount = 0;
    p.hAcc = 0;
    p.rewind = 0;
    p.gox.fill(0);
    p.goy.fill(0);
    p.spark = Math.random() < 0.22 ? 1 : 0;
    p.sparkR = rand(20, 40);
    return p;
  }

  /* =========================================================================
     辅助视觉实体
     ========================================================================= */
  /** 时间涟漪 / 时间波：由「依次出现的点」组成的圆环 */
  _spawnRing(s, x, y, r0, r1, dur, n, side, alpha, seq) {
    if (s.rings.length > 22) s.rings.shift();
    s.rings.push({ x, y, r0, r1, t: 0, dur, n, side, alpha, seq: !!seq });
  }

  _spawnFlash(s, x, y) {
    if (s.flashes.length > 12) s.flashes.shift();
    s.flashes.push({ x, y, t: 0, dur: 0.1 });
  }

  _spawnShard(s, x, y, vx, vy, side, life, r) {
    if (s.shards.length > 520) s.shards.shift();
    s.shards.push({ x, y, vx, vy, side, life, maxLife: life, r });
  }

  /* =========================================================================
     鼠标位置历史
     ========================================================================= */
  /** 采样 delaySec 秒之前的鼠标位置 */
  _sampleMouseDelay(s, sec) {
    const hist = s.mouseHist;
    if (hist.count === 0) return { x: s.input.x, y: s.input.y };
    const target = s.now - sec;
    let idx = hist.head;
    for (let i = 0; i < hist.count; i++) {
      const k = (hist.head - i + MOUSE_HIST * 2) % MOUSE_HIST;
      idx = k;
      if (hist.t[k] <= target) break;
    }
    return { x: hist.x[idx], y: hist.y[idx] };
  }

  /* =========================================================================
     输入（按键）—— 鼠标速度由基类算好，这里只处理左右键交互
     ========================================================================= */
  onPointerDown(e) {
    const s = this.state;
    if (!s) return;
    const F = s.freeze;
    const D = s.delayF;

    if (e.button === 0) {
      F.active = true;
      F.t = 0;
      F.charge = 0;
      F.x = e.clientX;
      F.y = e.clientY;
      F.radius = CONFIG.FREEZE_R0;
      F.recoil = 0;
    } else if (e.button === 2) {
      D.active = true;
      D.t = 0;
      D.charge = 0;
      D.x = e.clientX;
      D.y = e.clientY;
      D.radius = CONFIG.DELAY_R0;
      D.releasing = false;
      D.relT = -1;
      D.relFrozen = 0;
    }
  }

  onPointerUp(e) {
    const s = this.state;
    if (!s) return;
    const F = s.freeze;
    const D = s.delayF;

    if (e.button === 0) {
      if (F.active) {
        const held = F.t;
        if (held < CONFIG.MIN_CHARGE_T) {
          this._doClick(s, F.x, F.y);
        } else {
          this._doFreezeRelease(s);
        }
        F.active = false;
        F.recoil = 0.05;
        F.charge = 0;
        s.curTS = CONFIG.TIME_SCALE_OVER;
      }
    } else if (e.button === 2) {
      if (D.active) {
        if (D.t < CONFIG.MIN_CHARGE_T) {
          this._doQuickDelayBurst(s);
        } else {
          this._doDelayRelease(s);
        }
        D.active = false;
      }
    }
  }

  // 失焦时按键状态已丢失（原型 window blur 的行为）
  onBlur() {
    const s = this.state;
    if (!s) return;
    const F = s.freeze;
    const D = s.delayF;

    F.active = false;
    F.charge = 0;
    F.radius = 0;
    F.recoil = 0;
    D.active = false;
    D.charge = 0;
    D.radius = 0;
    s.curTS = 1;
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
     交互三：单击 —— 时间回溯 / Time Rewind
     ========================================================================= */
  _triggerRewind(s, cx, cy, radius) {
    const r2 = radius * radius;
    for (let i = 0; i < MAXP; i++) {
      const p = s.particles[i];
      if (!p.active) continue;
      const dx = p.x - cx, dy = p.y - cy;
      if (dx * dx + dy * dy < r2) {
        p.rewind = CONFIG.REWIND_DURATION;
      }
    }
  }

  /* =========================================================================
     交互二：单击（左键按下瞬间）
     ========================================================================= */
  _doClick(s, cx, cy) {
    const n = CONFIG.CLICK_MIN + Math.floor(Math.random() * (CONFIG.CLICK_MAX - CONFIG.CLICK_MIN + 1));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + rand(-0.25, 0.25);
      const sp = rand(CONFIG.CLICK_SPEED_MIN, CONFIG.CLICK_SPEED_MAX);
      this._spawnParticle(s, cx, cy, Math.cos(a) * sp, Math.sin(a) * sp, 0);
    }

    // 时间涟漪：点依次点亮
    this._spawnRing(s, cx, cy, 10, 80, 0.4, 34, 0, 0.65, true);

    // 时钟闪点
    this._spawnFlash(s, cx, cy);

    // 时间回溯
    this._triggerRewind(s, cx, cy, CONFIG.REWIND_RADIUS);

    // 时间光斑
    for (let i = 0; i < 4; i++) {
      const a = Math.random() * TAU;
      const d = rand(6, 30);
      this._spawnShard(s, cx + Math.cos(a) * d, cy + Math.sin(a) * d,
        Math.cos(a) * 40, Math.sin(a) * 40, 0, 0.5, 2.2);
    }
  }

  /* =========================================================================
     交互四：左键 —— 时间冻结 · 松开爆发
     ========================================================================= */
  _doFreezeRelease(s) {
    const F = s.freeze;
    const t = clamp(F.t, 0, CONFIG.CHARGE_MAX);
    const power = Math.pow(t / CONFIG.CHARGE_MAX, 1.6);
    const cx = F.x, cy = F.y;
    const R = F.radius;

    // 时间波：每个点随距离递增延后出现
    this._spawnRing(s, cx, cy, 20, 150 + 400 * power, 0.75, 56, 0, 0.55, true);

    // 所有粒子：残影压缩 + 主粒子带残影一起飞出
    for (let i = 0; i < MAXP; i++) {
      const p = s.particles[i];
      if (!p.active) continue;
      const dx = p.x - cx, dy = p.y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const inField = dist < R + CONFIG.FREEZE_EDGE;

      if (inField) {
        // 时间线拉直 → 残影碎片 → 主粒子爆发
        const nx = dist > 0.001 ? dx / dist : Math.cos(Math.random() * TAU);
        const ny = dist > 0.001 ? dy / dist : Math.sin(Math.random() * TAU);
        const boost = CONFIG.BURST_BASE + CONFIG.BURST_POWER * power;
        p.vx = nx * boost * rand(0.75, 1.15);
        p.vy = ny * boost * rand(0.75, 1.15);
        p.rewind = CONFIG.REWIND_DURATION;

        // 残影碎片：约 30% 的残影分裂
        for (let d = 0; d < p.hCount; d += 3) {
          if (Math.random() < 0.32) {
            const a = Math.random() * TAU;
            const sp = rand(200, 500);
            this._spawnShard(s, p.x, p.y, Math.cos(a) * sp, Math.sin(a) * sp, 0, rand(0.3, 0.7), rand(1.4, 2.6));
          }
        }

        // 时间涟漪爆发
        if (Math.random() < 0.35) {
          this._spawnRing(s, p.x, p.y, 10, 60, 0.5, 20, 0, 0.35, true);
        }
      } else {
        p.rewind = CONFIG.REWIND_DURATION;
      }
    }

    // 时间线风暴（拉直的线）
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * TAU + rand(-0.1, 0.1);
      const sp = rand(300, 700);
      this._spawnShard(s, cx, cy, Math.cos(a) * sp, Math.sin(a) * sp, 0, 0.4, 1.6);
    }

    // 时间火花
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * TAU;
      const r = 60 + Math.random() * 60;
      this._spawnShard(s, cx + Math.cos(a) * r, cy + Math.sin(a) * r,
        Math.cos(a) * 260, Math.sin(a) * 260, 0, 0.35, 1.3);
    }

    this._spawnFlash(s, cx, cy);
  }

  /* =========================================================================
     交互五：右键 —— 延迟爆发 · 命令释放
     ========================================================================= */
  _doQuickDelayBurst(s) {
    const D = s.delayF;
    const cx = D.x, cy = D.y;
    this._spawnRing(s, cx, cy, 12, 90, 0.5, 30, 1, 0.5, true);
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * TAU;
      const sp = rand(180, 360);
      this._spawnParticle(s, cx, cy, Math.cos(a) * sp, Math.sin(a) * sp, 1);
    }
  }

  _doDelayRelease(s) {
    const D = s.delayF;
    const t = clamp(D.t, 0, CONFIG.CHARGE_MAX);
    const power = Math.pow(t / CONFIG.CHARGE_MAX, 1.6);
    D.releasing = true;
    D.relT = 0;
    D.relPower = power;
    D.relFrozen = CONFIG.DELAY_FREEZE_T;

    // 采集过去几个时刻的鼠标位置，作为「被延迟的命令」
    const targets = [];
    const delayMax = lerp(CONFIG.DELAY_T_MIN, CONFIG.DELAY_T_MAX, D.charge);
    for (let i = 0; i < 6; i++) {
      targets.push(this._sampleMouseDelay(s, delayMax * (0.25 + i * 0.18)));
    }
    D.targets = targets;
  }

  /* =========================================================================
     更新：鼠标 / 时间场 / 延迟场
     ========================================================================= */
  update(dt, s) {
    if (!s) return;
    const M = s.input;

    // 全局累计时间。
    // 原型第 281 行声明了 now 却从未累加（无 now += dt），导致鼠标历史时间戳恒为 0、
    // 「延迟命令」采样退化成永远取最老的一个样本、时间场边缘的波形也完全静止。
    // 这里补上累加，让原型注释所声明的设计真正生效（详见文件头与回报说明）。
    s.now += dt;

    /* ---------- 鼠标输入 ---------- */
    // 位移由基类的位置给出：基类在帧末才把 lx/ly 对齐到 x/y，
    // 与原型每帧刷新的 mouse.lastX / lastY 时序一致。
    const mdx = M.x - M.lx;
    const mdy = M.y - M.ly;

    // 光标方向的平滑（原型第 535~542 行）：基类只提供速度、不提供方向量，
    // 因此保留原型的 0.35 平滑算法，仅把触发阈值改用基类平滑后的速度。
    const mlen = Math.sqrt(mdx * mdx + mdy * mdy);
    if (M.speed > 30 && mlen > 1e-4) {
      const inv = 1 / mlen;
      s.dirX += (mdx * inv - s.dirX) * 0.35;
      s.dirY += (mdy * inv - s.dirY) * 0.35;
      const dl = Math.sqrt(s.dirX * s.dirX + s.dirY * s.dirY) || 1;
      s.dirX /= dl;
      s.dirY /= dl;
    }

    // 鼠标位置历史
    const hist = s.mouseHist;
    hist.head = (hist.head + 1) % MOUSE_HIST;
    hist.x[hist.head] = M.x;
    hist.y[hist.head] = M.y;
    hist.t[hist.head] = s.now;
    if (hist.count < MOUSE_HIST) hist.count++;

    /* ---------- 时间场（左键）状态 ---------- */
    const F = s.freeze;
    if (F.active) {
      F.t += dt;
      F.charge = Math.min(1, F.t / CONFIG.CHARGE_MAX);
      const targetR = lerp(CONFIG.FREEZE_R0, CONFIG.FREEZE_R1, Math.pow(F.charge, 0.85));
      F.radius += (targetR - F.radius) * Math.min(1, dt * 6);
      F.x = M.x;
      F.y = M.y;

      // 微震：蓄力超过 55% 后光标高频抖动（时间场内部看起来像慢动作抖动）
      if (F.charge > 0.55) {
        const amp = 1 + (F.charge - 0.55) / 0.45 * 2;
        s.jitterX = rand(-amp, amp);
        s.jitterY = rand(-amp, amp);
      } else {
        s.jitterX *= 0.6;
        s.jitterY *= 0.6;
      }
    } else {
      F.charge += (0 - F.charge) * Math.min(1, dt * 6);
      F.radius += (0 - F.radius) * Math.min(1, dt * 8);
      s.jitterX *= 0.6;
      s.jitterY *= 0.6;
    }

    /* ---------- 全局时间流速 ---------- */
    if (F.recoil > 0) {
      F.recoil -= dt;
      s.curTS = CONFIG.TIME_SCALE_OVER;
    } else if (F.active) {
      const tgt = 1 - (1 - CONFIG.TIME_SCALE_MIN) * F.charge;
      s.curTS += (tgt - s.curTS) * Math.min(1, dt * 14);
    } else {
      s.curTS += (1 - s.curTS) * Math.min(1, dt * 7);
    }

    /* ---------- 延迟场（右键）状态 ---------- */
    const D = s.delayF;
    if (D.active) {
      D.t += dt;
      D.charge = Math.min(1, D.t / CONFIG.CHARGE_MAX);
      const targetR = lerp(CONFIG.DELAY_R0, CONFIG.DELAY_R1, Math.pow(D.charge, 0.85));
      D.radius += (targetR - D.radius) * Math.min(1, dt * 6);
      D.x = M.x;
      D.y = M.y;
    } else {
      D.charge += (0 - D.charge) * Math.min(1, dt * 6);
      D.radius += (0 - D.radius) * Math.min(1, dt * 8);
    }

    /* ---------- 鼠标拖尾生成 ---------- */
    const delayT = lerp(CONFIG.DELAY_T_MIN, CONFIG.DELAY_T_MAX, D.charge);
    const inDelayField = D.active || D.charge > 0.02;

    if (M.speed > 40 && M.inside) {
      const n = Math.min(3, 1 + Math.floor(M.speed / 260));
      for (let i = 0; i < n; i++) {
        const k = (i + 0.5) / n;
        // 原型在 update 开头就把 mouse.lastX 更新为当前 mx，因此这里的基准点
        // 是「当前光标位置」，再沿本帧位移方向向前偏移，移植后原样保留。
        let sx = M.x + mdx * k;
        let sy = M.y + mdy * k;
        let side = 0;

        if (inDelayField) {
          // 污染拖尾：沿鼠标运动方向「向后」偏移，形成滞后感
          const back = Math.min(M.speed * delayT * 0.55, 90);
          sx -= s.dirX * back;
          sy -= s.dirY * back;
          side = 1;
        }

        const vx = M.vx * 0.4 + rand(-70, 70);
        const vy = M.vy * 0.4 + rand(-70, 70);
        this._spawnParticle(s, sx, sy, vx, vy, side);
      }
    }

    // 时间冻结蓄力时：持续补充新粒子，形成「残影森林」
    if (F.active && F.charge > 0.12) {
      const extra = Math.floor(F.charge * 3) + 1;
      for (let i = 0; i < extra; i++) {
        const a = Math.random() * TAU;
        const r = Math.random() * F.radius * 0.85;
        const px = F.x + Math.cos(a) * r;
        const py = F.y + Math.sin(a) * r;
        this._spawnParticle(s, px, py, rand(-25, 25), rand(-25, 25), 0);
      }
    }

    // 延迟场蓄力时：堆积粒子
    if (D.active && D.charge > 0.15) {
      const extra = Math.floor(D.charge * 2.5) + 1;
      for (let i = 0; i < extra; i++) {
        const a = Math.random() * TAU;
        const r = Math.random() * D.radius * 0.8;
        this._spawnParticle(s, D.x + Math.cos(a) * r, D.y + Math.sin(a) * r,
          rand(-18, 18), rand(-18, 18), 1);
      }
    }

    /* ---------- 延迟释放流程 ---------- */
    if (D.releasing) {
      D.relT += dt;

      // 阶段 0：凝固一帧
      if (D.relFrozen > 0) {
        D.relFrozen -= dt;
      } else {
        const rt = D.relT - CONFIG.DELAY_FREEZE_T;

        // 阶段 1：命令队列依次释放（0 → DELAY_CHAIN_T）
        if (rt < CONFIG.DELAY_CHAIN_T) {
          const idx = Math.min(2, Math.floor(rt / (CONFIG.DELAY_CHAIN_T / 3)));
          const tgt = D.targets[idx] || D.targets[0];
          if (tgt) {
            const k = Math.min(1, dt * 16);
            for (let i = 0; i < MAXP; i++) {
              const p = s.particles[i];
              if (!p.active) continue;
              const dx = p.x - D.x, dy = p.y - D.y;
              if (dx * dx + dy * dy > (D.radius + CONFIG.DELAY_EDGE) * (D.radius + CONFIG.DELAY_EDGE)) continue;
              p.x += (tgt.x - p.x) * k;
              p.y += (tgt.y - p.y) * k;
            }
          }
        }

        // 阶段 2：爆发（连锁结束后）
        if (rt >= CONFIG.DELAY_CHAIN_T && !D.burstDone) {
          D.burstDone = true;
          const power = D.relPower;
          const cx = D.x, cy = D.y;
          const boost = CONFIG.BURST_BASE + CONFIG.BURST_POWER * power;

          // 延迟波：每个点比前一个晚 0.03s 出现
          this._spawnRing(s, cx, cy, 20, 150 + 400 * power, 0.85, 52, 1, 0.6, true);

          for (let i = 0; i < MAXP; i++) {
            const p = s.particles[i];
            if (!p.active) continue;
            const dx = p.x - cx, dy = p.y - cy;
            const d2 = dx * dx + dy * dy;
            const R = D.radius + CONFIG.DELAY_EDGE;
            if (d2 > R * R) continue;

            const dist = Math.sqrt(d2);
            const nx = dist > 0.001 ? dx / dist : Math.cos(Math.random() * TAU);
            const ny = dist > 0.001 ? dy / dist : Math.sin(Math.random() * TAU);
            p.vx = nx * boost * rand(0.75, 1.15);
            p.vy = ny * boost * rand(0.75, 1.15);

            // 时间层碎片：延迟残影炸开
            for (let L = 0; L < CONFIG.DELAY_LAYERS; L++) {
              if (Math.random() < 0.6) {
                const a = Math.random() * TAU;
                const sp = rand(200, 500);
                this._spawnShard(s, p.x, p.y, Math.cos(a) * sp, Math.sin(a) * sp, 1, rand(0.35, 0.8), rand(1.2, 2.6));
              }
            }
          }

          // 金色时间线
          for (let i = 0; i < 18; i++) {
            const a = (i / 18) * TAU;
            const sp = rand(260, 620);
            this._spawnShard(s, cx, cy, Math.cos(a) * sp, Math.sin(a) * sp, 1, 0.45, 1.7);
          }

          this._spawnFlash(s, cx, cy);
        }

        if (D.relT > CONFIG.DELAY_CHAIN_T + 2.0) {
          D.releasing = false;
          D.relT = -1;
          D.burstDone = false;
        }
      }
    } else {
      D.burstDone = false;
    }

    /* ---------- 时间场边缘火花 ---------- */
    if (F.active && F.charge > 0.25) {
      if (Math.random() < F.charge * 0.55) {
        const a = Math.random() * TAU;
        const r = F.radius + rand(-12, 12);
        this._spawnShard(s, F.x + Math.cos(a) * r, F.y + Math.sin(a) * r,
          Math.cos(a) * 60, Math.sin(a) * 60, 0, 0.1, 1.6);
      }
    }
    if (D.active && D.charge > 0.25) {
      if (Math.random() < D.charge * 0.55) {
        const a = Math.random() * TAU;
        const r = D.radius + rand(-14, 14);
        this._spawnShard(s, D.x + Math.cos(a) * r, D.y + Math.sin(a) * r,
          Math.cos(a) * 60, Math.sin(a) * 60, 1, 0.1, 1.6);
      }
    }

    /* ---------- 更新所有主粒子 ---------- */
    const fx = F.x, fy = F.y;
    const fr = F.radius;
    const fEdge = CONFIG.FREEZE_EDGE;
    const histInterval = CONFIG.HISTORY_INTERVAL;

    for (let i = 0; i < MAXP; i++) {
      const p = s.particles[i];
      if (!p.active) continue;

      /* --- 计算该粒子处的局部时间流速 --- */
      let fieldF = 0;
      if (fr > 1) {
        const dx = p.x - fx, dy = p.y - fy;
        const d = Math.sqrt(dx * dx + dy * dy);
        const inner = fr - fEdge;
        const outer = fr + fEdge;
        if (d <= inner) fieldF = 1;
        else if (d < outer) fieldF = 1 - (d - inner) / (outer - inner);
      }
      const ts = 1 + (s.curTS - 1) * fieldF;

      /* --- 物理 --- */
      p.vy += CONFIG.GRAVITY * dt * ts;
      const dragF = Math.pow(CONFIG.DRAG, dt * ts);
      p.vx *= dragF;
      p.vy *= dragF;
      p.x += p.vx * dt * ts;
      p.y += p.vy * dt * ts;

      /* --- 寿命（时间冻结时衰减更慢） --- */
      p.life -= dt * Math.max(ts, 0.12);
      if (p.life <= 0) {
        p.active = false;
        s.freeList.push(p);
        continue;
      }

      /* --- 时间回溯：残影沿历史轨迹展开 / 收回 --- */
      if (p.rewind > 0) {
        p.rewind -= dt;
        const prog = 1 - p.rewind / CONFIG.REWIND_DURATION;
        if (prog < 0.45) {
          for (let d = 0; d + 1 < p.hCount; d++) {
            const i0 = (p.hHead - 1 - d + MAXH * 2) % MAXH;
            const i1 = (p.hHead - 2 - d + MAXH * 2) % MAXH;
            const vx = (p.hx[i0] - p.hx[i1]) / histInterval;
            const vy = (p.hy[i0] - p.hy[i1]) / histInterval;
            p.gox[d] += vx * dt;
            p.goy[d] += vy * dt;
          }
        } else {
          const k = Math.min(1, dt * 10);
          for (let d = 0; d < MAXH; d++) {
            p.gox[d] -= p.gox[d] * k;
            p.goy[d] -= p.goy[d] * k;
          }
        }
        if (p.rewind <= 0) {
          p.gox.fill(0);
          p.goy.fill(0);
        }
      }

      /* --- 历史队列采样（真实时间驱动） --- */
      p.hAcc += dt;
      let guard = 0;
      while (p.hAcc >= histInterval && guard < 4) {
        p.hAcc -= histInterval;
        guard++;
        p.hx[p.hHead] = p.x;
        p.hy[p.hHead] = p.y;
        p.hHead = (p.hHead + 1) % MAXH;
        if (p.hCount < MAXH) p.hCount++;
      }
      if (p.hAcc > histInterval * 4) p.hAcc = 0;
    }

    /* ---------- 更新环 / 闪点 / 碎片 ---------- */
    for (let i = s.rings.length - 1; i >= 0; i--) {
      const r = s.rings[i];
      r.t += dt;
      if (r.t >= r.dur) s.rings.splice(i, 1);
    }
    for (let i = s.flashes.length - 1; i >= 0; i--) {
      const f = s.flashes[i];
      f.t += dt;
      if (f.t >= f.dur) s.flashes.splice(i, 1);
    }
    for (let i = s.shards.length - 1; i >= 0; i--) {
      const sh = s.shards[i];
      sh.life -= dt;
      if (sh.life <= 0) { s.shards.splice(i, 1); continue; }
      sh.x += sh.vx * dt;
      sh.y += sh.vy * dt;
      const dg = Math.pow(0.28, dt);
      sh.vx *= dg;
      sh.vy *= dg;
    }
  }

  /* =========================================================================
     渲染
     ========================================================================= */
  _buildLUT(s) {
    const F = s.freeze;
    const D = s.delayF;
    const fz = F.charge;
    const dz = D.charge;

    for (let d = 0; d < MAXH; d++) {
      const t = d / (MAXH - 1);

      // 左键：冰青 → 灰蓝紫 → 蓄力时向「时间冻结色」偏移
      let cL = mixColor(CONFIG.L_MAIN, CONFIG.L_GHOST, t);
      cL = mixColor(cL, [190, 228, 255], fz * (0.25 + 0.45 * (1 - t)));
      s.ghostLUT_L[d] = rgbStr(cL);

      // 右键：橙 → 暗橙
      let cR = mixColor(CONFIG.R_MAIN, CONFIG.R_GHOST, t);
      cR = mixColor(cR, CONFIG.R_HI, dz * 0.18);
      s.ghostLUT_R[d] = rgbStr(cR);
    }

    for (let L = 0; L < CONFIG.DELAY_LAYERS; L++) {
      const t = L / (CONFIG.DELAY_LAYERS - 1);
      let c;
      if (t < 0.5) c = mixColor(CONFIG.R_MAIN, CONFIG.R_HI, t * 2);
      else c = mixColor(CONFIG.R_HI, CONFIG.R_SUB, (t - 0.5) * 2);
      s.delayLUT[L] = rgbStr(c);
    }
  }

  /** 绘制带正弦波动的场边缘 */
  _drawField(s, cx, cy, radius, colorStr, alpha, wobble, time) {
    const ctx = s.ctx;
    if (radius < 4) return;
    const SEG = 68;
    ctx.beginPath();
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * TAU;
      const w = Math.sin(a * 5 + time * 3.1) * wobble + Math.sin(a * 3 - time * 2.3) * wobble * 0.6;
      const r = radius + w;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = colorStr;
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // 内侧很淡的一圈
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.995, 0, TAU);
    ctx.strokeStyle = colorStr;
    ctx.globalAlpha = alpha * 0.35;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  render(s) {
    if (!s) return;
    const ctx = s.ctx;

    // 画布缓冲与 DPR 缩放由基类维护（原型第 911 行的上下文变换已移除）。
    // 原型本来就没有整屏铺底，这里只清空画布，宿主页面始终可见。
    ctx.clearRect(0, 0, s.W, s.H);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 1;

    this._buildLUT(s);

    const time = s.now;
    const F = s.freeze;
    const D = s.delayF;

    /* ---------- 时间场 / 延迟场边缘 ---------- */
    if (F.radius > 4) {
      const wob = 2 + F.charge * 9;
      ctx.globalAlpha = 0.15 + F.charge * 0.22;
      this._drawField(s, F.x + s.jitterX, F.y + s.jitterY, F.radius,
        rgbStr(CONFIG.L_MAIN), 0.15, wob, time);
    }
    if (D.radius > 4) {
      const wob = 2 + D.charge * 10;
      ctx.globalAlpha = 0.15 + D.charge * 0.22;
      this._drawField(s, D.x, D.y, D.radius,
        rgbStr(CONFIG.R_MAIN), 0.15, wob, time);
    }
    ctx.globalAlpha = 1;

    /* ---------- 时间光斑（极淡的大半径光团） ---------- */
    for (let i = 0; i < MAXP; i++) {
      const p = s.particles[i];
      if (!p.active || p.spark <= 0) continue;
      const lf = p.life / p.maxLife;
      if (lf < 0.55) continue;
      const t = (1 - lf) / 0.45;
      const r = p.sparkR + t * 42;
      const a = 0.05 * (1 - t);
      if (a < 0.006) continue;
      ctx.globalAlpha = a;
      ctx.fillStyle = p.side === 0 ? s.ghostLUT_L[0] : s.ghostLUT_R[0];
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    /* ---------- 残影绘制（从最老 → 最新，主粒子最后） ---------- */
    const fr = F.radius;
    const fEdge = CONFIG.FREEZE_EDGE;
    const fcx = F.x, fcy = F.y;

    for (let i = 0; i < MAXP; i++) {
      const p = s.particles[i];
      if (!p.active) continue;

      // 屏幕外剔除
      if (p.x < -80 || p.x > s.W + 80 || p.y < -80 || p.y > s.H + 80) continue;

      const lf = p.life / p.maxLife;

      /* --- 计算残影层数（受时间场影响） --- */
      let fieldF = 0;
      if (fr > 1) {
        const dx = p.x - fcx, dy = p.y - fcy;
        const d = Math.sqrt(dx * dx + dy * dy);
        const inner = fr - fEdge;
        const outer = fr + fEdge;
        if (d <= inner) fieldF = 1;
        else if (d < outer) fieldF = 1 - (d - inner) / (outer - inner);
      }

      const targetDepth = lerp(CONFIG.HIST_NORMAL, CONFIG.HIST_CHARGED, fieldF);
      const depth = Math.min(p.hCount, Math.round(targetDepth));
      const rewindOn = p.rewind > 0;
      const lut = p.side === 0 ? s.ghostLUT_L : s.ghostLUT_R;

      /* --- 残影副本 --- */
      if (depth > 1) {
        const aMaxBase = lerp(CONFIG.GHOST_A_MAX, CONFIG.GHOST_A_MAX_C, fieldF);
        const aMinBase = lerp(CONFIG.GHOST_A_MIN, CONFIG.GHOST_A_MIN_C, fieldF);
        const rewAlphaBoost = rewindOn ? 0.4 : 0;

        for (let d = depth - 1; d >= 0; d--) {
          const dNorm = d / (depth - 1);
          let alpha = lerp(aMaxBase, aMinBase, dNorm) * lf;
          if (rewindOn) alpha = Math.min(0.85, alpha + rewAlphaBoost * (1 - dNorm) + 0.25);

          if (alpha < 0.012) continue;

          const gi = (p.hHead - 1 - d + MAXH * 2) % MAXH;
          const gx = p.hx[gi] + p.gox[d];
          const gy = p.hy[gi] + p.goy[d];
          const gr = p.r * Math.pow(CONFIG.GHOST_SIZE_FALLOFF, d);
          if (gr < 0.5) continue;

          ctx.globalAlpha = alpha;
          ctx.fillStyle = lut[Math.min(d, MAXH - 1)];
          ctx.beginPath();
          ctx.arc(gx, gy, gr, 0, TAU);
          ctx.fill();
        }

        /* --- 时间线（主粒子 ↔ 残影副本）--- */
        const lineAlphaBase = 0.1 + fieldF * 0.2 + (rewindOn ? 0.3 : 0);
        if (lineAlphaBase > 0.05 && depth > 1) {
          ctx.globalAlpha = Math.min(0.5, lineAlphaBase) * lf;
          ctx.strokeStyle = p.side === 0 ? rgbStr(CONFIG.L_GHOST) : rgbStr(CONFIG.R_GHOST);
          ctx.lineWidth = rewindOn ? 1.5 : 0.5;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          for (let d = 0; d < depth; d++) {
            const gi = (p.hHead - 1 - d + MAXH * 2) % MAXH;
            ctx.lineTo(p.hx[gi] + p.gox[d], p.hy[gi] + p.goy[d]);
          }
          ctx.stroke();
        }
      }

      /* --- 主粒子（最上层）--- */
      const mainColor = p.side === 0 ? CONFIG.L_MAIN : CONFIG.R_MAIN;
      const alphaMain = Math.min(1, lf * 1.35);

      // 外圈辉光
      ctx.globalAlpha = alphaMain * 0.20;
      ctx.fillStyle = rgbStr(mainColor);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * 2.3, 0, TAU);
      ctx.fill();

      // 主色环
      ctx.globalAlpha = alphaMain * 0.92;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, TAU);
      ctx.fill();

      // 白色核心
      ctx.globalAlpha = alphaMain;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * 0.42, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    /* ---------- 延迟残影（右键专用：时间层） ---------- */
    if (D.charge > 0.03) {
      const layers = Math.max(1, Math.round(1 + (CONFIG.DELAY_LAYERS - 1) * D.charge));
      const gap = lerp(CONFIG.DELAY_GAP_MIN, CONFIG.DELAY_GAP_MAX, D.charge);
      const dR = D.radius + CONFIG.DELAY_EDGE;
      const dR2 = dR * dR;

      let ndx = s.dirX, ndy = s.dirY;
      const nl = Math.sqrt(ndx * ndx + ndy * ndy) || 1;
      ndx /= nl; ndy /= nl;

      for (let i = 0; i < MAXP; i++) {
        const p = s.particles[i];
        if (!p.active) continue;
        const ddx = p.x - D.x, ddy = p.y - D.y;
        if (ddx * ddx + ddy * ddy > dR2) continue;

        const lf = p.life / p.maxLife;

        // 延迟残影：沿鼠标运动反方向逐层拉开
        for (let L = 0; L < layers; L++) {
          const off = gap * (L + 1);
          const gx = p.x - ndx * off;
          const gy = p.y - ndy * off;
          const a = 0.5 * lf * (1 - L / (layers + 1) * 0.55);
          if (a < 0.02) continue;

          ctx.globalAlpha = a;
          ctx.fillStyle = s.delayLUT[Math.min(L, CONFIG.DELAY_LAYERS - 1)];
          ctx.beginPath();
          ctx.arc(gx, gy, p.r * 0.92, 0, TAU);
          ctx.fill();
        }

        // 时间线：主粒子 ↔ 延迟残影
        if (layers > 1) {
          ctx.globalAlpha = 0.14 * lf;
          ctx.strokeStyle = s.delayLUT[1];
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          for (let L = 0; L < layers; L++) {
            const off = gap * (L + 1);
            ctx.lineTo(p.x - ndx * off, p.y - ndy * off);
          }
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    /* ---------- 时间涟漪 / 时间波（点依次出现） ---------- */
    for (let i = 0; i < s.rings.length; i++) {
      const r = s.rings[i];
      const prog = r.t / r.dur;
      if (prog >= 1) continue;
      const radius = lerp(r.r0, r.r1, 1 - Math.pow(1 - prog, 3));
      const baseA = r.alpha * (1 - prog);
      if (baseA < 0.01) continue;

      ctx.fillStyle = r.side === 0 ? rgbStr(CONFIG.L_MAIN) : rgbStr(CONFIG.R_HI);

      for (let k = 0; k < r.n; k++) {
        const appear = r.seq ? (k / r.n) * 0.55 : 0;
        if (prog < appear) continue;
        const local = (prog - appear) / (1 - appear + 0.0001);
        const a = baseA * (1 - local * 0.45);
        if (a < 0.012) continue;
        const ang = (k / r.n) * TAU;
        const px = r.x + Math.cos(ang) * radius;
        const py = r.y + Math.sin(ang) * radius;
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.arc(px, py, 2.1, 0, TAU);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    /* ---------- 残影碎片 / 时间火花 ---------- */
    for (let i = 0; i < s.shards.length; i++) {
      const sh = s.shards[i];
      const lf = sh.life / sh.maxLife;
      if (lf <= 0) continue;
      ctx.globalAlpha = lf * 0.85;
      ctx.fillStyle = sh.side === 0 ? rgbStr(CONFIG.L_MAIN) : rgbStr(CONFIG.R_HI);
      ctx.beginPath();
      ctx.arc(sh.x, sh.y, sh.r * lf, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    /* ---------- 时钟闪点（白色十字星芒） ---------- */
    for (let i = 0; i < s.flashes.length; i++) {
      const f = s.flashes[i];
      const prog = f.t / f.dur;
      const a = 1 - prog;
      const L = 8 + prog * 22;
      ctx.globalAlpha = a * 0.9;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(f.x - L, f.y);
      ctx.lineTo(f.x + L, f.y);
      ctx.moveTo(f.x, f.y - L);
      ctx.lineTo(f.x, f.y + L);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    ctx.globalCompositeOperation = 'source-over';
  }
}

if (!customElements.get('cursor-orb')) {
  customElements.define('cursor-orb', CursorOrb);
}

export default CursorOrb;
