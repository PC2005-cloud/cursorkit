/**
 * cursor-firefang —— 鼠标光标火焰动效（左键火种蓄力 → 燎原 / 右键熔岩池 → 熔岩四溢）。
 *
 * 由 html/火牙.html 原型移植：算法流程、数值、视觉表现与原文件一一对应。
 * 作为光标层组件，原型页面自身的行为已剔除：
 *   - 原型画布本身没有整屏铺底（深色底写在 CSS 的 html,body 上，不是画布填充），
 *     render() 原本就是 clearRect，因此画布保持透明，绝不覆盖宿主页面；
 *   - 不注册任何监听、不碰 DOM、不拦截 contextmenu（全部归基类）；
 *   - 画布创建、DPR 适配（基类封顶 2，与 CONFIG.DPR_CAP 取值一致）、尺寸同步、
 *     window resize、rAF 循环全部由基类负责。
 *
 * 原型监听 mousemove / mousedown / mouseup，因此声明 inputFamily = 'mouse'。
 *
 * 速度口径：原型第 1844~1846 行用「原始逐帧位移 / dt」算 mouse.vx / vy
 * （不平滑、无钳制、无上限），它只被 emitTrail 的火星漂移引用；
 * 基类 input.vx / vy 是平滑值（且带 >300px 归零、6000 封顶），故这里在 update()
 * 开头复算一份原始速度存进 state。
 *
 * 锚点口径：原型第 1879 行在帧级推进 mouse.px / py（第 1168 行的对齐只在
 * mouse.has 为 false 时执行一次），与基类 input.lx / ly 的语义一致，直接用。
 * 首次移动不产生拖尾（对应原型 mouse.has 的首次对齐），用 state.has 复现。
 *
 * 所有运行状态都放在 setup() 返回的 state 上，多实例互不干扰。
 */

import { CursorEffectElement } from '../core/base.js';
import { TAU, clamp, lerp, rand } from '../core/utils.js';

/* =========================================================
   分区 0 · CONFIG —— 集中所有可调参数（中文注释）
   ========================================================= */
const CONFIG = {
  MAX_PARTICLES: 2800,        // 粒子池上限
  DPR_CAP: 2,                 // devicePixelRatio 上限（基类 _measure() 同样封顶 2）

  /* —— 拖尾 —— */
  TRAIL_PER_PX: 0.11,         // 每像素位移生成火舌数
  TRAIL_MAX_TONGUE: 5,        // 每帧火舌生成上限
  TRAIL_MIN_DIST: 1.2,        // 触发拖尾的最小帧位移
  TRAIL_TONGUE_LIFE: [0.4, 0.9],   // 拖尾火舌寿命
  TRAIL_TONGUE_LEN: [20, 68],      // 拖尾火舌基础长度
  TRAIL_SPARK_PER_PX: 0.13,   // 每像素生成火星数
  TRAIL_SPARK_MAX: 4,         // 每帧火星上限

  /* —— 火焰物理 —— */
  FIRE_BUOY: 640,             // 浮力加速度 px/s²
  FIRE_DRAG: 2.3,             // 空气阻力系数
  FIRE_TURB: 260,             // 湍流加速度
  SPARK_GRAVITY: 300,         // 火星重力 px/s²

  /* —— 火种蓄力（左键） —— */
  CHARGE_MAX: 2.5,            // 蓄力总时长 s
  TAP_THRESHOLD: 0.12,        // 低于此视为普通点击
  OXY_R_MIN: 80,              // 氧气场最小半径
  OXY_R_MAX: 220,             // 氧气场最大半径
  PILLAR_MIN: 30,             // 火柱最小高度
  PILLAR_MAX: 200,            // 火柱最大高度

  /* —— 熔岩（右键） —— */
  POOL_R_MIN: 26,             // 熔岩池最小半径
  POOL_R_MAX: 92,             // 熔岩池最大半径
  LAVA_GRAVITY: 60,           // 熔岩重力（缓慢）
  LAVA_DRAG: 1.1,             // 熔岩黏稠阻力

  /* —— 回燃 —— */
  FLASHOVER_R: 180,           // 回燃影响半径
  FLASHOVER_TIME: 0.3,        // 旺盛燃烧持续时间

  /* —— 配色 —— */
  C: {
    fireRoot:  [120, 22, 0],      // 暗红
    fireMid:   [190, 45, 0],      // 橙红
    fireHot:   [255, 140, 10],    // 橙
    fireYell:  [255, 215, 40],    // 金黄
    fireWhite: [255, 248, 224],   // 炽白
    smokeWarm: [90, 74, 58],      // 暖灰
    smokeCool: [58, 58, 58],      // 冷灰
    obsidian:  [26, 10, 0],       // 黑曜石
    lavaDark:  [74, 14, 0],       // 暗红
    lavaRed:   [139, 0, 0],       // 岩浆红
    lavaOrng:  [255, 107, 26],    // 熔岩橙
    crackGold: [255, 179, 71]     // 裂纹金
  }
};

/* =========================================================
   分区 1 · 工具函数
   （TAU / rand / clamp / lerp 来自 core/utils.js，此处只留原型独有的两个）
   ========================================================= */

/* 角度插值（走最短路径） */
function angLerp(a, b, t) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d < -Math.PI) d += TAU;
  return a + d * t;
}

/* 两色混合为 rgba 字符串（避免数组分配） */
function mixStr(c1, c2, k, a) {
  const r = (c1[0] + (c2[0] - c1[0]) * k) | 0;
  const g = (c1[1] + (c2[1] - c1[1]) * k) | 0;
  const b = (c1[2] + (c2[2] - c1[2]) * k) | 0;
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}

/* =========================================================
   分区 3 · 预渲染光斑精灵（避免逐帧创建径向渐变）

   原型用全局 document 创建这些离屏画布；移植后改用元素自身的
   ownerDocument（s.doc），既不触碰任何全局对象，也绝不挂进 DOM。
   这里的 width / height / getContext 都只作用于离屏贴图画布，与主画布无关。
   （原型第 138~156 行还预渲染了一张 makeRing 贴图 SPR.ring，全文从未被引用，
     属于纯浪费的 256×256 离屏画布，未移植。）
   ========================================================= */
function buildSprites(doc) {
  function makeGlow(r, g, b, midA, midStop) {
    const S = 128;
    const cv = doc.createElement('canvas');
    cv.width = cv.height = S;
    const c2 = cv.getContext('2d');
    const gd = c2.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gd.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ',1)');
    gd.addColorStop(midStop, 'rgba(' + r + ',' + g + ',' + b + ',' + midA + ')');
    gd.addColorStop(1, 'rgba(' + r + ',' + g + ',' + b + ',0)');
    c2.fillStyle = gd;
    c2.fillRect(0, 0, S, S);
    return cv;
  }

  return {
    heat: makeGlow(255, 176, 90, 0.45, 0.42),
    smokeWarm: makeGlow(90, 74, 58, 0.55, 0.45),
    smokeCool: makeGlow(58, 58, 58, 0.55, 0.45)
  };
}

/* =========================================================
   分区 4 · 粒子池（对象池，环形回收，禁止无限 new）
   ========================================================= */
const MAXP = CONFIG.MAX_PARTICLES;

/* 类型常量 */
const T_TONGUE   = 1;   // 火舌
const T_SPARK    = 2;   // 火星
const T_HEAT     = 3;   // 热浪
const T_SMOKE    = 4;   // 烟
const T_AIR      = 5;   // 氧气场空气粒子
const T_LAVAFLOW = 6;   // 熔岩流
const T_CRACK    = 7;   // 裂纹
const T_BUBBLE   = 8;   // 岩浆泡
const T_OBSIDIAN = 9;   // 黑曜石碎片
const T_BOMB     = 10;  // 熔岩弹
const T_EMBER    = 11;  // 余烬 / 余温点

function newParticle() {
  return {
    alive: false,
    type: 0,
    x: 0, y: 0, vx: 0, vy: 0,
    age: 0, life: 1,
    seed: 0,
    size: 1, len: 1, w0: 1, width: 1,
    ang: 0, baseAng: 0,
    heat: 1, flash: 0, glow: 0,
    rot: 0, rotV: 0,
    grav: 1, rise: 1,
    r0: 1, r1: 1, a0: 0.05,
    buoy: 0, drag: 2, turb: 0, wf: 1, wa: 0.1, f1: 1, f2: 2,
    targx: 0, targy: 0,
    groundY: 0, fork: 0, wob: 0
  };
}

/* 从池中取出一个粒子（环形回收最老），并重置全部字段 */
function spawn(s) {
  const p = s.pool[s.ring];
  s.ring = (s.ring + 1) % MAXP;

  p.alive = true;
  p.type = 0;
  p.x = 0; p.y = 0; p.vx = 0; p.vy = 0;
  p.age = 0; p.life = 1;
  p.seed = Math.random() * 1000;
  p.size = 1; p.len = 1; p.w0 = 1; p.width = 1;
  p.ang = 0; p.baseAng = 0;
  p.heat = 1; p.flash = 0; p.glow = 0;
  p.rot = 0; p.rotV = 0;
  p.grav = 1; p.rise = 1;
  p.r0 = 1; p.r1 = 1; p.a0 = 0.05;
  p.buoy = 0; p.drag = 2; p.turb = 0;
  p.wf = 1; p.wa = 0.1; p.f1 = 1; p.f2 = 2;
  p.targx = 0; p.targy = 0;
  p.groundY = 0; p.fork = 0; p.wob = 0;
  return p;
}

/* =========================================================
   分区 5 · 粒子生成函数
   ========================================================= */

/* —— 火舌 —— */
function spawnTongue(s, x, y, vx, vy, len, life, heat) {
  const p = spawn(s);
  p.type = T_TONGUE;
  p.x = x; p.y = y; p.vx = vx; p.vy = vy;
  p.life = life;
  p.len = len;
  p.w0 = len * rand(0.20, 0.30);
  p.baseAng = (Math.abs(vx) + Math.abs(vy) < 4)
    ? -Math.PI / 2
    : Math.atan2(vy, vx);
  p.buoy = CONFIG.FIRE_BUOY * rand(0.75, 1.25);
  p.drag = CONFIG.FIRE_DRAG * rand(0.85, 1.15);
  p.turb = CONFIG.FIRE_TURB * rand(0.6, 1.4);
  p.wf = rand(4, 9);
  p.wa = rand(0.06, 0.18);
  p.f1 = rand(1.1, 2.8);
  p.f2 = rand(2.6, 5.2);
  p.heat = heat;
  return p;
}

/* —— 火星 —— */
function spawnSpark(s, x, y, vx, vy, life) {
  const p = spawn(s);
  p.type = T_SPARK;
  p.x = x; p.y = y; p.vx = vx; p.vy = vy;
  p.life = life;
  p.size = rand(0.8, 2.0);
  p.grav = rand(0.8, 1.2);
  return p;
}

/* —— 热浪 —— */
function spawnHeat(s, x, y, r0, r1, a0, life, vy) {
  const p = spawn(s);
  p.type = T_HEAT;
  p.x = x; p.y = y;
  p.r0 = r0; p.r1 = r1; p.a0 = a0;
  p.life = life;
  p.vx = rand(-18, 18);
  p.vy = (vy === undefined) ? rand(10, 36) : vy;
  return p;
}

/* —— 烟 —— */
function spawnSmoke(s, x, y, size, life) {
  const p = spawn(s);
  p.type = T_SMOKE;
  p.x = x; p.y = y;
  p.vx = rand(-14, 14);
  p.vy = rand(-32, -12);
  p.life = life;
  p.r0 = size;
  p.r1 = size * rand(1.8, 3.0);
  p.a0 = rand(0.04, 0.10);
  return p;
}

/* —— 氧气场空气粒子 —— */
function spawnAir(s, x, y, tx, ty) {
  const p = spawn(s);
  p.type = T_AIR;
  p.x = x; p.y = y;
  p.targx = tx; p.targy = ty;
  p.life = rand(0.5, 1.1);
  p.size = rand(0.7, 1.8);
  return p;
}

/* —— 熔岩流 —— */
function spawnLavaFlow(s, x, y, ang, speed, len, width, life) {
  const p = spawn(s);
  p.type = T_LAVAFLOW;
  p.x = x; p.y = y;
  p.ang = ang;
  p.vx = Math.cos(ang) * speed;
  p.vy = Math.sin(ang) * speed;
  p.len = len;
  p.width = width;
  p.life = life;
  p.rot = 0;
  return p;
}

/* —— 裂纹 —— */
function spawnCrack(s, x, y, ang, len, life, fork) {
  const p = spawn(s);
  p.type = T_CRACK;
  p.x = x; p.y = y;
  p.ang = ang;
  p.len = len;
  p.life = life;
  p.width = rand(1, 2);
  p.fork = fork || 0;
  p.wf = rand(2, 6);
  return p;
}

/* —— 岩浆泡 —— */
function spawnBubble(s, x, y, r) {
  const p = spawn(s);
  p.type = T_BUBBLE;
  p.x = x; p.y = y;
  p.size = r;
  p.life = rand(0.6, 1.4);
  p.rise = rand(8, 22);
  p.wob = Math.random() * 10;
  return p;
}

/* —— 黑曜石碎片 —— */
function spawnObsidian(s, x, y, size, vx, vy) {
  const p = spawn(s);
  p.type = T_OBSIDIAN;
  p.x = x; p.y = y;
  p.size = size;
  p.vx = vx; p.vy = vy;
  p.rot = Math.random() * TAU;
  p.rotV = rand(-2.2, 2.2);
  p.life = rand(1.5, 3.0);
  p.glow = 1;
  return p;
}

/* —— 熔岩弹 —— */
function spawnBomb(s, x, y, vx, vy, size) {
  const p = spawn(s);
  p.type = T_BOMB;
  p.x = x; p.y = y;
  p.vx = vx; p.vy = vy;
  p.size = size;
  p.life = rand(1.6, 3.0);
  p.rot = Math.random() * TAU;
  p.rotV = rand(-4, 4);
  p.groundY = y + rand(60, 220);
  p.fork = 0;
  return p;
}

/* —— 余烬 / 余温 —— */
function spawnEmber(s, x, y, life, heat) {
  const p = spawn(s);
  p.type = T_EMBER;
  p.x = x; p.y = y;
  p.life = life;
  p.size = rand(1.0, 2.6);
  p.wf = rand(6, 14);
  p.heat = heat;
  return p;
}

/* =========================================================
   分区 6 · 死亡回调（火舌化烟 / 岩浆泡破裂等）
   ========================================================= */
function onDeath(s, p) {
  switch (p.type) {
    case T_TONGUE:
      if (Math.random() < 0.18) {
        spawnSmoke(s, p.x, p.y, p.len * 0.30, rand(0.9, 1.8));
      }
      break;

    case T_BUBBLE: {
      // 破裂 → 溅出 3~5 个小熔岩滴
      const n = 3 + (Math.random() * 3 | 0);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU;
        const sp = rand(30, 110);
        const sp2 = spawnSpark(s, p.x, p.y, Math.cos(a) * sp, Math.sin(a) * sp - 40, rand(0.35, 0.7));
        sp2.type = T_LAVAFLOW;
        sp2.ang = a;
        sp2.len = rand(5, 11);
        sp2.width = rand(3, 5);
        sp2.life = rand(0.35, 0.7);
      }
      break;
    }

    case T_BOMB: {
      // 落地 → 溅开成小火堆
      const n = 3 + (Math.random() * 3 | 0);
      for (let i = 0; i < n; i++) {
        const a = -Math.PI * 0.5 + rand(-1.5, 1.5);
        const sp = rand(40, 140);
        const sp2 = spawnSpark(s, p.x, p.y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.5, 1.0));
        sp2.type = T_LAVAFLOW;
        sp2.ang = a;
        sp2.len = rand(7, 15);
        sp2.width = rand(3, 6);
        sp2.life = rand(0.5, 1.0);
      }
      // 短寿命橙红闪光
      spawnHeat(s, p.x, p.y, 12, 44, 0.22, 0.28, 0);
      // 小火堆余烬
      for (let i = 0; i < 5; i++) {
        spawnEmber(s, p.x + rand(-16, 16), p.y + rand(-6, 6), rand(0.8, 1.5), 0.7);
      }
      break;
    }
  }
}

/* =========================================================
   分区 7 · 更新逻辑
   ========================================================= */

/* —— 火舌更新（含湍流 / 浮力 / 熔岩池吸引） —— */
function updateTongue(s, p, dt, t) {
  /* 浮力：气态燃烧，持续向上 */
  p.vy -= p.buoy * dt;

  /* 湍流：sine 组合扰动水平方向 */
  p.vx += (Math.sin(t * p.f1 + p.seed) * p.turb +
           Math.sin(t * p.f2 + p.seed * 1.7) * p.turb * 0.55) * dt;
  p.vy += Math.sin(t * p.f1 * 0.7 + p.seed * 0.5) * p.turb * 0.18 * dt;

  /* 阻尼 */
  const damp = Math.exp(-p.drag * dt);
  p.vx *= damp;
  p.vy *= damp;

  /* 位移 */
  p.x += p.vx * dt;
  p.y += p.vy * dt;

  /* 角度逐渐向上卷曲 */
  p.baseAng = angLerp(p.baseAng, -Math.PI / 2, Math.min(1, dt * 2.4));

  /* 回燃状态衰减 */
  if (p.flash > 0) {
    p.flash = Math.max(0, p.flash - dt / CONFIG.FLASHOVER_TIME);
  }

  /* 左键蓄力：拖尾火舌被主火柱吸引卷入 */
  const chL = s.chargeL;
  if (chL.on) {
    const dx = chL.x - p.x;
    const dy = chL.y - p.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < 70000 && d2 > 120) {
      const d = Math.sqrt(d2);
      const f = 320 * dt / d;
      p.vx += dx * f;
      p.vy += dy * f;
    }
  }

  /* 右键蓄力：进入熔岩池范围被“熔”掉，转为熔岩滴 */
  const lp = s.lavaPool;
  if (s.chargeR.on && lp.active) {
    const dx = p.x - lp.x;
    const dy = p.y - lp.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < lp.r * lp.r) {
      p.alive = false;
      const a = Math.random() * TAU;
      const sp = spawnSpark(s, p.x, p.y, Math.cos(a) * 40, Math.sin(a) * 40, rand(0.4, 0.9));
      sp.type = T_LAVAFLOW;
      sp.ang = a;
      sp.len = rand(6, 13);
      sp.width = rand(3, 6);
      sp.life = rand(0.4, 0.9);
      return;
    }
  }

  /* 拖尾火舌之间的轻微互相吸引（融合感，抽样处理） */
  if (Math.random() < 0.03) {
    const q = s.pool[(Math.random() * MAXP) | 0];
    if (q.alive && q.type === T_TONGUE && q !== p) {
      const dx = q.x - p.x, dy = q.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > 4 && d2 < 3600) {
        const d = Math.sqrt(d2);
        const f = 42 * dt / d;
        p.vx += dx * f;
        p.vy += dy * f;
      }
    }
  }
}

/* —— 火星 —— */
function updateSpark(p, dt) {
  p.vy += CONFIG.SPARK_GRAVITY * p.grav * dt;
  const d = Math.exp(-1.3 * dt);
  p.vx *= d;
  p.vy *= Math.exp(-0.55 * dt);
  p.x += p.vx * dt;
  p.y += p.vy * dt;
}

/* —— 热浪 —— */
function updateHeat(p, dt) {
  p.x += p.vx * dt;
  p.y -= p.vy * dt;
  p.vx *= Math.exp(-1.6 * dt);
  p.vy *= Math.exp(-0.5 * dt);
}

/* —— 烟 —— */
function updateSmoke(p, dt) {
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  p.vx += Math.sin(p.age * 1.7 + p.seed) * 14 * dt;
  p.vx *= Math.exp(-0.8 * dt);
  p.vy *= Math.exp(-0.35 * dt);
}

/* —— 氧气场空气粒子（被吸向火柱） —— */
function updateAir(p, dt) {
  const dx = p.targx - p.x;
  const dy = p.targy - p.y;
  const d = Math.sqrt(dx * dx + dy * dy) || 1;
  const lr = p.age / p.life;
  const acc = 420 * (1 + lr * 2.4);
  p.vx += dx / d * acc * dt;
  p.vy += dy / d * acc * dt;
  const dm = Math.exp(-1.1 * dt);
  p.vx *= dm;
  p.vy *= dm;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
}

/* —— 熔岩流（黏稠、缓慢、带重力） —— */
function updateLavaFlow(p, dt) {
  const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
  /* 速度越快阻力越大（黏滞流体） */
  const drag = CONFIG.LAVA_DRAG * (1 + sp / 220);
  const dm = Math.exp(-drag * dt);
  p.vx *= dm;
  p.vy *= dm;
  /* 重力 */
  p.vy += CONFIG.LAVA_GRAVITY * dt;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  p.ang = Math.atan2(p.vy, p.vx);
}

/* —— 裂纹 —— */
function updateCrack(p, dt) {
  /* 长度在两段中生长 */
  const lr = p.age / p.life;
  p.width = 1 + Math.sin(p.age * 18 + p.seed) * 0.5;
  if (lr > 0.75) p.width *= (1 - lr) / 0.25;
}

/* —— 岩浆泡 —— */
function updateBubble(p, dt) {
  p.y -= p.rise * dt;
  p.x += Math.sin(p.age * 5 + p.wob) * 6 * dt;
}

/* —— 黑曜石碎片 —— */
function updateObsidian(p, dt) {
  p.vy += 200 * dt;
  p.vx *= Math.exp(-0.8 * dt);
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  p.rot += p.rotV * dt;
  const lr = p.age / p.life;
  p.glow = Math.max(0, 1 - lr * 1.35);
}

/* —— 熔岩弹 —— */
function updateBomb(p, dt) {
  p.vy += 340 * dt;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  p.rot += p.rotV * dt;
  /* 落地判定 */
  if (p.y > p.groundY || p.age > p.life * 0.92) {
    p.age = p.life;  /* 触发死亡回调 */
  }
}

/* —— 余烬 —— */
function updateEmber(p, dt) {
  p.x += Math.sin(p.age * 3 + p.seed) * 4 * dt;
}

/* —— 统一更新入口 —— */
function updateParticle(s, p, dt, t) {
  p.age += dt;
  if (p.age >= p.life) {
    onDeath(s, p);
    p.alive = false;
    return;
  }
  switch (p.type) {
    case T_TONGUE:   updateTongue(s, p, dt, t); break;
    case T_SPARK:    updateSpark(p, dt); break;
    case T_HEAT:     updateHeat(p, dt); break;
    case T_SMOKE:    updateSmoke(p, dt); break;
    case T_AIR:      updateAir(p, dt); break;
    case T_LAVAFLOW: updateLavaFlow(p, dt); break;
    case T_CRACK:    updateCrack(p, dt); break;
    case T_BUBBLE:   updateBubble(p, dt); break;
    case T_OBSIDIAN: updateObsidian(p, dt); break;
    case T_BOMB:     updateBomb(p, dt); break;
    case T_EMBER:    updateEmber(p, dt); break;
  }
}

/* =========================================================
   分区 8 · 火焰绘制
   ========================================================= */

/* —— 火舌：弯曲舌状轮廓 + 温度分层渐变 —— */
function drawTongue(ctx, s, p, t) {
  /* 骨架 / 宽度轮廓的复用缓冲（原型是模块级 Float32Array(8)，这里每实例一份） */
  const _px = s.scratch.px, _py = s.scratch.py;
  const _lx = s.scratch.lx, _ly = s.scratch.ly;
  const _rx = s.scratch.rx, _ry = s.scratch.ry;
  const _hw = s.scratch.hw;

  const lr = p.age / p.life;

  /* 生命周期形态：生成(小) → 盛期(大) → 衰亡(缩小) */
  const grow = Math.min(1, p.age / (p.life * 0.28));
  const fade = 1 - Math.max(0, (lr - 0.62) / 0.38) * 0.85;
  let sizeK = grow * fade;
  if (sizeK <= 0.01) return;

  /* 回燃：体积放大 1.3 倍 */
  sizeK *= (1 + 0.30 * p.flash);

  const L = p.len * sizeK;
  if (L < 2.5) return;

  const N = 6;
  const step = L / (N - 1);

  /* 骨架：贝塞尔式弯曲（角度逐段朝上卷曲 + 抖动） */
  let a = p.baseAng;
  _px[0] = p.x;
  _py[0] = p.y;
  for (let i = 1; i < N; i++) {
    a = angLerp(a, -Math.PI / 2, 0.24);
    const wob = p.wa * (i / (N - 1)) * 1.9;
    a += Math.sin(t * p.wf + p.seed + i * 1.25) * wob;
    _px[i] = _px[i - 1] + Math.cos(a) * step;
    _py[i] = _py[i - 1] + Math.sin(a) * step;
  }

  /* 宽度轮廓：根部宽、尖端窄且圆钝 */
  const w0 = p.w0 * sizeK;
  for (let i = 0; i < N; i++) {
    let dx, dy;
    if (i === 0) { dx = _px[1] - _px[0]; dy = _py[1] - _py[0]; }
    else if (i === N - 1) { dx = _px[N - 1] - _px[N - 2]; dy = _py[N - 1] - _py[N - 2]; }
    else { dx = _px[i + 1] - _px[i - 1]; dy = _py[i + 1] - _py[i - 1]; }
    const dl = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = -dy / dl, ny = dx / dl;
    const tt = i / (N - 1);
    const hwid = (w0 * (1 - 0.86 * tt * tt)) * 0.5 + 0.35;
    _lx[i] = _px[i] + nx * hwid;
    _ly[i] = _py[i] + ny * hwid;
    _rx[i] = _px[i] - nx * hwid;
    _ry[i] = _py[i] - ny * hwid;
    _hw[i] = hwid;
  }

  /* 温度：越年轻越白热，越老越暗红；回燃提升亮度 */
  const temp = clamp(p.heat * (1 + 0.9 * p.flash) * (1 - Math.pow(lr, 1.5)), 0, 1.35);
  const k = clamp(temp, 0, 1);
  const alpha = (0.44 + 0.30 * k) * fade * (1 + 0.5 * p.flash);
  if (alpha <= 0.01) return;

  const C = CONFIG.C;
  /* 四段温度色阶：根部暗红 → 中段橙 → 前段金黄 → 尖端炽白 */
  const c0 = mixStr(C.fireRoot, C.fireHot,  k * 0.85, alpha);
  const c1 = mixStr(C.fireMid,  C.fireHot,  k,        alpha * 1.05);
  const c2 = mixStr(C.fireHot,  C.fireYell, k,        alpha * 1.10);
  const c3 = mixStr(C.fireYell, C.fireWhite, k,       alpha * 0.95);

  let fill;
  if (L > 8) {
    const g = ctx.createLinearGradient(_px[0], _py[0], _px[N - 1], _py[N - 1]);
    g.addColorStop(0.00, c0);
    g.addColorStop(0.35, c1);
    g.addColorStop(0.70, c2);
    g.addColorStop(1.00, c3);
    fill = g;
  } else {
    fill = c2;
  }

  /* 构建舌状轮廓路径 */
  ctx.beginPath();
  ctx.moveTo(_lx[0], _ly[0]);
  for (let i = 1; i < N; i++) ctx.lineTo(_lx[i], _ly[i]);

  /* 圆钝尖端 */
  const tdx = _px[N - 1] - _px[N - 2];
  const tdy = _py[N - 1] - _py[N - 2];
  const tl = Math.sqrt(tdx * tdx + tdy * tdy) || 1;
  const tipCX = _px[N - 1] + tdx / tl * _hw[N - 1] * 1.7;
  const tipCY = _py[N - 1] + tdy / tl * _hw[N - 1] * 1.7;
  ctx.quadraticCurveTo(tipCX, tipCY, _rx[N - 1], _ry[N - 1]);

  for (let i = N - 2; i >= 0; i--) ctx.lineTo(_rx[i], _ry[i]);
  ctx.closePath();

  ctx.fillStyle = fill;
  ctx.fill();
}

/* —— 火星 —— */
function drawSpark(ctx, p, t) {
  const lr = p.age / p.life;
  const a = 1 - lr * lr;
  if (a <= 0.01) return;
  const r = p.size * (1 - lr * 0.45);

  ctx.globalAlpha = a;

  /* 拖尾（沿运动反方向） */
  ctx.strokeStyle = 'rgba(255,120,20,0.72)';
  ctx.lineWidth = r * 1.3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(p.x - p.vx * 0.022, p.y - p.vy * 0.022);
  ctx.lineTo(p.x, p.y);
  ctx.stroke();

  /* 外圈橙红辉光 */
  ctx.fillStyle = 'rgba(255,140,30,0.55)';
  ctx.beginPath();
  ctx.arc(p.x, p.y, r * 2.3, 0, TAU);
  ctx.fill();

  /* 中心纯白 */
  ctx.fillStyle = 'rgba(255,255,242,1)';
  ctx.beginPath();
  ctx.arc(p.x, p.y, r * 0.85, 0, TAU);
  ctx.fill();

  ctx.globalAlpha = 1;
}

/* —— 热浪 —— */
function drawHeat(ctx, s, p, t) {
  const lr = p.age / p.life;
  const a = p.a0 * (1 - lr);
  if (a <= 0.003) return;
  const r = lerp(p.r0, p.r1, Math.pow(lr, 0.55));
  const wob = 1 + 0.16 * Math.sin(t * 3.1 + p.seed);
  const rr = r * wob;
  ctx.globalAlpha = a;
  ctx.drawImage(s.SPR.heat, p.x - rr, p.y - rr, rr * 2, rr * 2);
  ctx.globalAlpha = 1;
}

/* —— 烟 —— */
function drawSmoke(ctx, s, p, t) {
  const lr = p.age / p.life;
  const a = p.a0 * (1 - lr) * (1 - lr * 0.3);
  if (a <= 0.003) return;
  const r = lerp(p.r0, p.r1, Math.pow(lr, 0.6));
  const k = clamp((lr - 0.25) / 0.5, 0, 1);

  if (k < 1) {
    ctx.globalAlpha = a * (1 - k);
    ctx.drawImage(s.SPR.smokeWarm, p.x - r, p.y - r, r * 2, r * 2);
  }
  if (k > 0) {
    ctx.globalAlpha = a * k;
    ctx.drawImage(s.SPR.smokeCool, p.x - r, p.y - r, r * 2, r * 2);
  }
  ctx.globalAlpha = 1;
}

/* —— 氧气场空气粒子 —— */
function drawAir(ctx, p, t) {
  const lr = p.age / p.life;
  const a = 0.16 * (1 - lr) * (0.4 + 0.6 * Math.sin(p.seed + t * 4) * 0.5 + 0.5);
  if (a <= 0.004) return;
  ctx.globalAlpha = a;
  ctx.fillStyle = 'rgba(200,220,255,0.9)';
  ctx.beginPath();
  ctx.arc(p.x, p.y, p.size, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;
}

/* =========================================================
   分区 9 · 熔岩绘制
   ========================================================= */

/* —— 熔岩流：粗圆头短线 + 冷却黑边 + 流动色相 —— */
function drawLavaFlow(ctx, p, t) {
  const lr = p.age / p.life;
  const cool = clamp(lr, 0, 1);
  const a = (1 - Math.pow(lr, 2.2));
  if (a <= 0.01) return;

  const C = CONFIG.C;
  const cx = p.x, cy = p.y;
  const ex = cx - Math.cos(p.ang) * p.len;
  const ey = cy - Math.sin(p.ang) * p.len;

  const w = p.width * (1 - cool * 0.25);

  /* 外层：暗红 → 黑曜石壳 */
  const outerCol = mixStr(C.lavaDark, C.obsidian, Math.pow(cool, 0.8), a * 0.95);
  ctx.strokeStyle = outerCol;
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(cx, cy);
  ctx.stroke();

  /* 内层：亮橙 → 暗红（沿长度方向流动的色相） */
  const phase = (t * 0.9 + p.seed * 0.13) % 1;
  const innerA = (1 - Math.pow(cool, 1.4)) * a;
  const innerCol = mixStr(C.lavaOrng, C.lavaRed, Math.pow(cool, 0.6), innerA);
  const flick = 0.55 + 0.45 * Math.sin(phase * TAU);
  ctx.strokeStyle = innerCol;
  ctx.lineWidth = w * (0.42 + 0.18 * flick);
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(cx, cy);
  ctx.stroke();

  /* 中心高光（未冷却时） */
  if (cool < 0.55) {
    ctx.strokeStyle = mixStr(C.lavaOrng, C.crackGold, 0.4 + 0.6 * flick, innerA * 0.7);
    ctx.lineWidth = w * 0.20;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(cx, cy);
    ctx.stroke();
  }
}

/* —— 裂纹：细发光曲线，缓慢爬行分叉 —— */
function drawCrack(ctx, p, t) {
  const lr = p.age / p.life;
  const a = (1 - lr) * (0.55 + 0.45 * Math.sin(t * 12 + p.seed * 3));
  if (a <= 0.02) return;

  const C = CONFIG.C;
  const flickK = 0.5 + 0.5 * Math.sin(t * 7 + p.seed * 2.1);
  const col = mixStr(C.crackGold, C.lavaOrng, flickK, a);

  const growLen = p.len * Math.min(1, lr / 0.55);
  const seg = Math.max(3, Math.ceil(growLen / 6));

  ctx.strokeStyle = col;
  ctx.lineWidth = p.width;
  ctx.lineCap = 'round';
  ctx.beginPath();

  let x = p.x, y = p.y, ang = p.ang;
  ctx.moveTo(x, y);
  for (let i = 1; i <= seg; i++) {
    ang += Math.sin(i * 1.7 + p.seed) * 0.5 + Math.sin(i * 0.63 + p.seed * 1.7) * 0.35;
    x += Math.cos(ang) * 6;
    y += Math.sin(ang) * 6;
    ctx.lineTo(x, y);
  }
  ctx.stroke();

  /* 分叉 */
  if (p.fork > 0 && seg > 3) {
    ctx.beginPath();
    const bi = Math.max(2, (seg * 0.5) | 0);
    let bx = p.x, by = p.y, ba = p.ang;
    for (let i = 1; i <= bi; i++) {
      ba += Math.sin(i * 1.7 + p.seed) * 0.5 + Math.sin(i * 0.63 + p.seed * 1.7) * 0.35;
      bx += Math.cos(ba) * 6;
      by += Math.sin(ba) * 6;
    }
    ctx.moveTo(bx, by);
    let ba2 = ba + p.fork * 0.9;
    for (let i = 1; i <= seg - bi; i++) {
      ba2 += Math.sin(i * 2.1 + p.seed * 0.7) * 0.6;
      bx += Math.cos(ba2) * 6;
      by += Math.sin(ba2) * 6;
      ctx.lineTo(bx, by);
    }
    ctx.lineWidth = p.width * 0.7;
    ctx.stroke();
  }
}

/* —— 岩浆泡：径向渐变 + 偏上高光 —— */
function drawBubble(ctx, p, t) {
  const lr = p.age / p.life;
  const r = p.size * (1 - Math.pow(lr, 3) * 0.25);
  if (r < 0.5) return;

  const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
  g.addColorStop(0.00, 'rgba(255,200,110,0.95)');
  g.addColorStop(0.35, 'rgba(255,107,26,0.92)');
  g.addColorStop(0.75, 'rgba(139,0,0,0.85)');
  g.addColorStop(1.00, 'rgba(74,14,0,0.55)');

  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, TAU);
  ctx.fill();

  /* 内部高光（偏上椭圆亮斑） */
  if (r > 2) {
    ctx.fillStyle = 'rgba(255,235,190,' + (0.45 * (1 - lr)) + ')';
    ctx.beginPath();
    ctx.ellipse(p.x - r * 0.25, p.y - r * 0.38, r * 0.30, r * 0.20, -0.5, 0, TAU);
    ctx.fill();
  }
}

/* —— 黑曜石碎片：黑色不规则多边形 + 暗红余温边 —— */
function drawObsidian(ctx, p, t) {
  const lr = p.age / p.life;
  const a = 1 - Math.pow(lr, 3);
  if (a <= 0.02) return;

  const n = 3 + (p.seed % 4 | 0);
  const R = p.size;

  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.rot);

  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const ang = i / n * TAU + p.seed;
    const rr = R * (0.7 + 0.5 * Math.abs(Math.sin(p.seed * 3.1 + i * 2.399)));
    const x = Math.cos(ang) * rr;
    const y = Math.sin(ang) * rr;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();

  ctx.fillStyle = 'rgba(26,10,0,' + (0.92 * a) + ')';
  ctx.fill();

  /* 刚冷却的暗红余温边 */
  if (p.glow > 0.02) {
    ctx.strokeStyle = 'rgba(255,60,0,' + (0.75 * p.glow) + ')';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,150,40,' + (0.35 * p.glow) + ')';
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }
  ctx.restore();
}

/* —— 熔岩弹：不规则团块 + 尾迹小滴 —— */
function drawBomb(ctx, p, t) {
  const lr = p.age / p.life;
  const a = 1 - Math.pow(lr, 2.5);
  if (a <= 0.02) return;

  const R = p.size * (1 - lr * 0.15);

  /* 尾迹 3 个熔岩滴 */
  for (let i = 1; i <= 3; i++) {
    const f = i * 0.035;
    const tx = p.x - p.vx * f;
    const ty = p.y - p.vy * f;
    const tr = R * (0.42 - i * 0.09);
    if (tr <= 0.3) continue;
    ctx.fillStyle = 'rgba(255,107,26,' + (a * (0.55 - i * 0.12)) + ')';
    ctx.beginPath();
    ctx.arc(tx, ty, tr, 0, TAU);
    ctx.fill();
  }

  /* 本体：圆形 + 半径扰动 */
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.rot);

  const n = 12;
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const ang = i / n * TAU;
    const rr = R * (1 + 0.28 * Math.sin(ang * 3 + p.seed) + 0.18 * Math.sin(ang * 5 - p.seed * 2));
    const x = Math.cos(ang) * rr;
    const y = Math.sin(ang) * rr;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();

  const g = ctx.createRadialGradient(-R * 0.25, -R * 0.25, 0, 0, 0, R * 1.3);
  g.addColorStop(0.00, 'rgba(255,220,140,' + (0.95 * a) + ')');
  g.addColorStop(0.35, 'rgba(255,140,30,' + (0.9 * a) + ')');
  g.addColorStop(0.72, 'rgba(180,40,0,' + (0.85 * a) + ')');
  g.addColorStop(1.00, 'rgba(58,10,0,' + (0.7 * a) + ')');
  ctx.fillStyle = g;
  ctx.fill();

  ctx.strokeStyle = 'rgba(26,10,0,' + (0.7 * a) + ')';
  ctx.lineWidth = 1.6;
  ctx.stroke();

  ctx.restore();
}

/* —— 余烬 / 余温 —— */
function drawEmber(ctx, p, t) {
  const lr = p.age / p.life;
  const flick = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * p.wf + p.seed));
  const a = (1 - lr) * flick * p.heat;
  if (a <= 0.01) return;
  const r = p.size * (1 - lr * 0.4);

  ctx.globalAlpha = a;
  ctx.fillStyle = 'rgba(255,90,10,0.9)';
  ctx.beginPath();
  ctx.arc(p.x, p.y, r * 2.0, 0, TAU);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,200,120,0.95)';
  ctx.beginPath();
  ctx.arc(p.x, p.y, r * 0.7, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;
}

/* —— 绘制分发 —— */
function drawParticle(ctx, s, p, t) {
  switch (p.type) {
    case T_TONGUE:   drawTongue(ctx, s, p, t); break;
    case T_SPARK:    drawSpark(ctx, p, t); break;
    case T_HEAT:     drawHeat(ctx, s, p, t); break;
    case T_SMOKE:    drawSmoke(ctx, s, p, t); break;
    case T_AIR:      drawAir(ctx, p, t); break;
    case T_LAVAFLOW: drawLavaFlow(ctx, p, t); break;
    case T_CRACK:    drawCrack(ctx, p, t); break;
    case T_BUBBLE:   drawBubble(ctx, p, t); break;
    case T_OBSIDIAN: drawObsidian(ctx, p, t); break;
    case T_BOMB:     drawBomb(ctx, p, t); break;
    case T_EMBER:    drawEmber(ctx, p, t); break;
  }
}

/* =========================================================
   分区 10 · 熔岩池（右键蓄力主体，程序化绘制）
   ========================================================= */
const POOL_N = 26;

function lavaPoolPath(ctx, cx, cy, R, rot, t, seed) {
  ctx.beginPath();
  for (let i = 0; i <= POOL_N; i++) {
    const ii = i % POOL_N;
    const a = rot + ii / POOL_N * TAU;
    const wob = 1
      + 0.10 * Math.sin(a * 3 + t * 1.3 + seed)
      + 0.07 * Math.sin(a * 5 - t * 0.9 + seed * 2.1)
      + 0.05 * Math.sin(a * 7 + t * 2.1 + seed * 0.7);
    const rr = R * wob;
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawLavaPool(ctx, lp, t) {
  if (!lp.active) return;
  const c = lp.charge;
  const R = lp.r;
  if (R < 2) return;
  const cx = lp.x, cy = lp.y;

  /* 主体渐变填充 */
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.08);
  g.addColorStop(0.00, 'rgba(255,205,90,' + (0.55 + 0.35 * c) + ')');
  g.addColorStop(0.30, 'rgba(255,107,26,' + (0.50 + 0.30 * c) + ')');
  g.addColorStop(0.68, 'rgba(139,0,0,' + (0.45 + 0.25 * c) + ')');
  g.addColorStop(1.00, 'rgba(26,10,0,0.62)');

  lavaPoolPath(ctx, cx, cy, R, lp.rot, t, lp.seed);
  ctx.fillStyle = g;
  ctx.fill();

  /* 表面流动光带（跟随旋转） */
  ctx.save();
  lavaPoolPath(ctx, cx, cy, R, lp.rot, t, lp.seed);
  ctx.clip();

  for (let i = 0; i < 3; i++) {
    const a0 = lp.rot * 1.6 + i * 2.1 + t * 0.35;
    const rr = R * (0.28 + 0.22 * i);
    ctx.beginPath();
    ctx.arc(cx, cy, rr, a0, a0 + 1.5);
    ctx.strokeStyle = 'rgba(255,179,71,' + (0.10 + 0.10 * c) + ')';
    ctx.lineWidth = 7 + 8 * c;
    ctx.lineCap = 'round';
    ctx.stroke();
  }
  /* 内部高亮核心 */
  const gg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.55);
  gg.addColorStop(0, 'rgba(255,230,150,' + (0.18 + 0.30 * c) + ')');
  gg.addColorStop(1, 'rgba(255,120,20,0)');
  ctx.fillStyle = gg;
  ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

  ctx.restore();

  /* 黑曜石边缘壳（随蓄力增厚） */
  lavaPoolPath(ctx, cx, cy, R, lp.rot, t, lp.seed);
  ctx.lineWidth = 2 + 6 * c;
  ctx.strokeStyle = 'rgba(26,10,0,0.92)';
  ctx.stroke();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = 'rgba(255,70,0,' + (0.22 + 0.40 * c) + ')';
  ctx.stroke();
}

/* =========================================================
   分区 12 · 拖尾
   ========================================================= */
function emitTrail(s, dt, dx, dy, dist) {
  const M = s.input;
  const ang = Math.atan2(dy, dx);
  const speed = dist / Math.max(dt, 1e-4);
  const speedK = clamp(speed / 900, 0, 1);

  /* —— 火舌 —— */
  let nT = Math.min(CONFIG.TRAIL_MAX_TONGUE, dist * CONFIG.TRAIL_PER_PX);
  nT += Math.random();
  const nTongue = Math.floor(nT);

  for (let i = 0; i < nTongue; i++) {
    const f = Math.random();
    const px = M.x - dx * (1 - f) + rand(-7, 7);
    const py = M.y - dy * (1 - f) + rand(-7, 7);
    const a = ang + rand(-0.55, 0.55);
    const baseLen = rand(CONFIG.TRAIL_TONGUE_LEN[0], CONFIG.TRAIL_TONGUE_LEN[1]);
    const len = baseLen * (0.65 + 0.85 * speedK);
    const spd = rand(18, 90) * (0.45 + speedK);
    spawnTongue(
      s, px, py,
      Math.cos(a) * spd,
      Math.sin(a) * spd,
      len,
      rand(CONFIG.TRAIL_TONGUE_LIFE[0], CONFIG.TRAIL_TONGUE_LIFE[1]),
      0.72 + 0.42 * speedK
    );
  }

  /* —— 火星 —— */
  let nS = Math.min(CONFIG.TRAIL_SPARK_MAX, dist * CONFIG.TRAIL_SPARK_PER_PX);
  nS += Math.random();
  const nSpark = Math.floor(nS);

  for (let i = 0; i < nSpark; i++) {
    const px = M.x + rand(-6, 6);
    const py = M.y + rand(-6, 6);
    const a = Math.random() * TAU;
    const sp = rand(50, 300) * (0.5 + speedK);
    spawnSpark(
      s, px, py,
      Math.cos(a) * sp + s.rawVx * 0.14,
      Math.sin(a) * sp + s.rawVy * 0.14,
      rand(0.35, 0.95)
    );
  }

  /* 高速时补一缕热浪 */
  if (speedK > 0.45 && Math.random() < 0.35) {
    spawnHeat(s, M.x + rand(-14, 14), M.y + rand(-14, 14),
      rand(24, 46), rand(50, 90), rand(0.02, 0.05), rand(0.5, 0.9));
  }
}

/* =========================================================
   分区 13 · 单击（打火石迸火） + 回燃 Flashover
   ========================================================= */
function ignitionBurst(s, x, y) {
  /* 6~10 条火舌，向外燃烧后转向上卷 */
  const n = 6 + (Math.random() * 5 | 0);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU;
    const sp = rand(60, 200);
    spawnTongue(
      s, x + rand(-4, 4), y + rand(-4, 4),
      Math.cos(a) * sp, Math.sin(a) * sp - 40,
      rand(18, 46), rand(0.45, 0.85), 1.15
    );
  }

  /* 15~22 个火星 */
  const ns = 15 + (Math.random() * 8 | 0);
  for (let i = 0; i < ns; i++) {
    const a = Math.random() * TAU;
    const sp = rand(200, 500);
    spawnSpark(s, x, y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.5, 1.1));
  }

  /* 一圈短寿命热浪 */
  for (let i = 0; i < 10; i++) {
    const a = i / 10 * TAU + Math.random() * 0.3;
    const r = rand(6, 14);
    spawnHeat(s, x + Math.cos(a) * r, y + Math.sin(a) * r,
      10, rand(46, 62), 0.15, 0.42, rand(-8, 8));
  }

  /* 点火瞬间高光 */
  spawnHeat(s, x, y, 2, 9, 0.85, 0.085, 0);
}

/* —— 回燃：R 内所有火舌/火星被重新点燃 —— */
function flashover(s, x, y) {
  const R = CONFIG.FLASHOVER_R;
  const R2 = R * R;

  for (let i = 0; i < MAXP; i++) {
    const p = s.pool[i];
    if (!p.alive) continue;

    const dx = p.x - x;
    const dy = p.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 > R2) continue;

    const d = Math.sqrt(d2) || 1;

    if (p.type === T_TONGUE) {
      /* 寿命重置到年轻状态 */
      p.age *= 0.14;
      p.flash = 1;
      /* 向上冲量 + 轻微朝光标 */
      p.vx += -dx / d * 70 + rand(-40, 40);
      p.vy += -280 - 160 * (1 - d / R);
      /* 复燃闪光环（不规则） */
      if (Math.random() < 0.35) {
        spawnHeat(s, p.x, p.y, 8, rand(34, 60), 0.10, 0.25, rand(-14, -2));
      }
    } else if (p.type === T_SPARK) {
      p.vy -= 220;
      p.age *= 0.4;
      p.life *= 1.3;
    }
  }
}

/* =========================================================
   分区 14 · 左键 —— 火种 → 燎原
   ========================================================= */
function updateChargeL(s, dt, t) {
  const ch = s.chargeL;
  const M = s.input;
  ch.t = Math.min(ch.t + dt, CONFIG.CHARGE_MAX);
  const c = ch.t / CONFIG.CHARGE_MAX;

  /* 微震（>55% 后 1~3px 高频抖动） */
  let cx = M.x, cy = M.y;
  if (c > 0.55) {
    const amp = (c - 0.55) / 0.45 * 3;
    cx += (Math.random() * 2 - 1) * amp;
    cy += (Math.random() * 2 - 1) * amp;
  }
  ch.x = cx;
  ch.y = cy;

  /* 火柱低频呼吸（膨胀时拉高） */
  const breath = 1 + Math.sin(t * 3.4) * 0.10 * c + Math.sin(t * 1.7 + 1.3) * 0.06 * c;
  const pillarH = lerp(CONFIG.PILLAR_MIN, CONFIG.PILLAR_MAX, c) * breath;
  const spread = 6 + 34 * c;
  const oxyR = lerp(CONFIG.OXY_R_MIN, CONFIG.OXY_R_MAX, c);

  /* —— 火舌生成 —— */
  const tongueRate = 10 + 130 * c;
  ch.tongueAcc += tongueRate * dt;
  while (ch.tongueAcc >= 1) {
    ch.tongueAcc -= 1;

    const ox = (Math.random() * 2 - 1) * spread;
    const centerBias = 1 - Math.min(1, Math.abs(ox) / Math.max(1, spread));
    const heat = (1 + 0.65 * c) * (0.72 + 0.62 * centerBias);
    const len = rand(18, 58) * (0.5 + 0.85 * c);
    const vy = -lerp(70, 240, c) * rand(0.7, 1.35);

    spawnTongue(
      s, cx + ox, cy + rand(-4, 10),
      ox * 2.6, vy,
      len, rand(0.32, 0.68), heat
    );

    /* 内芯白热：靠近中心生成更短更白的小火舌 */
    if (centerBias > 0.6 && Math.random() < 0.5) {
      spawnTongue(
        s, cx + ox * 0.35, cy + rand(-2, 4),
        ox * 1.2, vy * 0.85,
        len * 0.6, rand(0.25, 0.5), heat * 1.5
      );
    }
  }

  /* —— 火势蔓延：>1s 后向两侧伸出分支 —— */
  if (c > 0.4 && Math.random() < 0.45) {
    const side = Math.random() < 0.5 ? -1 : 1;
    spawnTongue(
      s, cx + side * spread * 0.85,
      cy - rand(0, pillarH * 0.55),
      side * rand(40, 150),
      -rand(30, 110),
      rand(14, 40), rand(0.28, 0.6), 1 + 0.6 * c
    );
  }

  /* —— 氧气场：空气粒子被吸向火柱 —— */
  const airRate = 8 + 50 * c;
  ch.sparkAcc += airRate * dt;
  while (ch.sparkAcc >= 1) {
    ch.sparkAcc -= 1;
    const a = Math.random() * TAU;
    const r = oxyR * (0.45 + 0.55 * Math.random());
    spawnAir(s, cx + Math.cos(a) * r, cy + Math.sin(a) * r,
      cx + rand(-8, 8), cy - pillarH * 0.35);
  }

  /* —— 火星飞溅（火柱顶端） —— */
  if (Math.random() < (0.35 + 1.1 * c) * dt * 60 / 6) {
    const topY = cy - pillarH * rand(0.75, 1.05);
    const a = -Math.PI / 2 + rand(-0.9, 0.9);
    const sp = rand(160, 480) * (0.6 + c);
    spawnSpark(s, cx + rand(-spread, spread), topY,
      Math.cos(a) * sp, Math.sin(a) * sp, rand(0.6, 1.4));
  }

  /* —— 热浪围绕火柱 —— */
  if (Math.random() < 0.55) {
    spawnHeat(
      s,
      cx + rand(-spread * 1.4, spread * 1.4),
      cy - Math.random() * pillarH * 0.8,
      rand(16, 34), rand(48, 90),
      rand(0.02, 0.045), rand(0.5, 1.0)
    );
  }

  /* —— 顶端烟 —— */
  if (c > 0.35 && Math.random() < 0.35) {
    spawnSmoke(s, cx + rand(-14, 14), cy - pillarH - rand(0, 20),
      rand(16, 34), rand(1.0, 1.9));
  }

  /* 污染拖尾：蓄力时移动仍生成拖尾，被火柱吸引（在 updateTongue 中处理） */
}

/* —— 左键松开：爆发 —— */
function releaseLeft(s) {
  const ch = s.chargeL;
  const held = ch.t;
  const c = clamp(ch.t / CONFIG.CHARGE_MAX, 0, 1);
  const power = Math.pow(c, 1.6);
  const x = ch.x, y = ch.y;

  ch.on = false;
  ch.t = 0;
  ch.tongueAcc = 0;
  ch.sparkAcc = 0;

  if (held < CONFIG.TAP_THRESHOLD) return;  /* 视为普通单击，已处理 */

  /* ① 火柱冲天：整体向上猛烈冲出 */
  const n = 34 + Math.floor(110 * power);
  for (let i = 0; i < n; i++) {
    const ox = (Math.random() * 2 - 1) * (12 + 46 * power);
    const vy = -(400 + 1200 * power) * rand(0.65, 1.35);
    const vx = ox * 2.8 + rand(-60, 60);
    const len = rand(40, 130) * (0.6 + 0.9 * power);
    spawnTongue(
      s, x + ox, y + rand(-6, 14),
      vx, vy, len,
      rand(0.65, 1.5),
      1.4 + 0.5 * power
    );
  }

  /* ② 热浪冲击：一圈带扭曲的模糊光带 */
  const waveR = 200 + 450 * power;
  const rings = 18;
  for (let i = 0; i < rings; i++) {
    const a = i / rings * TAU + Math.random() * 0.25;
    const r0 = rand(20, 40);
    spawnHeat(
      s,
      x + Math.cos(a) * r0,
      y + Math.sin(a) * r0,
      30, waveR * rand(0.55, 0.95),
      0.055, 0.7,
      rand(-10, 10)
    );
  }
  /* 中心补一层 */
  for (let i = 0; i < 6; i++) {
    spawnHeat(s, x + rand(-24, 24), y + rand(-24, 24),
      26, rand(120, waveR * 0.7), 0.05, 0.65, rand(-8, 8));
  }

  /* ③ 火星风暴 */
  const ns = Math.floor(80 + 250 * power);
  for (let i = 0; i < ns; i++) {
    const a = -Math.PI / 2 + rand(-1.15, 1.15);
    const sp = (300 + 900 * power) * rand(0.35, 1.15);
    spawnSpark(
      s, x + rand(-16, 16), y + rand(-8, 8),
      Math.cos(a) * sp, Math.sin(a) * sp,
      rand(0.8, 2.2)
    );
  }

  /* ④ 余烬落地：约 30% 低速火星形成余烬地 */
  const ne = Math.floor(18 + 46 * power);
  for (let i = 0; i < ne; i++) {
    const a = Math.random() * TAU;
    const sp = rand(40, 170);
    spawnSpark(s, x, y, Math.cos(a) * sp, Math.sin(a) * sp - rand(20, 90), rand(0.9, 1.7));
    spawnEmber(s, x + rand(-40, 40), y + rand(10, 60), rand(1.0, 1.6), 0.85);
  }

  /* ⑤ 回燃席卷：全场拖尾复燃 */
  flashover(s, x, y);

  /* ⑥ 余烟（1.5s 内持续） */
  s.post.smoke = 1.5;
  s.post.smokeX = x;
  s.post.smokeY = y;

  /* ⑦ 余温 */
  s.post.ember = 1.5;
  s.post.emberX = x;
  s.post.emberY = y;
}

/* =========================================================
   分区 15 · 右键 —— 熔融 → 熔岩
   ========================================================= */
function updateChargeR(s, dt, t) {
  const ch = s.chargeR;
  const M = s.input;
  const lp = s.lavaPool;
  ch.t = Math.min(ch.t + dt, CONFIG.CHARGE_MAX);
  const c = ch.t / CONFIG.CHARGE_MAX;
  const power = Math.pow(c, 1.6);

  /* 微震：频率比左键低、幅度比左键大 */
  let cx = M.x, cy = M.y;
  if (c > 0.55) {
    const amp = (c - 0.55) / 0.45 * 3.5;
    cx += Math.sin(t * 21) * amp * 0.6 + rand(-amp * 0.4, amp * 0.4);
    cy += Math.sin(t * 18.3) * amp * 0.6 + rand(-amp * 0.4, amp * 0.4);
  }

  lp.active = true;
  lp.x = cx;
  lp.y = cy;
  lp.r = lerp(CONFIG.POOL_R_MIN, CONFIG.POOL_R_MAX, power);
  lp.charge = c;
  lp.rot += (0.10 + 0.22 * c) * dt;

  /* —— 岩浆泡 —— */
  ch.bubbleAcc += (2 + 14 * c) * dt;
  while (ch.bubbleAcc >= 1) {
    ch.bubbleAcc -= 1;
    const a = Math.random() * TAU;
    const r = lp.r * Math.sqrt(Math.random()) * 0.75;
    spawnBubble(s, cx + Math.cos(a) * r, cy + Math.sin(a) * r, rand(2, 6));
  }

  /* —— 表面裂纹（>0.5s 后开始） —— */
  if (c > 0.2) {
    ch.crackAcc += (1 + 9 * (c - 0.2) / 0.8) * dt;
    while (ch.crackAcc >= 1) {
      ch.crackAcc -= 1;
      const a = Math.random() * TAU;
      const r = lp.r * Math.sqrt(Math.random()) * 0.85;
      spawnCrack(
        s,
        cx + Math.cos(a) * r,
        cy + Math.sin(a) * r,
        Math.random() * TAU,
        rand(14, 40),
        rand(0.8, 1.5),
        Math.random() < 0.5 ? (Math.random() < 0.5 ? 1 : -1) : 0
      );
    }
  }

  /* —— 熔岩外溢（>1.2s） —— */
  if (c > 0.48) {
    ch.overflowAcc += (2 + 12 * c) * dt;
    while (ch.overflowAcc >= 1) {
      ch.overflowAcc -= 1;
      const a = Math.random() * TAU;
      const rr = lp.r * 0.92;
      spawnLavaFlow(
        s,
        cx + Math.cos(a) * rr,
        cy + Math.sin(a) * rr,
        a, rand(20, 60), rand(8, 20), rand(4, 8), rand(1.0, 2.0)
      );
    }
  }

  /* —— 边缘余温点 —— */
  if (Math.random() < 0.35) {
    const a = Math.random() * TAU;
    spawnEmber(
      s,
      cx + Math.cos(a) * lp.r * rand(0.85, 1.05),
      cy + Math.sin(a) * lp.r * rand(0.85, 1.05),
      rand(0.5, 1.1), 0.9
    );
  }
}

/* —— 右键松开：熔岩四溢 —— */
function releaseRight(s) {
  const ch = s.chargeR;
  const lp = s.lavaPool;
  const held = ch.t;
  const c = clamp(ch.t / CONFIG.CHARGE_MAX, 0, 1);
  const power = Math.pow(c, 1.6);
  const x = lp.x, y = lp.y;
  const R = lp.r;

  ch.on = false;
  ch.t = 0;
  lp.active = false;

  if (held < CONFIG.TAP_THRESHOLD) {
    /* 普通右键点击：小片熔岩快速溢出 + 几个岩浆泡破裂 */
    for (let i = 0; i < 8; i++) {
      const a = Math.random() * TAU;
      spawnLavaFlow(s, x, y, a, rand(30, 80), rand(8, 16), rand(4, 7), rand(0.8, 1.6));
    }
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * TAU;
      const rr = rand(4, 18);
      spawnBubble(s, x + Math.cos(a) * rr, y + Math.sin(a) * rr, rand(2, 5));
    }
    spawnHeat(s, x, y, 10, 46, 0.10, 0.4, 0);
    return;
  }

  /* ① 熔岩四溢：向四周缓慢流淌 */
  const nFlow = 26 + Math.floor(60 * power);
  for (let i = 0; i < nFlow; i++) {
    const a = i / nFlow * TAU + rand(-0.12, 0.12);
    const sp = (80 + 250 * power) * rand(0.55, 1.25);
    spawnLavaFlow(
      s,
      x + Math.cos(a) * R * 0.7,
      y + Math.sin(a) * R * 0.7,
      a, sp,
      rand(10, 26),
      rand(4, 10),
      rand(1.0, 2.2)
    );
  }

  /* ② 裂隙喷溅：流淌路径上 4~8 处小喷溅 */
  const nFissure = 4 + (Math.random() * 5 | 0);
  for (let i = 0; i < nFissure; i++) {
    const a = Math.random() * TAU;
    const d = rand(R, R + 60 + 220 * power);
    const fx = x + Math.cos(a) * d;
    const fy = y + Math.sin(a) * d;
    const cnt = 6 + (Math.random() * 8 | 0);
    for (let j = 0; j < cnt; j++) {
      const aa = -Math.PI / 2 + rand(-0.7, 0.7);
      const ss = rand(90, 230) * (0.5 + power);
      const sp = spawnSpark(s, fx, fy, Math.cos(aa) * ss, Math.sin(aa) * ss, rand(0.6, 1.2));
      sp.type = T_LAVAFLOW;
      sp.ang = aa;
      sp.len = rand(7, 16);
      sp.width = rand(4, 8);
      sp.life = rand(0.6, 1.2);
    }
    spawnEmber(s, fx, fy, rand(0.8, 1.6), 0.9);
  }

  /* ③ 熔岩弹抛射 */
  const nBomb = Math.floor(8 + 30 * power);
  for (let i = 0; i < nBomb; i++) {
    const a = -Math.PI / 2 + rand(-1.35, 1.35);
    const sp = rand(180, 480) * (0.6 + 0.7 * power);
    spawnBomb(
      s,
      x + rand(-10, 10), y + rand(-10, 10),
      Math.cos(a) * sp, Math.sin(a) * sp,
      rand(3, 8)
    );
  }

  /* ④ 黑曜石碎片 */
  const nObs = Math.floor(15 + 50 * power);
  for (let i = 0; i < nObs; i++) {
    const a = Math.random() * TAU;
    const sp = rand(30, 160) * (0.6 + power);
    spawnObsidian(
      s,
      x + Math.cos(a) * R * 0.8,
      y + Math.sin(a) * R * 0.8,
      rand(2.5, 7),
      Math.cos(a) * sp, Math.sin(a) * sp - rand(20, 90)
    );
  }

  /* ⑤ 地面裂纹（非圆环） */
  const nCrack = 10 + Math.floor(16 * power);
  for (let i = 0; i < nCrack; i++) {
    const a = i / nCrack * TAU + rand(-0.2, 0.2);
    spawnCrack(
      s,
      x + Math.cos(a) * R * 0.6,
      y + Math.sin(a) * R * 0.6,
      a,
      150 + 400 * power,
      rand(1.0, 2.0),
      Math.random() < 0.7 ? (Math.random() < 0.5 ? 1 : -1) : 0
    );
  }

  /* ⑥ 岩浆喷柱（次要，不能盖过四溢主视觉） */
  const colH = 80 + 200 * power;
  const nCol = 12 + Math.floor(20 * power);
  for (let i = 0; i < nCol; i++) {
    const a = -Math.PI / 2 + rand(-0.45, 0.45);
    const sp = rand(160, 380) * (0.5 + power);
    const spk = spawnSpark(s, x + rand(-8, 8), y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.5, 1.1));
    spk.type = T_LAVAFLOW;
    spk.ang = a;
    spk.len = rand(8, 18);
    spk.width = rand(4, 9);
    spk.life = rand(0.5, 1.0);
  }
  spawnHeat(s, x, y - colH * 0.3, 20, 60 + colH * 0.4, 0.05, 0.5, 0);

  /* ⑦ 余温区 */
  for (let i = 0; i < 40; i++) {
    const a = Math.random() * TAU;
    const rr = Math.sqrt(Math.random()) * (R + 60 + 160 * power);
    spawnEmber(s, x + Math.cos(a) * rr, y + Math.sin(a) * rr, rand(0.9, 1.6), 0.95);
  }
  s.post.ember = 1.5;
  s.post.emberX = x;
  s.post.emberY = y;
}

/* =========================================================
   分区 16 · 后效更新（余烟 / 余温）
   ========================================================= */
function updatePost(s, dt) {
  const post = s.post;
  if (post.smoke > 0) {
    post.smoke -= dt;
    if (Math.random() < 0.85) {
      spawnSmoke(
        s,
        post.smokeX + rand(-46, 46),
        post.smokeY + rand(-24, 24),
        rand(20, 46),
        rand(1.2, 2.4)
      );
    }
    if (Math.random() < 0.35) {
      spawnHeat(
        s,
        post.smokeX + rand(-60, 60),
        post.smokeY + rand(-40, 40),
        rand(20, 40), rand(60, 120), rand(0.02, 0.04), rand(0.6, 1.2)
      );
    }
  }
  if (post.ember > 0) {
    post.ember -= dt;
    if (Math.random() < 0.55) {
      spawnEmber(
        s,
        post.emberX + rand(-70, 70),
        post.emberY + rand(-40, 60),
        rand(0.6, 1.3), 0.8
      );
    }
  }
}

export class CursorFirefang extends CursorEffectElement {
  /** 主题光标：橙红描边 + 火星装饰 */
  cursorTheme() {
    return {
      edge: '#ffa445',
      fill: 'rgba(42, 18, 6, .88)',
      glow: '#ff7a2f',
      deco: { color: [255, 168, 70], style: 'spark', rate: 16, speedGain: 0.26 }
    };
  }

  // 原型用 mousemove / mousedown / mouseup（不是 pointer 事件族），
  // 不声明这一行，基类会去监听 pointermove，动效将完全收不到鼠标输入。
  inputFamily = 'mouse';

  /* =========================================================
     初始化
     ========================================================= */
  // 只建池与状态，不注册任何监听（监听、DPR 缩放、rAF 全归基类）
  setup({ canvas, ctx, width, height, input }) {
    const pool = new Array(MAXP);
    for (let i = 0; i < MAXP; i++) pool[i] = newParticle();

    return {
      // 本实例的画布上下文（已按 DPR 缩放过，统一使用 CSS 像素坐标）
      ctx,

      // 画布尺寸（CSS 像素），由基类 onResize 同步
      W: width,
      H: height,

      input,

      // 原型口径的鼠标速度：原始逐帧位移 / dt，不平滑、无钳制、无上限。
      // 基类 input.vx / vy 是平滑值（且带 >300px 归零、6000 封顶），
      // 这里另存一份原始速度，只有拖尾火星的漂移项用它。
      rawVx: 0,
      rawVy: 0,

      // 原型 mouse.has：首次移动之前不生成拖尾，也不飘静止热浪
      has: false,

      // 帧级时钟（秒），对应原型的 now / 1000；只影响正弦相位起点
      time: 0,

      // 离屏光斑贴图的创建者：用元素自身的 ownerDocument，不碰全局对象，也绝不挂进 DOM
      doc: canvas.ownerDocument,
      SPR: buildSprites(canvas.ownerDocument),

      // 粒子池与环形游标
      pool,
      ring: 0,

      // 火舌骨架 / 宽度轮廓的复用缓冲（原型是模块级 Float32Array(8)，这里每实例一份）
      scratch: {
        px: new Float32Array(8), py: new Float32Array(8),
        lx: new Float32Array(8), ly: new Float32Array(8),
        rx: new Float32Array(8), ry: new Float32Array(8),
        hw: new Float32Array(8)
      },

      // 按键按下标记：决定 mouseup 是否触发收尾（原型 leftDown / rightDown）
      leftDown: false,
      rightDown: false,

      // 左键火种蓄力（原型的 chargeL，smokeTimer 从未被读取，未移植）
      chargeL: { on: false, t: 0, x: 0, y: 0, tongueAcc: 0, sparkAcc: 0 },

      // 右键熔岩蓄力
      chargeR: { on: false, t: 0, x: 0, y: 0, bubbleAcc: 0, crackAcc: 0, overflowAcc: 0 },

      // 熔岩池
      lavaPool: { active: false, x: 0, y: 0, r: 0, rot: 0, seed: Math.random() * 100, charge: 0 },

      // 爆发后效计时器
      post: { smoke: 0, smokeX: 0, smokeY: 0, ember: 0, emberX: 0, emberY: 0 }
    };
  }

  /* =========================================================
     输入（按键）—— 鼠标位移由基类写入 this.input，原始速度在 update() 里算好存入 state
     ========================================================= */
  onPointerDown(e) {
    const s = this.state;
    if (!s) return;

    // 与原型一致：以 mousedown 的事件坐标作为蓄力 / 爆发原点
    if (e.button === 0) {
      s.leftDown = true;
      const ch = s.chargeL;
      ch.on = true;
      ch.t = 0;
      ch.x = e.clientX;
      ch.y = e.clientY;
      ch.tongueAcc = 0;
      ch.sparkAcc = 0;

      /* 打火石迸出火苗 */
      ignitionBurst(s, e.clientX, e.clientY);
      /* 回燃：周围拖尾集体复燃 */
      flashover(s, e.clientX, e.clientY);
    } else if (e.button === 2) {
      s.rightDown = true;
      const ch = s.chargeR;
      ch.on = true;
      ch.t = 0;
      ch.x = e.clientX;
      ch.y = e.clientY;
      ch.bubbleAcc = 0;
      ch.crackAcc = 0;
      ch.overflowAcc = 0;

      const lp = s.lavaPool;
      lp.active = true;
      lp.x = e.clientX;
      lp.y = e.clientY;
      lp.r = CONFIG.POOL_R_MIN * 0.5;
      lp.charge = 0;
      lp.seed = Math.random() * 100;
    }
  }

  onPointerUp(e) {
    const s = this.state;
    if (!s) return;

    if (e.button === 0 && s.leftDown) {
      s.leftDown = false;
      releaseLeft(s);
    } else if (e.button === 2 && s.rightDown) {
      s.rightDown = false;
      releaseRight(s);
    }
  }

  // 失焦清理：原型 window blur 的行为（只清按键态，不触发任何爆发）
  onBlur() {
    const s = this.state;
    if (!s) return;
    s.leftDown = false;
    s.rightDown = false;
    s.chargeL.on = false;
    s.chargeL.t = 0;
    s.chargeR.on = false;
    s.chargeR.t = 0;
    s.lavaPool.active = false;
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
     更新（对应原型分区 18 的 frame()）
     ========================================================= */
  update(dt, s) {
    if (!s) return;
    const M = s.input;
    s.time += dt;
    const t = s.time;

    /* —— 鼠标位移 & 速度 —— */
    // 原型用未平滑的 mouse.vx / vy（第 1844~1846 行），基类的 input.vx / vy 是平滑值，
    // 且带「>300px 归零、6000 封顶」保护，与原型不符，这里照原型复算。
    let dx = M.x - M.lx;
    let dy = M.y - M.ly;

    // 原型的 mouse.px / py 只在首次 mousemove 时对齐一次（第 1167~1171 行），
    // 所以第一次移动不产生拖尾：这里把首次移动的位移抹平，has 随即置位。
    if (!s.has && (dx !== 0 || dy !== 0)) {
      s.has = true;
      dx = 0;
      dy = 0;
    }

    const dist = Math.sqrt(dx * dx + dy * dy);
    const idt = Math.max(dt, 1e-4);
    s.rawVx = dx / idt;
    s.rawVy = dy / idt;

    /* —— 粒子更新（先于本帧生成，与原型顺序一致） —— */
    for (let i = 0; i < MAXP; i++) {
      const p = s.pool[i];
      if (!p.alive) continue;
      updateParticle(s, p, dt, t);
    }

    /* —— 交互状态 —— */
    if (s.chargeL.on) {
      updateChargeL(s, dt, t);
      /* 蓄力时移动仍产生拖尾，被火柱吸引 */
      if (dist > CONFIG.TRAIL_MIN_DIST) emitTrail(s, dt, dx, dy, dist);
    } else if (s.chargeR.on) {
      updateChargeR(s, dt, t);
      if (dist > CONFIG.TRAIL_MIN_DIST) emitTrail(s, dt, dx, dy, dist);
    } else if (dist > CONFIG.TRAIL_MIN_DIST) {
      emitTrail(s, dt, dx, dy, dist);
    } else if (s.has && Math.random() < 0.05) {
      /* 静止时极少量热浪飘起 */
      spawnHeat(s, M.x + rand(-8, 8), M.y + rand(-4, 4),
        rand(12, 26), rand(36, 64), rand(0.012, 0.028), rand(0.6, 1.1));
    }

    /* —— 后效 —— */
    updatePost(s, dt);
  }

  /* =========================================================
     渲染（对应原型分区 17 的 render()）
     ========================================================= */
  render(s) {
    if (!s) return;
    const ctx = s.ctx;
    const t = s.time;

    // 原型此处就是 clearRect（页面底色在 CSS 的 html,body 上，不是画布填充），
    // 因此没有整屏铺底可删；画布保持透明，绝不覆盖宿主页面。
    ctx.clearRect(0, 0, s.W, s.H);

    /* 熔岩池（垫在熔岩粒子下方） */
    if (s.lavaPool.active) {
      ctx.globalCompositeOperation = 'lighter';
      drawLavaPool(ctx, s.lavaPool, t);
    }

    /* 第一遍：加法混合粒子（火焰 / 熔岩发光体） */
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < MAXP; i++) {
      const p = s.pool[i];
      if (!p.alive) continue;
      if (p.type === T_SMOKE || p.type === T_OBSIDIAN) continue;
      drawParticle(ctx, s, p, t);
    }

    /* 第二遍：普通混合粒子（烟 / 黑曜石） */
    ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < MAXP; i++) {
      const p = s.pool[i];
      if (!p.alive) continue;
      if (p.type !== T_SMOKE && p.type !== T_OBSIDIAN) continue;
      drawParticle(ctx, s, p, t);
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}

if (!customElements.get('cursor-firefang')) {
  customElements.define('cursor-firefang', CursorFirefang);
}

export default CursorFirefang;
