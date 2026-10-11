/**
 * cursor-fish —— 鼠标光标鱼群动效。
 *
 * 由 html/鱼群.html 原型移植：算法流程、数值、视觉表现与原文件一一对应。
 * 作为光标层组件，原型页面自身的行为已剔除：
 *   - 不携带深色页面底色（原型第 8 行的 #03101c 是页面 CSS，绘制里本来也只有
 *     clearRect，没有任何整屏铺底，故无需删除）；
 *   - 不拦截 contextmenu（基类统一处理，并保留 Shift/Ctrl/Cmd 的逃生出口）；
 *   - window resize 监听、canvas 尺寸与 DPR 逻辑 → 基类 onResize；
 *   - 画布创建、监听注册、rAF 循环均由基类负责。
 *
 * 输入事件族：原型用的是 pointermove / pointerdown / pointerup（第 357/363/381 行），
 * 与基类默认的 pointer 族一致，因此不声明 inputFamily。
 *
 * 锚点口径（帧级）：原型在每帧的 update() 里推进锚点（第 1018 行 mouse.lx = mouse.x），
 * 拖尾用的位移是「本帧起始位置 − 上一帧起始位置」。
 * 基类的 input.lx/ly 是事件级锚点：一帧内多次 pointermove 时它只等于倒数第二个事件的
 * 位置（实测：帧内 3 次移动共 300px 时 x-lx 只有 100px），位移会偏小、拖尾会变短，
 * 故本文件不用它；而 input.frameLx/frameLy 在 update() 里恒等于 input.x
 * （基类 _tick 在调用 update 之前才把它赋成 x），x-frameLx 恒为 0，也不能直接用。
 * 因此这里按原型口径自行推进帧级锚点：把上一帧的 frameLx/frameLy 存在 state 上，
 * 帧位移 = 本帧 frameLx − 上一帧 frameLx，与原型逐帧一致。
 *
 * 速度口径（原始逐帧速度）：拖尾鱼的速度取自原型第 1068 行的
 * Math.min(500, mdist / Math.max(dt, 0.001))，是未经过平滑的原始逐帧速度，
 * 不是基类 input.vx/vy（1-exp(-25dt) 平滑）。故在 update() 里按原型口径另算一份
 * 存入 state.rawVx / rawVy，500 px/s 的上限原样保留。
 *
 * 所有运行状态都放在 setup() 返回的 state 上，多实例互不干扰。
 */

import { CursorEffectElement } from '../core/base.js';
import { TAU, clamp, lerp, rand, randInt } from '../core/utils.js';

/* ==================================================================
 * CONFIG —— 全部可调参数集中在此
 * ================================================================== */
const CONFIG = {
  /* ---- 两套配色（严格区分左键 / 右键）---- */
  palettes: [
    { // 0：左键 · 银蓝鱼群
      body: '#7AC8E0', belly: '#E8F4FF', back: '#2A5A8A',
      fin: '#4FE3FF', eye: '#0A0A1A', highlight: '#FFFFFF'
    },
    { // 1：右键 · 热带鱼群
      body: '#FF8C1A', belly: '#FFD24A', back: '#C42A1A',
      fin: '#FF5CD8', eye: '#1A0A1A', highlight: '#FFFFFF'
    }
  ],

  /* ---- 鱼体参数 ---- */
  fish: {
    maxCount: 600,        // 鱼对象池上限
    minSize: 6,           // 体长下限 px（原型正文从未引用，属死配置，按「数值原样保留」留下）
    maxSize: 18,          // 体长上限 px（同上，实际尺寸各处为硬编码）
    lifeMin: 3,           // 寿命下限 s
    lifeMax: 6,           // 寿命上限 s
    minSpeed: 26,         // 最低游速 px/s
    maxSpeed: 300,        // 最高游速 px/s
    maxForce: 900,        // 最大转向力 px/s²
    turnRate: 9,          // 朝向平滑响应速度 rad/s
    drag: 1.0,            // 速度衰减系数
    tailFreqMin: 3,       // 摆尾频率下限 Hz
    tailFreqMax: 6,       // 摆尾频率上限 Hz
    tailAmp: 0.30         // 摆尾形变幅度
  },

  /* ---- Boids 三规则 / 空间网格 ---- */
  boids: {
    separationRadius: 22, // 分离感知半径 px
    perceptionRadius: 80, // 对齐 / 聚合感知半径 px
    wSep: 1.75,           // 分离权重
    wAli: 1.05,           // 对齐权重
    wCoh: 0.95,           // 聚合权重
    wTarget: 1.25,        // 目标力权重
    maxNeighbors: 10,     // 每条鱼每帧最多处理的邻居数
    cellSize: 80,         // 空间网格单元尺寸 px
    turnRadius: 250,      // 集体转向影响半径 px
    turnAngle: Math.PI / 3, // 集体转向角度 60°
    turnSpread: 0.12      // 转向波传播时间 s
  },

  /* ---- 鼠标拖尾 ---- */
  trail: {
    spawnDist: 22,        // 每移动多少像素生成一条鱼
    maxPerFrame: 4,       // 单帧生成上限
    sizeMin: 6,
    sizeMax: 12,
    speedScale: 0.5,      // 继承鼠标速度比例
    jitter: 1.1           // 方向随机抖动
  },

  /* ---- 左键 · 诱饵球 ---- */
  bait: {
    chargeMax: 2.5,       // 蓄满所需时间 s
    minRadius: 40,        // 起始鱼球半径 px
    maxRadius: 120,       // 蓄满鱼球半径 px
    coreRadius: 18,       // 中心暗区半径 px
    spawnRateMin: 20,     // 起始生成速率 条/s
    spawnRateMax: 160,    // 蓄满生成速率 条/s
    spinMax: 6.0,         // 内圈角速度 rad/s
    spinMin: 1.4,         // 外圈角速度 rad/s
    escapeChance: 0.10,   // 外圈逸散概率
    pitchAmp: 40 * Math.PI / 180, // 俯仰摆动幅度
    pitchPeriod: 2.0      // 俯仰摆动周期 s
  },

  /* ---- 右键 · 鱼群迁徙 ---- */
  migrate: {
    chargeMax: 2.5,
    bandMin: 60,          // 起始带宽 px
    bandMax: 160,         // 蓄满带宽 px
    waveLen: 300,         // 波动波长 px
    waveAmp: 20,          // 波动振幅 px
    speedMax: 500,        // 中心线速度 px/s
    speedMin: 150,        // 外缘速度 px/s
    spawnRateMin: 20,
    spawnRateMax: 160,
    escapeChance: 0.15    // 外缘逸散概率
  },

  /* ---- 特效 ---- */
  fx: {
    maxBubbles: 900,
    cohesionSuppress: 0.9,   // 爆发后聚合权重被抑制的比例（原型正文硬编码 0.1 = 1-0.9，此值未被引用）
    cohesionHold: 0.5,       // 抑制保持时间 s
    cohesionRecover: 1.5     // 恢复时间 s
  }
};

/* 原型模块级常量（均为不可变值，非可变状态） */
const TEX_SIZES = [6, 10, 14, 18, 22];
const CELL = CONFIG.boids.cellSize;
const POOL = CONFIG.fish.maxCount;

/* ==================================================================
 * 离屏纹理预渲染 —— 10 个基础鱼形纹理（5 尺寸 × 2 配色）
 * ================================================================== */
function drawFishShape(g, L, pal) {
  const hw = L * 0.17;      // 最大半宽（体宽 ≈ 体长 0.34）
  const hx = L * 0.5;       // 吻部
  const tx = -L * 0.5;      // 尾柄

  g.lineJoin = 'round';
  g.lineCap = 'round';

  /* ---- 尾鳍（分叉扇形）---- */
  g.beginPath();
  g.moveTo(tx, 0);
  g.quadraticCurveTo(tx - L * 0.16, -L * 0.14, tx - L * 0.34, -L * 0.30);
  g.quadraticCurveTo(tx - L * 0.14, -L * 0.06, tx - L * 0.02, 0);
  g.quadraticCurveTo(tx - L * 0.14, L * 0.06, tx - L * 0.34, L * 0.30);
  g.quadraticCurveTo(tx - L * 0.16, L * 0.14, tx, 0);
  g.closePath();
  g.globalAlpha = 0.88;
  g.fillStyle = pal.fin;
  g.fill();
  g.globalAlpha = 1;

  /* ---- 背鳍 ---- */
  g.beginPath();
  g.moveTo(L * 0.06, -hw * 0.80);
  g.quadraticCurveTo(-L * 0.02, -hw * 2.10, -L * 0.20, -hw * 0.75);
  g.closePath();
  g.globalAlpha = 0.72;
  g.fillStyle = pal.fin;
  g.fill();
  g.globalAlpha = 1;

  /* ---- 胸鳍 ---- */
  g.beginPath();
  g.moveTo(L * 0.10, hw * 0.35);
  g.quadraticCurveTo(-L * 0.02, hw * 1.60, -L * 0.16, hw * 0.65);
  g.closePath();
  g.globalAlpha = 0.62;
  g.fillStyle = pal.fin;
  g.fill();
  g.globalAlpha = 1;

  /* ---- 鱼身（反荫蔽渐变：背深 → 腹亮）---- */
  const grad = g.createLinearGradient(0, -hw * 1.05, 0, hw * 1.05);
  grad.addColorStop(0, pal.back);
  grad.addColorStop(0.42, pal.body);
  grad.addColorStop(1, pal.belly);

  g.beginPath();
  g.moveTo(hx, 0);
  g.bezierCurveTo(hx - L * 0.10, -hw * 0.50, L * 0.10, -hw * 1.05, -L * 0.04, -hw * 0.98);
  g.bezierCurveTo(-L * 0.24, -hw * 0.88, -L * 0.36, -hw * 0.42, tx, 0);
  g.bezierCurveTo(-L * 0.36, hw * 0.42, -L * 0.24, hw * 0.88, -L * 0.04, hw * 0.98);
  g.bezierCurveTo(L * 0.10, hw * 1.05, hx - L * 0.10, hw * 0.50, hx, 0);
  g.closePath();
  g.fillStyle = grad;
  g.fill();
  g.strokeStyle = pal.body;
  g.lineWidth = 0.8;
  g.stroke();

  /* ---- 背部高光 ---- */
  g.beginPath();
  g.moveTo(L * 0.30, -hw * 0.35);
  g.quadraticCurveTo(L * 0.05, -hw * 0.90, -L * 0.22, -hw * 0.62);
  g.globalAlpha = 0.55;
  g.strokeStyle = pal.highlight;
  g.lineWidth = L * 0.055;
  g.stroke();
  g.globalAlpha = 1;

  /* ---- 鱼眼（眼眶 + 黑瞳）---- */
  const ex = L * 0.33, ey = -hw * 0.30, er = L * 0.042;
  g.beginPath();
  g.arc(ex, ey, er * 1.7, 0, TAU);
  g.globalAlpha = 0.92;
  g.fillStyle = pal.belly;
  g.fill();
  g.globalAlpha = 1;
  g.beginPath();
  g.arc(ex, ey, er, 0, TAU);
  g.fillStyle = pal.eye;
  g.fill();
}

// 离屏贴图用元素自身的 ownerDocument 创建：不碰全局 document，也绝不挂进 DOM。
// 这里的 getContext / width / height 只作用于离屏贴图画布，与主画布无关。
function makeFishTexture(doc, L, pi) {
  const pal = CONFIG.palettes[pi];
  const SS = 3;                       // 超采样倍率
  const tw = L * 2.0, th = L * 1.5;   // 逻辑尺寸
  const cv = doc.createElement('canvas');
  cv.width = Math.max(4, Math.ceil(tw * SS));
  cv.height = Math.max(4, Math.ceil(th * SS));
  const g = cv.getContext('2d');
  g.scale(SS, SS);
  g.translate(tw / 2, th / 2);
  drawFishShape(g, L, pal);
  return { canvas: cv, w: tw, h: th };
}

// 原型在模块级预渲染一次；移植后改为每个实例在 setup() 里各建一份，多实例互不干扰
function buildTextures(doc) {
  const textures = [[], []];
  for (let p = 0; p < 2; p++) {
    for (let s = 0; s < TEX_SIZES.length; s++) {
      textures[p].push(makeFishTexture(doc, TEX_SIZES[s], p));
    }
  }
  return textures;
}

function texIndexFor(size) {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < TEX_SIZES.length; i++) {
    const d = Math.abs(TEX_SIZES[i] - size);
    if (d < bd) { bd = d; bi = i; }
  }
  return bi;
}

/* ==================================================================
 * 空间网格（Spatial Hash）—— 加速 Boids 邻近查询
 * ================================================================== */
function cellKey(cx, cy) {
  return (cx + 4096) * 8192 + (cy + 4096);
}

function buildGrid(s) {
  const grid = s.grid;
  grid.clear();
  for (let i = 0; i < POOL; i++) {
    const f = s.pool[i];
    if (!f.alive) continue;
    const k = cellKey(Math.floor(f.x / CELL), Math.floor(f.y / CELL));
    let b = grid.get(k);
    if (b === undefined) { b = []; grid.set(k, b); }
    b.push(f);
  }
}

/* ==================================================================
 * 鱼对象池
 * ================================================================== */
function createFish() {
  return {
    alive: false,
    x: 0, y: 0, vx: 0, vy: 0,
    size: 10, ti: 1, pal: 0,
    life: 0, maxLife: 1,
    angle: 0, phase: 0, bank: 0,
    turning: false, turnDelay: 0, turnAngle: 0
  };
}

function allocFish(s) {
  for (let i = 0; i < POOL; i++) {
    const idx = (s.poolCursor + i) % POOL;
    const f = s.pool[idx];
    if (!f.alive) { s.poolCursor = (idx + 1) % POOL; return f; }
  }
  return null;
}

function killFish(s, f) {
  if (f.alive) { f.alive = false; s.aliveCount--; }
}

// 原型这里逐字段重置了对象池的全部 16 个字段，没有遗漏（无「池字段未重置」缺陷）
function spawnFish(s, x, y, vx, vy, size, pal, life) {
  if (s.aliveCount >= POOL) return null;
  const f = allocFish(s);
  if (!f) return null;
  f.alive = true;
  f.x = x; f.y = y;
  f.vx = vx; f.vy = vy;
  f.size = size;
  f.ti = texIndexFor(size);
  f.pal = pal;
  f.life = life; f.maxLife = life;
  f.angle = Math.atan2(vy, vx);
  f.phase = Math.random() * TAU;
  f.bank = 0;
  f.turning = false;
  f.turnDelay = 0;
  f.turnAngle = 0;
  s.aliveCount++;
  return f;
}

/* ==================================================================
 * 特效系统：气泡 / 水波环 / 光斑 / 水流线
 * ================================================================== */
function spawnBubble(s, x, y, vx, vy, r, life, alpha) {
  if (s.bubbles.length >= CONFIG.fx.maxBubbles) return;
  s.bubbles.push({ x: x, y: y, vx: vx, vy: vy, r: r, life: life, maxLife: life, a: alpha });
}

function spawnRing(s, x, y, maxR, life, count, alpha, dotR) {
  s.rings.push({
    x: x, y: y, maxR: maxR, life: life, maxLife: life,
    count: count, a: alpha, dotR: dotR || 1.6,
    seed: Math.random() * TAU
  });
}

function spawnFlash(s, x, y, r0, r1, life, alpha) {
  s.flashes.push({ x: x, y: y, r0: r0, r1: r1, life: life, maxLife: life, a: alpha });
}

function spawnWaveLine(s, x, y, angle, len, life, count) {
  s.waveLines.push({
    x: x, y: y, angle: angle, len: len,
    life: life, maxLife: life, count: count
  });
}

function updateFx(s, dt) {
  /* 气泡 */
  for (let i = s.bubbles.length - 1; i >= 0; i--) {
    const b = s.bubbles[i];
    b.life -= dt;
    if (b.life <= 0) { s.bubbles.splice(i, 1); continue; }
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    const damp = Math.exp(-2.2 * dt);
    b.vx *= damp; b.vy *= damp;
  }
  /* 水波环 */
  for (let i = s.rings.length - 1; i >= 0; i--) {
    const r = s.rings[i];
    r.life -= dt;
    if (r.life <= 0) s.rings.splice(i, 1);
  }
  /* 光斑 */
  for (let i = s.flashes.length - 1; i >= 0; i--) {
    const f = s.flashes[i];
    f.life -= dt;
    if (f.life <= 0) s.flashes.splice(i, 1);
  }
  /* 水流线 */
  for (let i = s.waveLines.length - 1; i >= 0; i--) {
    const w = s.waveLines[i];
    w.life -= dt;
    if (w.life <= 0) s.waveLines.splice(i, 1);
  }
}

/* ==================================================================
 * 集体转向（点击冲击 —— 本主题独有机制）
 * ================================================================== */
function collectiveTurn(s, cx, cy, radius, forcedSign) {
  const R2 = radius * radius;
  const sign = forcedSign !== undefined && forcedSign !== 0
    ? forcedSign
    : (Math.random() < 0.5 ? 1 : -1);
  const angle = sign * CONFIG.boids.turnAngle;
  const spread = CONFIG.boids.turnSpread;

  for (let i = 0; i < POOL; i++) {
    const f = s.pool[i];
    if (!f.alive) continue;
    const dx = f.x - cx, dy = f.y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 > R2) continue;
    const d = Math.sqrt(d2);
    f.turning = true;
    f.turnDelay = (d / radius) * spread;   // 波浪式传播：越远越晚
    f.turnAngle = angle;
  }
}

/* ==================================================================
 * 交互二：左键单击
 * ================================================================== */
function onLeftClick(s, x, y) {
  const n = randInt(8, 14);   // 8~14 条
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU;
    const sp = rand(60, 210);
    spawnFish(
      s,
      x + (Math.random() - 0.5) * 8,
      y + (Math.random() - 0.5) * 8,
      Math.cos(a) * sp, Math.sin(a) * sp,
      rand(8, 14),
      0,
      rand(CONFIG.fish.lifeMin, CONFIG.fish.lifeMax)
    );
  }
  /* 水波环：16~24 个气泡点 */
  spawnRing(s, x, y, 80, 0.4, randInt(16, 24), 0.5, 1.5);
  /* 水面扰动光斑 */
  spawnFlash(s, x, y, 6, 20, 0.35, 0.32);
  /* 集体转向 */
  collectiveTurn(s, x, y, CONFIG.boids.turnRadius);
  /* 惊慌气泡 3~5 个 */
  const bn = randInt(3, 5);
  for (let i = 0; i < bn; i++) {
    const a = Math.random() * TAU;
    const sp = rand(100, 300);
    spawnBubble(s, x, y, Math.cos(a) * sp, Math.sin(a) * sp, rand(1, 3), 0.5, 0.6);
  }
}

/* ==================================================================
 * 交互四：左键 —— 诱饵球（Bait Ball）蓄力与爆发
 * ================================================================== */
function baitProgress(s) {
  return Math.min(1, s.charge / CONFIG.bait.chargeMax);
}

function doBaitBurst(s, c) {
  const power = Math.pow(Math.min(c, CONFIG.bait.chargeMax) / CONFIG.bait.chargeMax, 1.6);
  const mx = s.input.x, my = s.input.y;

  /* 1. 凝固一帧：所有鱼速度归零 */
  for (let i = 0; i < POOL; i++) {
    const f = s.pool[i];
    if (f.alive) { f.vx = 0; f.vy = 0; }
  }
  s.freezeTimer = 0.03;

  // 爆发动作挂在 state 上（原型用模块级 pendingBurst），0.03s 后由 update 触发
  s.pendingBurst = function () {
    /* 2. 全方向炸散 */
    const sp = 400 + 1200 * power;
    for (let i = 0; i < POOL; i++) {
      const f = s.pool[i];
      if (!f.alive) continue;
      const dx = f.x - mx, dy = f.y - my;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const jitter = 90;
      f.vx = (dx / d) * sp + (Math.random() - 0.5) * jitter;
      f.vy = (dy / d) * sp + (Math.random() - 0.5) * jitter;
    }
    /* 4. 气泡雨 */
    const bn = Math.floor(60 + 200 * power);
    for (let i = 0; i < bn; i++) {
      const a = Math.random() * TAU;
      const bs = rand(200, 600);
      spawnBubble(s, mx, my,
        Math.cos(a) * bs, Math.sin(a) * bs,
        rand(1, 4), rand(0.5, 0.9), rand(0.4, 0.7));
    }
    /* 5. 水波冲击环 1~2 层 */
    const layers = randInt(1, 2);
    for (let i = 0; i < layers; i++) {
      spawnRing(s, mx, my, 100 + 400 * power, 0.6,
        randInt(24, 40), 0.55 - i * 0.15, 1.8);
    }
    /* 6. 中心光斑 */
    spawnFlash(s, mx, my, 20, 60, 0.4, 0.5);
    /* 7. 场上拖尾鱼集体转向 */
    collectiveTurn(s, mx, my, 400);
    /* 8. 聚合抑制 */
    s.cohTimer = 0;
  };
}

/* ==================================================================
 * 交互五：右键 —— 鱼群迁徙（Migration）蓄力与分流爆发
 * ================================================================== */
function migrateProgress(s) {
  return Math.min(1, s.charge / CONFIG.migrate.chargeMax);
}

function doMigrateBurst(s, c) {
  const power = Math.pow(Math.min(c, CONFIG.migrate.chargeMax) / CONFIG.migrate.chargeMax, 1.6);
  const mx = s.input.x, my = s.input.y;
  const dx = s.migrateDirX, dy = s.migrateDirY;
  const px = -dy, py = dx;

  for (let i = 0; i < POOL; i++) {
    const f = s.pool[i];
    if (f.alive) { f.vx = 0; f.vy = 0; }
  }
  s.freezeTimer = 0.03;

  s.pendingBurst = function () {
    const split = Math.PI / 4 * (0.25 + 0.75 * power);   // 最多 45°
    const targetSp = 250 + 350 * power;

    for (let i = 0; i < POOL; i++) {
      const f = s.pool[i];
      if (!f.alive) continue;
      const rx = f.x - mx, ry = f.y - my;
      const lat = rx * px + ry * py;
      const dist = Math.sqrt(rx * rx + ry * ry);
      if (dist > 700) continue;

      const sign = lat >= 0 ? 1 : -1;
      const ang = sign * split * (Math.abs(lat) < 8 ? (Math.random() < 0.5 ? 1 : -1) : 1);
      const cs = Math.cos(ang), sn = Math.sin(ang);

      let vx = dx * targetSp;
      let vy = dy * targetSp;
      /* 中心空带：靠近中线的鱼给一点横向推力 */
      if (Math.abs(lat) < 26) {
        vx += px * sign * 120;
        vy += py * sign * 120;
      }
      const rvx = vx * cs - vy * sn;
      const rvy = vx * sn + vy * cs;

      f.vx = rvx + (Math.random() - 0.5) * 60;
      f.vy = rvy + (Math.random() - 0.5) * 60;
    }

    /* 惊慌气泡：沿垂直方向飞出 */
    const bn = Math.floor(40 + 120 * power);
    for (let i = 0; i < bn; i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const bs = rand(150, 400);
      const ox = (Math.random() - 0.5) * 50;
      const oy = (Math.random() - 0.5) * 50;
      spawnBubble(s, mx + ox, my + oy,
        px * side * bs + (Math.random() - 0.5) * 60,
        py * side * bs + (Math.random() - 0.5) * 60,
        rand(1, 3), 0.5, 0.55);
    }

    /* 双水波线 */
    const wa = Math.atan2(dy, dx);
    spawnWaveLine(s, mx, my, wa - split - Math.PI / 2, 100 + 200 * power, 0.5, randInt(20, 30));
    spawnWaveLine(s, mx, my, wa + split + Math.PI / 2, 100 + 200 * power, 0.5, randInt(20, 30));

    spawnFlash(s, mx, my, 14, 44, 0.35, 0.35);

    /* 场上拖尾鱼一起转向迁徙方向 */
    const targetSign = (px * s.migrateDirX + py * s.migrateDirY) >= 0 ? 1 : -1;
    collectiveTurn(s, mx, my, 420, targetSign);
  };
}

/* ==================================================================
 * Boids 系统（分离 / 对齐 / 聚合）+ 空间网格查询
 * ================================================================== */
function gatherNeighbors(s, f) {
  const nbFish = s.nbFish;
  const nbDist = s.nbDist;
  s.nbCount = 0;
  const cx = Math.floor(f.x / CELL);
  const cy = Math.floor(f.y / CELL);
  const PR2 = CONFIG.boids.perceptionRadius * CONFIG.boids.perceptionRadius;
  const MAXNB = CONFIG.boids.maxNeighbors;

  for (let gx = cx - 1; gx <= cx + 1; gx++) {
    for (let gy = cy - 1; gy <= cy + 1; gy++) {
      const bucket = s.grid.get(cellKey(gx, gy));
      if (bucket === undefined) continue;
      for (let i = 0; i < bucket.length; i++) {
        const o = bucket[i];
        if (o === f) continue;
        const dx = o.x - f.x, dy = o.y - f.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > PR2 || d2 < 1e-6) continue;

        if (s.nbCount < MAXNB) {
          let j = s.nbCount++;
          while (j > 0 && nbDist[j - 1] > d2) {
            nbFish[j] = nbFish[j - 1];
            nbDist[j] = nbDist[j - 1];
            j--;
          }
          nbFish[j] = o;
          nbDist[j] = d2;
        } else if (d2 < nbDist[MAXNB - 1]) {
          let j = MAXNB - 1;
          while (j > 0 && nbDist[j - 1] > d2) {
            nbFish[j] = nbFish[j - 1];
            nbDist[j] = nbDist[j - 1];
            j--;
          }
          nbFish[j] = o;
          nbDist[j] = d2;
        }
      }
    }
  }
}

/* ==================================================================
 * 鱼体更新
 * ================================================================== */
function updateFish(s, f, dt) {
  /* ---- 摆尾相位（随速度加快）---- */
  const spd0 = Math.sqrt(f.vx * f.vx + f.vy * f.vy);
  const spn = Math.min(1, spd0 / CONFIG.fish.maxSpeed);
  const freq = lerp(CONFIG.fish.tailFreqMin, CONFIG.fish.tailFreqMax, spn);
  f.phase += freq * TAU * dt;

  /* ---- 急转侧身恢复 ---- */
  f.bank *= Math.exp(-6 * dt);

  /* ---- 寿命 ---- */
  f.life -= dt;
  if (f.life <= 0) { killFish(s, f); return; }

  if (s.frozen) return;

  /* ---- 集体转向（波浪式传播）---- */
  if (f.turning) {
    f.turnDelay -= dt;
    if (f.turnDelay <= 0) {
      const a = f.turnAngle;
      const c = Math.cos(a), sn = Math.sin(a);
      const nvx = f.vx * c - f.vy * sn;
      const nvy = f.vx * sn + f.vy * c;
      f.vx = nvx; f.vy = nvy;
      f.bank = (a > 0 ? 1 : -1) * Math.min(1, Math.abs(a) / 1.05) * 0.9;
      f.turning = false;
    }
  }

  /* ---- 邻居查询 ---- */
  gatherNeighbors(s, f);

  /* ---- 三规则累加 ---- */
  let sepX = 0, sepY = 0, sepN = 0;
  let aliX = 0, aliY = 0, aliN = 0;
  let cohX = 0, cohY = 0, cohN = 0;
  const SR2 = CONFIG.boids.separationRadius * CONFIG.boids.separationRadius;

  for (let i = 0; i < s.nbCount; i++) {
    const o = s.nbFish[i];
    const d2 = s.nbDist[i];
    const dx = o.x - f.x, dy = o.y - f.y;

    if (d2 < SR2) {
      sepX -= dx / d2;
      sepY -= dy / d2;
      sepN++;
    }
    aliX += o.vx; aliY += o.vy; aliN++;
    cohX += o.x; cohY += o.y; cohN++;
  }

  const MAXS = CONFIG.fish.maxSpeed;
  const MAXF = CONFIG.fish.maxForce;
  let ax = 0, ay = 0;

  /* 规则 1：分离 */
  if (sepN > 0) {
    const len = Math.sqrt(sepX * sepX + sepY * sepY);
    if (len > 1e-5) {
      let sx = (sepX / len) * MAXS - f.vx;
      let sy = (sepY / len) * MAXS - f.vy;
      const m = Math.sqrt(sx * sx + sy * sy);
      if (m > MAXF) { sx = sx / m * MAXF; sy = sy / m * MAXF; }
      ax += sx * CONFIG.boids.wSep;
      ay += sy * CONFIG.boids.wSep;
    }
  }

  /* 规则 2：对齐 */
  if (aliN > 0) {
    aliX /= aliN; aliY /= aliN;
    const len = Math.sqrt(aliX * aliX + aliY * aliY);
    if (len > 1e-5) {
      let sx = (aliX / len) * MAXS - f.vx;
      let sy = (aliY / len) * MAXS - f.vy;
      const m = Math.sqrt(sx * sx + sy * sy);
      if (m > MAXF) { sx = sx / m * MAXF; sy = sy / m * MAXF; }
      ax += sx * CONFIG.boids.wAli;
      ay += sy * CONFIG.boids.wAli;
    }
  }

  /* 规则 3：聚合（受爆发抑制系数影响） */
  if (cohN > 0) {
    cohX = cohX / cohN - f.x;
    cohY = cohY / cohN - f.y;
    const len = Math.sqrt(cohX * cohX + cohY * cohY);
    if (len > 1e-5) {
      let sx = (cohX / len) * MAXS - f.vx;
      let sy = (cohY / len) * MAXS - f.vy;
      const m = Math.sqrt(sx * sx + sy * sy);
      if (m > MAXF) { sx = sx / m * MAXF; sy = sy / m * MAXF; }
      let wC = CONFIG.boids.wCoh;
      if (s.cohTimer >= 0) {
        let fac;
        if (s.cohTimer < CONFIG.fx.cohesionHold) fac = 0.1;
        else {
          const t = Math.min(1, (s.cohTimer - CONFIG.fx.cohesionHold) / CONFIG.fx.cohesionRecover);
          fac = 0.1 + 0.9 * t;
        }
        wC *= fac;
      }
      ax += sx * wC;
      ay += sy * wC;
    }
  }

  /* ---- 目标力（左键诱饵球 / 右键迁徙带）---- */
  let tvx = 0, tvy = 0, hasTarget = false;

  if (s.mode === 'bait') {
    const p = baitProgress(s);
    /* 微震：蓄力 > 55% 后鱼球中心高频抖动 */
    let bx = s.input.x, by = s.input.y;
    if (p > 0.55) {
      const k = (p - 0.55) / 0.45;
      bx += (Math.random() - 0.5) * 3 * k;
      by += (Math.random() - 0.5) * 3 * k;
    }
    /* 脉动 */
    const pulse = 1 + Math.sin(s.time * TAU * 1.0) * 0.05;
    /* 俯仰翻滚：让鱼球呈椭圆 */
    const pitch = Math.sin(s.time * TAU / CONFIG.bait.pitchPeriod) * CONFIG.bait.pitchAmp;
    const cosP = Math.max(0.45, Math.cos(pitch));

    const dx = f.x - bx;
    const dy = (f.y - by) / cosP;
    const r = Math.sqrt(dx * dx + dy * dy) + 0.001;

    if (r < 700) {
      const nx = dx / r, ny = dy / r;
      const R = lerp(CONFIG.bait.minRadius, CONFIG.bait.maxRadius, p) * pulse;

      // 内圈快、外圈慢，并夹在 spinMin / spinMax 之间
      const omega = clamp(320 / Math.max(r, 30), CONFIG.bait.spinMin, CONFIG.bait.spinMax);

      let radial = -(r - R) * 2.6;
      if (r < CONFIG.bait.coreRadius) radial = (CONFIG.bait.coreRadius - r) * 24;
      radial = clamp(radial, -330, 330);

      const tang = Math.min(omega * r, MAXS * 1.1);
      tvx = (-ny * tang + nx * radial);
      tvy = (nx * tang + ny * radial);
      hasTarget = true;

      /* 外圈逸散 */
      if (r > R * 0.85 && Math.random() < CONFIG.bait.escapeChance * dt * 8) {
        f.vx += -ny * rand(60, 150);
        f.vy += nx * rand(60, 150);
      }
    }
  } else if (s.mode === 'migrate') {
    const p = migrateProgress(s);
    const dx = f.x - s.input.x;
    const dy = f.y - s.input.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 680) {
      const px = -s.migrateDirY, py = s.migrateDirX;
      const along = dx * s.migrateDirX + dy * s.migrateDirY;
      const lat = dx * px + dy * py;

      const waveK = TAU / CONFIG.migrate.waveLen;
      const wave = Math.sin(along * waveK - s.time * 5.5) * (CONFIG.migrate.waveAmp * (0.5 + 0.5 * p));
      const latErr = lat - wave;

      const bandHalf = lerp(CONFIG.migrate.bandMin, CONFIG.migrate.bandMax, p) * 0.5;
      const tn = Math.min(1, Math.abs(latErr) / bandHalf);

      const spd = (CONFIG.migrate.speedMax - (CONFIG.migrate.speedMax - CONFIG.migrate.speedMin) * tn)
        * (0.55 + 0.45 * p);

      const latV = clamp(-latErr * 2.2, -230, 230);

      tvx = s.migrateDirX * spd + px * latV;
      tvy = s.migrateDirY * spd + py * latV;
      hasTarget = true;

      /* 外缘逸散 */
      if (tn > 0.75 && Math.random() < CONFIG.migrate.escapeChance * dt * 8) {
        const sgn = Math.random() < 0.5 ? -1 : 1;
        f.vx += px * sgn * rand(50, 120);
        f.vy += py * sgn * rand(50, 120);
      }
    }
  }

  if (hasTarget) {
    let sx = tvx - f.vx;
    let sy = tvy - f.vy;
    const m = Math.sqrt(sx * sx + sy * sy);
    const TF = MAXF * 1.4;
    if (m > TF) { sx = sx / m * TF; sy = sy / m * TF; }
    ax += sx * CONFIG.boids.wTarget;
    ay += sy * CONFIG.boids.wTarget;
  }

  /* ---- 速度积分 ---- */
  f.vx += ax * dt;
  f.vy += ay * dt;

  /* 阻力 */
  const damp = Math.exp(-CONFIG.fish.drag * dt);
  f.vx *= damp;
  f.vy *= damp;

  /* 速度限制 */
  const sp = Math.sqrt(f.vx * f.vx + f.vy * f.vy);
  if (sp > MAXS) {
    f.vx = f.vx / sp * MAXS;
    f.vy = f.vy / sp * MAXS;
  } else if (sp < CONFIG.fish.minSpeed) {
    if (sp < 0.001) {
      f.vx = Math.cos(f.angle) * CONFIG.fish.minSpeed;
      f.vy = Math.sin(f.angle) * CONFIG.fish.minSpeed;
    } else {
      f.vx = f.vx / sp * CONFIG.fish.minSpeed;
      f.vy = f.vy / sp * CONFIG.fish.minSpeed;
    }
  }

  /* ---- 位置积分 ---- */
  f.x += f.vx * dt;
  f.y += f.vy * dt;

  /* ---- 出屏回收 ---- */
  if (f.x < -200 || f.x > s.W + 200 || f.y < -200 || f.y > s.H + 200) {
    killFish(s, f);
    return;
  }

  /* ---- 方向平滑（lerp 逼近速度方向）---- */
  const targetAngle = Math.atan2(f.vy, f.vx);
  let da = targetAngle - f.angle;
  while (da > Math.PI) da -= TAU;
  while (da < -Math.PI) da += TAU;
  f.angle += da * Math.min(1, CONFIG.fish.turnRate * dt);
}

/* ==================================================================
 * 蓄力期间的鱼群生成（诱饵球 / 鱼带）
 * ================================================================== */
function spawnBaitFish(s) {
  const p = baitProgress(s);
  const R = lerp(CONFIG.bait.minRadius, CONFIG.bait.maxRadius, p);
  const a = Math.random() * TAU;
  const rr = R * rand(0.30, 1.10);
  const x = s.input.x + Math.cos(a) * rr;
  const y = s.input.y + Math.sin(a) * rr;

  const omega = clamp(320 / Math.max(rr, 30), CONFIG.bait.spinMin, CONFIG.bait.spinMax);
  const tang = Math.min(omega * rr, CONFIG.fish.maxSpeed * 1.05);

  const vx = -Math.sin(a) * tang;
  const vy = Math.cos(a) * tang;

  spawnFish(s, x, y, vx, vy,
    rand(6, 14), 0,
    rand(CONFIG.fish.lifeMin, CONFIG.fish.lifeMax));
}

function spawnMigrateFish(s) {
  const p = migrateProgress(s);
  const bandHalf = lerp(CONFIG.migrate.bandMin, CONFIG.migrate.bandMax, p) * 0.5;
  const px = -s.migrateDirY, py = s.migrateDirX;

  const back = rand(60, 340);
  const lat = (Math.random() * 2 - 1) * bandHalf;

  const x = s.input.x - s.migrateDirX * back + px * lat;
  const y = s.input.y - s.migrateDirY * back + py * lat;

  const tn = Math.min(1, Math.abs(lat) / bandHalf);
  const spd = (CONFIG.migrate.speedMax - (CONFIG.migrate.speedMax - CONFIG.migrate.speedMin) * tn)
    * (0.6 + 0.4 * p);

  const jitterA = (Math.random() - 0.5) * 0.25;
  const cs = Math.cos(jitterA), sn = Math.sin(jitterA);
  const vx = (s.migrateDirX * spd) * cs - (s.migrateDirY * spd) * sn;
  const vy = (s.migrateDirX * spd) * sn + (s.migrateDirY * spd) * cs;

  const sizeBase = rand(8, 14);
  spawnFish(s, x, y, vx, vy, sizeBase, 1,
    rand(CONFIG.fish.lifeMin, CONFIG.fish.lifeMax));
}

/* ==================================================================
 * 鱼体绘制（离屏纹理 + drawImage + rotate + 摆尾形变）
 * ================================================================== */
function drawFish(ctx, f, s) {
  const tex = s.textures[f.pal][f.ti];
  let alpha = 1;
  if (f.life < 0.7) alpha = f.life / 0.7;
  else if (f.life > f.maxLife - 0.25) alpha = (f.maxLife - f.life) / 0.25;
  if (alpha <= 0.01) return;
  if (alpha > 1) alpha = 1;

  const baseSize = TEX_SIZES[f.ti];
  const sc = f.size / baseSize;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(f.x, f.y);
  ctx.rotate(f.angle);

  /* 急转侧身（原型只对 bank > 0 的方向做压扁，这里原样保留） */
  if (f.bank > 0.02) ctx.scale(1, 1 - f.bank * 0.45);

  /* 摆尾：以头部为支点的剪切形变 */
  const hx = f.size * 0.5;
  const shear = Math.sin(f.phase) * CONFIG.fish.tailAmp;
  ctx.translate(hx, 0);
  ctx.transform(1, 0, shear, 1, 0, 0);
  ctx.translate(-hx, 0);

  ctx.drawImage(
    tex.canvas,
    -tex.w * 0.5 * sc, -tex.h * 0.5 * sc,
    tex.w * sc, tex.h * sc
  );
  ctx.restore();
}

/* ==================================================================
 * 拖尾 / 特效绘制
 * ================================================================== */
function drawBubbles(ctx, s) {
  if (s.bubbles.length === 0) return;
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < s.bubbles.length; i++) {
    const b = s.bubbles[i];
    const t = b.life / b.maxLife;
    if (t <= 0) continue;
    ctx.globalAlpha = b.a * t;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawRings(ctx, s) {
  if (s.rings.length === 0) return;
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < s.rings.length; i++) {
    const r = s.rings[i];
    const t = r.life / r.maxLife;
    const prog = 1 - t;
    const rad = r.maxR * (1 - Math.pow(1 - prog, 2.2));
    const alpha = r.a * t;
    if (alpha <= 0.01) continue;
    ctx.globalAlpha = alpha;
    const n = r.count;
    const dr = r.dotR * (1 - prog * 0.45);
    for (let j = 0; j < n; j++) {
      const a = (j / n) * TAU + r.seed;
      ctx.beginPath();
      ctx.arc(r.x + Math.cos(a) * rad, r.y + Math.sin(a) * rad, dr, 0, TAU);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

function drawFlashes(ctx, s) {
  for (let i = 0; i < s.flashes.length; i++) {
    const f = s.flashes[i];
    const t = f.life / f.maxLife;
    const prog = 1 - t;
    const rad = f.r0 + (f.r1 - f.r0) * prog;
    const alpha = f.a * t;
    if (alpha <= 0.01 || rad <= 0.5) continue;
    const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, rad);
    g.addColorStop(0, 'rgba(200,245,255,' + alpha.toFixed(3) + ')');
    g.addColorStop(1, 'rgba(200,245,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(f.x, f.y, rad, 0, TAU);
    ctx.fill();
  }
}

function drawWaveLines(ctx, s) {
  if (s.waveLines.length === 0) return;
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < s.waveLines.length; i++) {
    const w = s.waveLines[i];
    const t = w.life / w.maxLife;
    const prog = 1 - t;
    const alpha = 0.55 * t;
    if (alpha <= 0.01) continue;
    ctx.globalAlpha = alpha;
    const ca = Math.cos(w.angle), sa = Math.sin(w.angle);
    const n = w.count;
    for (let j = 0; j < n; j++) {
      const d = (j / n) * w.len * Math.min(1, prog * 1.4);
      const px = w.x + ca * d;
      const py = w.y + sa * d;
      ctx.beginPath();
      ctx.arc(px, py, 1.4, 0, TAU);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

export class CursorFish extends CursorEffectElement {
  // 原型用的是 pointermove / pointerdown / pointerup（第 357/363/381 行），
  // 与基类默认的 'pointer' 族一致，因此这里不声明 inputFamily。
  // （若误写成 inputFamily = 'mouse'，本动效将完全收不到输入。）

  /* ==================================================================
     初始化
     ================================================================== */
  // 只建池、预渲染离屏贴图与状态，不注册任何监听（监听、DPR 缩放、rAF 全归基类）
  setup({ canvas, ctx, width, height, input }) {
    // 与原型一致：初始光标位置取视口中心。
    // 基类的 input 从 (0, 0) 起算，若不在这里对齐，首帧的位移会按「从左上角跳过来」计算，
    // 拖尾鱼的数量会和原型不同。
    input.x = input.lx = width * 0.5;
    input.y = input.ly = height * 0.5;

    const pool = new Array(POOL);
    for (let i = 0; i < POOL; i++) pool[i] = createFish();

    return {
      // 本实例的画布上下文（已按 DPR 缩放过，统一使用 CSS 像素坐标）
      ctx,

      // 画布尺寸（CSS 像素），由基类 onResize 同步
      W: width,
      H: height,

      input,

      // 10 个基础鱼形纹理（5 尺寸 × 2 配色），每个实例一份。
      // 贴图宿主文档取元素自身的 ownerDocument，不碰全局 document，也绝不挂进 DOM。
      textures: buildTextures(canvas.ownerDocument),

      // 鱼对象池 / 存活计数 / 环形游标
      pool,
      aliveCount: 0,
      poolCursor: 0,

      // 空间网格（每帧重建）
      grid: new Map(),

      // 邻居查询复用缓冲（按距离升序插入，最多 maxNeighbors 个）
      nbFish: new Array(CONFIG.boids.maxNeighbors),
      nbDist: new Float32Array(CONFIG.boids.maxNeighbors),
      nbCount: 0,

      // 光标方向平滑（原型 mouse.dirX / mouse.dirY，每帧位移 > 1.5px 时更新）
      dirX: 1,
      dirY: 0,

      // 帧级锚点：上一帧起始的光标位置（原型 mouse.lx / mouse.ly，在 update 里推进）
      prevFrameX: width * 0.5,
      prevFrameY: height * 0.5,

      // 原始逐帧速度（原型第 1068 行口径，未经基类平滑）
      rawVx: 0,
      rawVy: 0,

      // 交互状态：null | 'bait' | 'migrate'
      mode: null,
      charge: 0,              // 蓄力时间 s
      migrateDirX: 1,
      migrateDirY: 0,

      // 生成累加器
      trailAccum: 0,
      baitSpawnAcc: 0,
      migrateSpawnAcc: 0,

      // 爆发前的「凝固一帧」
      freezeTimer: 0,
      pendingBurst: null,
      frozen: false,

      // 聚合抑制计时器，-1 表示未激活
      cohTimer: -1,

      // 全局时间
      time: 0,

      // 特效层
      bubbles: [],
      rings: [],
      flashes: [],
      waveLines: []
    };
  }

  /* ==================================================================
     输入（按键）
     ================================================================== */
  // 原型在 pointerdown 里还维护了 leftDown / rightDown 两个标志，
  // 但全文没有任何读取处（死代码），这里不再保留。
  onPointerDown(e) {
    const s = this.state;
    if (!s) return;

    if (e.button === 0) {
      if (s.mode === null) { s.mode = 'bait'; s.charge = 0; s.baitSpawnAcc = 0; }
      onLeftClick(s, e.clientX, e.clientY);
    } else if (e.button === 2) {
      if (s.mode === null) {
        s.mode = 'migrate';
        s.charge = 0;
        s.migrateSpawnAcc = 0;
        const dl = Math.sqrt(s.dirX * s.dirX + s.dirY * s.dirY);
        if (dl > 0.001) { s.migrateDirX = s.dirX / dl; s.migrateDirY = s.dirY / dl; }
        else { s.migrateDirX = 1; s.migrateDirY = 0; }
      }
    }
  }

  onPointerUp(e) {
    const s = this.state;
    if (!s) return;

    if (e.button === 0) {
      if (s.mode === 'bait') {
        if (s.charge >= 0.12) doBaitBurst(s, s.charge);
        s.mode = null; s.charge = 0;
      }
    } else if (e.button === 2) {
      if (s.mode === 'migrate') {
        if (s.charge >= 0.12) doMigrateBurst(s, s.charge);
        s.mode = null; s.charge = 0;
      }
    }
  }

  // 原型 window blur 的收尾：清掉按键残留、未触发的爆发与各累加器
  onBlur() {
    if (this.state) this._resetInput(this.state);
  }

  // 光标移出窗口：原型没有对应处理，这里补上同一套收尾。
  // 否则「按住左键 → 移出窗口 → 在外面松开」会收不到 pointerup，
  // mode 永远停在 'bait'，鱼球持续以最高速率刷鱼（原型的残留态缺陷）。
  onPointerLeave() {
    if (this.state) this._resetInput(this.state);
  }

  // 标签页切走时按键状态同样已丢失；原型没有对应处理，与 onPointerLeave 同属残留态修复
  onVisibilityChange(hidden) {
    if (hidden && this.state) this._resetInput(this.state);
  }

  _resetInput(s) {
    s.mode = null; s.charge = 0;
    s.freezeTimer = 0;
    s.pendingBurst = null;
    s.trailAccum = 0;
    s.baitSpawnAcc = 0;
    s.migrateSpawnAcc = 0;
  }

  /* ==================================================================
     尺寸
     ================================================================== */
  onResize(width, height) {
    const s = this.state;
    if (!s) return;
    s.W = width;
    s.H = height;
  }

  /* ==================================================================
     更新
     ================================================================== */
  update(dt, s) {
    if (!s) return;

    s.time += dt;

    /* ---- 帧级锚点推进 + 鼠标速度 / 方向平滑 ----
       原型第 1016~1019 行在 update() 里取「本帧起始位置 − 上一帧起始位置」并推进锚点；
       基类 input.lx/ly 是事件级锚点（一帧内多次 pointermove 时只等于倒数第二个事件的
       位置，位移会偏小），input.frameLx/frameLy 在 update() 内恒等于 input.x
       （x-frameLx 恒为 0），因此这里把上一帧的 frameLx/frameLy 存在 state 上自行推进。 */
    const M = s.input;
    const mdx = M.frameLx - s.prevFrameX;
    const mdy = M.frameLy - s.prevFrameY;
    s.prevFrameX = M.frameLx;
    s.prevFrameY = M.frameLy;
    const mdist = Math.sqrt(mdx * mdx + mdy * mdy);

    // 原型口径的原始逐帧速度（基类的 input.vx/vy 走 1-exp(-25dt) 平滑，口径不同）
    s.rawVx = dt > 0 ? mdx / dt : 0;
    s.rawVy = dt > 0 ? mdy / dt : 0;

    if (mdist > 1.5) {
      const inv = 1 / mdist;
      s.dirX += (mdx * inv - s.dirX) * 0.3;
      s.dirY += (mdy * inv - s.dirY) * 0.3;
      const dl = Math.sqrt(s.dirX * s.dirX + s.dirY * s.dirY);
      if (dl > 0.001) { s.dirX /= dl; s.dirY /= dl; }
      else { s.dirX = 1; s.dirY = 0; }
    }

    /* ---- 冻结计时 ---- */
    if (s.freezeTimer > 0) {
      s.freezeTimer -= dt;
      s.frozen = true;
      if (s.freezeTimer <= 0) {
        s.freezeTimer = 0;
        s.frozen = false;
        if (s.pendingBurst) {
          const fn = s.pendingBurst;
          s.pendingBurst = null;
          fn();
        }
      }
    } else {
      s.frozen = false;
    }

    /* ---- 聚合抑制计时 ---- */
    if (s.cohTimer >= 0) {
      s.cohTimer += dt;
      if (s.cohTimer > CONFIG.fx.cohesionHold + CONFIG.fx.cohesionRecover) s.cohTimer = -1;
    }

    /* ---- 蓄力推进 ----
       原型此处对两种模式都夹在 bait.chargeMax 上（migrate.chargeMax 同值 2.5，行为一致），
       这里原样保留该写法。 */
    if (s.mode !== null) {
      s.charge = Math.min(s.charge + dt, CONFIG.bait.chargeMax);
    }

    /* ---- 拖尾鱼生成 ---- */
    if (!s.frozen && mdist > 0.5) {
      s.trailAccum += mdist;
      let spawned = 0;
      const pal = (s.mode === 'migrate') ? 1 : 0;
      while (s.trailAccum >= CONFIG.trail.spawnDist && spawned < CONFIG.trail.maxPerFrame) {
        s.trailAccum -= CONFIG.trail.spawnDist;
        spawned++;

        // 原型第 1068 行：Math.min(500, mdist / Math.max(dt, 0.001)) —— 原始逐帧速度，上限 500 px/s。
        // 进入本分支必有 mdist > 0.5，dt 又 ≤ 0.05，故与 rawV 的模等价。
        const rawSp = Math.sqrt(s.rawVx * s.rawVx + s.rawVy * s.rawVy);
        const speedMag = Math.min(500, rawSp) * CONFIG.trail.speedScale;
        const baseA = Math.atan2(mdy, mdx);
        const a = baseA + (Math.random() - 0.5) * CONFIG.trail.jitter * 2;
        const sp = speedMag * (0.55 + Math.random() * 0.9);

        const size = rand(CONFIG.trail.sizeMin, CONFIG.trail.sizeMax);

        spawnFish(
          s,
          M.x + (Math.random() - 0.5) * 10,
          M.y + (Math.random() - 0.5) * 10,
          Math.cos(a) * sp,
          Math.sin(a) * sp,
          size, pal,
          rand(CONFIG.fish.lifeMin, CONFIG.fish.lifeMax)
        );
      }
      if (s.trailAccum > CONFIG.trail.spawnDist * 8) s.trailAccum = CONFIG.trail.spawnDist * 8;
    } else {
      s.trailAccum *= Math.exp(-4 * dt);
    }

    /* ---- 蓄力生成：诱饵球 / 迁徙鱼带 ----
       470 是原型里的硬编码存活上限（低于池上限 600），原样保留。 */
    if (!s.frozen && s.mode === 'bait' && s.aliveCount < 470) {
      const p = baitProgress(s);
      const rate = lerp(CONFIG.bait.spawnRateMin, CONFIG.bait.spawnRateMax, p);
      s.baitSpawnAcc += rate * dt;
      let guard = 0;
      while (s.baitSpawnAcc >= 1 && guard < 8) {
        s.baitSpawnAcc -= 1;
        guard++;
        spawnBaitFish(s);
      }
    } else if (s.mode !== 'bait') {
      s.baitSpawnAcc = 0;
    }

    if (!s.frozen && s.mode === 'migrate' && s.aliveCount < 470) {
      const p = migrateProgress(s);
      const rate = lerp(CONFIG.migrate.spawnRateMin, CONFIG.migrate.spawnRateMax, p);
      s.migrateSpawnAcc += rate * dt;
      let guard = 0;
      while (s.migrateSpawnAcc >= 1 && guard < 8) {
        s.migrateSpawnAcc -= 1;
        guard++;
        spawnMigrateFish(s);
      }
    } else if (s.mode !== 'migrate') {
      s.migrateSpawnAcc = 0;
    }

    /* ---- 空间网格重建 ---- */
    buildGrid(s);

    /* ---- 鱼体更新 ---- */
    for (let i = 0; i < POOL; i++) {
      const f = s.pool[i];
      if (f.alive) updateFish(s, f, dt);
    }

    /* ---- 特效更新 ---- */
    updateFx(s, dt);
  }

  /* ==================================================================
     渲染
     ================================================================== */
  render(s) {
    if (!s) return;
    const ctx = s.ctx;

    // 画布缓冲与 DPR 缩放由基类维护（原型 render 开头的画布变换已删除），
    // 统一使用 CSS 像素坐标；这里没有任何整屏铺底，只有清屏。
    ctx.clearRect(0, 0, s.W, s.H);

    /* 鱼群 */
    for (let i = 0; i < POOL; i++) {
      const f = s.pool[i];
      if (f.alive) drawFish(ctx, f, s);
    }

    /* 特效层 */
    drawRings(ctx, s);
    drawWaveLines(ctx, s);
    drawBubbles(ctx, s);
    drawFlashes(ctx, s);
  }
}

if (!customElements.get('cursor-fish')) {
  customElements.define('cursor-fish', CursorFish);
}

export default CursorFish;
