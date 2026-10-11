/**
 * cursor-ball —— 鼠标光标彩球动效（左键弹力球 / 右键玻璃珠）。
 *
 * 由 html/彩球.html 原型移植：算法流程、数值、视觉表现与原文件一一对应。
 * 作为光标层组件，原型页面自身的行为已剔除：
 *   - 原型用不透明上下文（{ alpha: false }）并在 render() 开头铺一层 #090b10 底色来承载整页背景；
 *     移植后基类的 canvas 是透明的，render() 改为 clearRect，绝不覆盖宿主页面；
 *     球体、高光、离屏贴图等有明确形状的填充全部保留；
 *   - 不拦截 contextmenu（原型在 mousedown 右键时 preventDefault，并在 contextmenu 上再拦一次），
 *     统一交给基类处理；
 *   - 画布创建、DPR 适配、尺寸同步、监听注册、rAF 循环全部由基类负责；
 *   - 鼠标速度：基类的 input.vx / vy 是平滑值且带「>300px 跳变归零 / 6000 封顶」保护，
 *     而原型用的是未平滑的 mouse.vx / mouse.vy（原始逐帧位移 / dt，对跳变不做任何处理）。
 *     为与原型逐帧一致，本动效在 update() 里按原型口径另算一份原始速度存入 state（s.rawVx / s.rawVy），
 *     基类仍照常维护 this.input，只是这两处不再取它的平滑速度。
 *
 * 原型监听 mousemove / mousedown / mouseup，因此声明 inputFamily = 'mouse'。
 * 所有运行状态（球池、空间网格、特效、蓄力、颜色与贴图缓存）都放在 setup() 返回的 state 上，
 * 多实例互不干扰。
 */

import { CursorEffectElement } from '../core/base.js';
import { TAU, clamp, rand, randInt } from '../core/utils.js';

/* =========================================================================
   CONFIG —— 集中所有可调参数（中文注释）
   ========================================================================= */
const CONFIG = {
  // 球对象池上限（球的绘制比粒子重，必须控制数量）
  MAX_BALLS: 700,

  // 空间网格单元边长（px）
  GRID_CELL: 64,

  // 左键（弹力球）明亮糖果色
  CANDY: ['#FF3D5A', '#FF8C1A', '#FFD23F', '#3DD68C',
          '#3DDBF0', '#3D7BFF', '#8A5CFF', '#FF5CD8'],

  // 右键（玻璃珠）深沉玻璃色
  GLASS: ['#C41E3A', '#1E3AC4', '#1E8A3A', '#D48A1E',
          '#7A3AC4', '#1EC4A0', '#C41E8A', '#3A5CD4'],

  // 物理参数
  GRAVITY: 400,          // 左键爆发球重力 px/s²
  TRAIL_GRAVITY: 200,    // 拖尾球重力 px/s²
  RESTITUTION: 0.92,     // 球球碰撞弹性系数

  // 蓄力
  CHARGE_MAX: 2.5,       // 最大蓄力时长 s
  CHARGE_MIN: 0.12,      // 低于该时长视为普通单击

  // 弹性形变弹簧
  SQ_K: 320,             // 弹簧刚度
  SQ_D: 15,              // 阻尼

  // 拖尾
  TRAIL_R_MIN: 3, TRAIL_R_MAX: 9,
  TRAIL_LIFE_MIN: 0.8, TRAIL_LIFE_MAX: 1.5,
  TRAIL_SPEED_FACTOR: 0.4,
  TRAIL_PER_PX: 10,
  TRAIL_MAX_PER_FRAME: 4,

  // 单击爆发
  CLICK_COUNT_MIN: 8, CLICK_COUNT_MAX: 14,
  CLICK_R_MIN: 6, CLICK_R_MAX: 14,
  CLICK_SPEED_MIN: 250, CLICK_SPEED_MAX: 600,
  CLICK_RING_COUNT_MIN: 12, CLICK_RING_COUNT_MAX: 18,
  CLICK_RING_RADIUS: 90, CLICK_RING_LIFE: 0.4,

  // 左键蓄力
  L_CHARGE_RATE_BASE: 20,
  L_CHARGE_RATE_MAX: 110,
  L_CLUSTER_R: 90,
  L_CORE_R_MIN: 6, L_CORE_R_MAX: 20,

  // 右键蓄力
  R_ORBITS: [25, 40, 60, 85, 120],
  R_CHARGE_RATE_BASE: 14,
  R_CHARGE_RATE_MAX: 80,
  R_SPIN_MIN: 1, R_SPIN_MAX: 12,

  // 母球
  MOTHER_R: 12,
  MOTHER_SPEED_MIN: 500, MOTHER_SPEED_MAX: 800,
  MOTHER_LIFE: 0.7,

  // 马格努斯系数
  MAGNUS: 0.15,

  // 特效上限
  MAX_EFFECTS: 420
};

/* =========================================================================
   工具函数
   ========================================================================= */
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

// 颜色解析缓存：原型是模块级 Map（多实例共享），移植后挂在 state 上，
// 保证每个实例的状态完全隔离。缓存只做纯记忆化，不改变任何结果。
function hexToRgb(cache, hex) {
  let v = cache.get(hex);
  if (v) return v;
  const n = parseInt(hex.slice(1), 16);
  v = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  cache.set(hex, v);
  return v;
}
function shade(cache, hex, amt) {
  const c = hexToRgb(cache, hex);
  let r, g, b;
  if (amt >= 0) {
    r = c[0] + (255 - c[0]) * amt;
    g = c[1] + (255 - c[1]) * amt;
    b = c[2] + (255 - c[2]) * amt;
  } else {
    const k = 1 + amt;
    r = c[0] * k; g = c[1] * k; b = c[2] * k;
  }
  return 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
}
function shadeA(cache, hex, amt, a) {
  const c = hexToRgb(cache, hex);
  let r, g, b;
  if (amt >= 0) {
    r = c[0] + (255 - c[0]) * amt;
    g = c[1] + (255 - c[1]) * amt;
    b = c[2] + (255 - c[2]) * amt;
  } else {
    const k = 1 + amt;
    r = c[0] * k; g = c[1] * k; b = c[2] * k;
  }
  return 'rgba(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ',' + a + ')';
}
function rgbaStr(cache, hex, a) {
  const c = hexToRgb(cache, hex);
  return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')';
}

/* =========================================================================
   离屏纹理预渲染
   第 1 层（球体渐变）与第 3/4/5 层（高光 + 暗边）与旋转无关，
   按主色缓存为离屏 canvas，绘制时直接 drawImage 缩放。
   第 2 层（球面花纹）随 rotation 动态绘制。

   原型用全局 document 创建这两张离屏画布；移植后改用元素自身的
   ownerDocument（s.doc），既不触碰任何全局对象，也绝不挂进 DOM。
   这里的 width / height / getContext 都只作用于离屏贴图画布，与主画布无关。
   ========================================================================= */
const TEX_SIZE = 128;
const TEX_R = 64;

function getTextures(s, color1) {
  let t = s.texCache.get(color1);
  if (t) return t;

  const doc = s.doc;

  // ---- 第 1 层：球体本体（径向渐变，光源左上） ----
  const body = doc.createElement('canvas');
  body.width = body.height = TEX_SIZE;
  const bc = body.getContext('2d');
  const cx = TEX_R, cy = TEX_R;
  const g = bc.createRadialGradient(
    cx - 0.3 * TEX_R, cy - 0.3 * TEX_R, TEX_R * 0.04,
    cx, cy, TEX_R
  );
  g.addColorStop(0.00, shade(s.rgbCache, color1, 0.30));
  g.addColorStop(0.40, color1);
  g.addColorStop(0.85, shade(s.rgbCache, color1, -0.35));
  g.addColorStop(1.00, shade(s.rgbCache, color1, -0.60));
  bc.beginPath();
  bc.arc(cx, cy, TEX_R, 0, TAU);
  bc.fillStyle = g;
  bc.fill();

  // ---- 第 3/4/5 层：高光 + 暗边 ----
  const hi = doc.createElement('canvas');
  hi.width = hi.height = TEX_SIZE;
  const hc = hi.getContext('2d');

  // 第 3 层：主高光
  hc.save();
  hc.translate(cx - 0.32 * TEX_R, cy - 0.32 * TEX_R);
  hc.scale(1, 0.55);
  const hg = hc.createRadialGradient(0, 0, 0, 0, 0, TEX_R * 0.28);
  hg.addColorStop(0.0, 'rgba(255,255,255,0.85)');
  hg.addColorStop(0.5, 'rgba(255,255,255,0.55)');
  hg.addColorStop(1.0, 'rgba(255,255,255,0)');
  hc.beginPath();
  hc.arc(0, 0, TEX_R * 0.28, 0, TAU);
  hc.fillStyle = hg;
  hc.fill();
  hc.restore();

  // 第 4 层：副高光
  hc.save();
  hc.translate(cx + 0.32 * TEX_R, cy + 0.32 * TEX_R);
  hc.scale(1, 0.5);
  const sg = hc.createRadialGradient(0, 0, 0, 0, 0, TEX_R * 0.126);
  sg.addColorStop(0.0, 'rgba(255,255,255,0.22)');
  sg.addColorStop(1.0, 'rgba(255,255,255,0)');
  hc.beginPath();
  hc.arc(0, 0, TEX_R * 0.126, 0, TAU);
  hc.fillStyle = sg;
  hc.fill();
  hc.restore();

  // 第 5 层：暗边
  hc.save();
  hc.beginPath();
  hc.arc(cx, cy, TEX_R * 0.93, Math.PI * 0.08, Math.PI * 0.42);
  hc.strokeStyle = shadeA(s.rgbCache, color1, -0.70, 0.50);
  hc.lineWidth = TEX_R * 0.10;
  hc.lineCap = 'round';
  hc.stroke();
  hc.restore();

  t = { body: body, hi: hi };
  s.texCache.set(color1, t);
  return t;
}

/* =========================================================================
   球对象池
   ========================================================================= */
function makeBall() {
  return {
    id: 0,
    x: 0, y: 0, vx: 0, vy: 0,
    r: 5, r0: 5, m: 1,
    rotation: 0, angularVelocity: 0,
    squashX: 1, squashY: 1, squashAngle: 0,
    sqVX: 0, sqVY: 0,
    color1: '#ffffff', color2: '#ffffff',
    patternType: 0, pattern: null,
    life: Infinity, maxLife: Infinity,
    alpha: 1,
    gravity: 0,
    mode: 'free',
    jx: 0, jy: 0,
    orbitR: 0, orbitA: 0, orbitW: 0,
    mother: false
  };
}
function obtain(s) {
  return s.pool.length ? s.pool.pop() : makeBall();
}
function resetBall(b) {
  b.x = 0; b.y = 0; b.vx = 0; b.vy = 0;
  b.r = 5; b.r0 = 5; b.m = 1;
  b.rotation = 0; b.angularVelocity = 0;
  b.squashX = 1; b.squashY = 1; b.squashAngle = 0;
  b.sqVX = 0; b.sqVY = 0;
  b.color1 = '#ffffff'; b.color2 = '#ffffff';
  b.patternType = 0; b.pattern = null;
  b.life = Infinity; b.maxLife = Infinity;
  b.alpha = 1;
  b.gravity = 0;
  b.mode = 'free';
  b.jx = 0; b.jy = 0;
  b.orbitR = 0; b.orbitA = 0; b.orbitW = 0;
  b.mother = false;
}

function initPattern(b) {
  b.patternType = randInt(0, 4);
  switch (b.patternType) {
    case 0:
      b.pattern = { n: randInt(3, 5) };
      break;
    case 1: {
      const n = randInt(3, 7);
      const spots = [];
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU;
        const rr = Math.sqrt(Math.random()) * 0.72;
        spots.push({ x: Math.cos(a) * rr, y: Math.sin(a) * rr });
      }
      b.pattern = { spots: spots };
      break;
    }
    case 2:
      b.pattern = { n: randInt(4, 8) };
      break;
    case 3:
      b.pattern = {};
      break;
    default:
      b.pattern = { angle: Math.random() * TAU };
      break;
  }
}

function spawnBall(s, o) {
  if (s.balls.length >= CONFIG.MAX_BALLS) return null;
  const b = obtain(s);
  resetBall(b);
  b.id = ++s.idCounter;
  b.x = o.x; b.y = o.y;
  b.vx = o.vx || 0;
  b.vy = o.vy || 0;
  b.r = o.r; b.r0 = o.r;
  b.m = (o.m !== undefined) ? o.m : (b.r * b.r * b.r * 0.01);
  b.color1 = o.color1;
  b.color2 = o.color2 || pick(CONFIG.CANDY);
  b.rotation = o.rotation !== undefined ? o.rotation : Math.random() * TAU;
  b.angularVelocity = o.angularVelocity || 0;
  b.squashX = o.squashX || 1;
  b.squashY = o.squashY || 1;
  b.squashAngle = o.squashAngle || 0;
  b.life = (o.life !== undefined) ? o.life : Infinity;
  b.maxLife = (o.maxLife !== undefined) ? o.maxLife : b.life;
  b.gravity = o.gravity || 0;
  b.mode = o.mode || 'free';
  b.orbitR = o.orbitR || 0;
  b.orbitA = o.orbitA || 0;
  b.orbitW = o.orbitW || 0;
  b.mother = !!o.mother;
  b.alpha = 1;
  initPattern(b);
  s.balls.push(b);
  return b;
}

function killBall(s, i) {
  const b = s.balls[i];
  s.balls.splice(i, 1);
  if (s.pool.length < CONFIG.MAX_BALLS + 200) s.pool.push(b);
}

/* =========================================================================
   球面花纹绘制（第 2 层）
   ========================================================================= */
function drawPattern(ctx, s, b, r) {
  const c2 = b.color2;
  const pat = b.pattern;
  if (!pat) return;

  switch (b.patternType) {
    case 0: {
      const n = pat.n;
      ctx.fillStyle = rgbaStr(s.rgbCache, c2, 0.85);
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0 : (i / (n - 1)) * 1.6 - 0.8;
        const px = t * r * 0.92;
        const w = r * 0.14 * Math.sqrt(Math.max(0.08, 1 - t * t));
        ctx.beginPath();
        ctx.ellipse(px, 0, w, r * 1.05, 0, 0, TAU);
        ctx.fill();
      }
      break;
    }
    case 1: {
      ctx.fillStyle = rgbaStr(s.rgbCache, c2, 0.9);
      const spots = pat.spots;
      for (let i = 0; i < spots.length; i++) {
        const sp = spots[i];
        const px = sp.x * r;
        const py = sp.y * r;
        const k = Math.sqrt(Math.max(0.18, 1 - (sp.x * sp.x + sp.y * sp.y) * 0.55));
        ctx.beginPath();
        ctx.ellipse(px, py, r * 0.16 * k, r * 0.16 * k * 0.6, 0, 0, TAU);
        ctx.fill();
      }
      break;
    }
    case 2: {
      const n = pat.n;
      for (let i = 0; i < n; i++) {
        const a0 = i * TAU / n;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, r * 1.15, a0, a0 + TAU / n * 0.8);
        ctx.closePath();
        ctx.fillStyle = (i % 2 === 0) ? rgbaStr(s.rgbCache, c2, 0.85) : shadeA(s.rgbCache, b.color1, 0.25, 0.65);
        ctx.fill();
      }
      break;
    }
    case 3: {
      const g = ctx.createRadialGradient(r * 0.30, -r * 0.30, 0, 0, 0, r * 1.15);
      g.addColorStop(0.0, rgbaStr(s.rgbCache, c2, 0.88));
      g.addColorStop(0.55, rgbaStr(s.rgbCache, c2, 0.32));
      g.addColorStop(1.0, rgbaStr(s.rgbCache, c2, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.fill();
      break;
    }
    default: {
      ctx.save();
      ctx.rotate(pat.angle);
      ctx.beginPath();
      ctx.rect(-r * 1.6, -r * 1.6, r * 1.6, r * 3.2);
      ctx.fillStyle = rgbaStr(s.rgbCache, c2, 0.88);
      ctx.fill();
      ctx.restore();
      break;
    }
  }
}

/* =========================================================================
   球体绘制（5 层）
   ========================================================================= */
function drawBall(ctx, s, b) {
  const r = b.r;
  if (r < 0.4 || b.alpha <= 0.01) return;

  ctx.save();
  ctx.globalAlpha = b.alpha;
  ctx.translate(b.x + b.jx, b.y + b.jy);
  if (b.squashAngle !== 0) ctx.rotate(b.squashAngle);
  if (b.squashX !== 1 || b.squashY !== 1) ctx.scale(b.squashX, b.squashY);

  const tex = getTextures(s, b.color1);
  const d = r * 2;

  // 第 1 层
  ctx.drawImage(tex.body, -r, -r, d, d);

  // 第 2 层
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.clip();
  ctx.rotate(b.rotation);
  drawPattern(ctx, s, b, r);
  ctx.restore();

  // 第 3、4、5 层
  ctx.drawImage(tex.hi, -r, -r, d, d);

  ctx.restore();
}

/* =========================================================================
   空间网格（Spatial Hash）
   ========================================================================= */
const CELL = CONFIG.GRID_CELL;

function buildGrid(s) {
  const grid = s.grid;
  const balls = s.balls;
  grid.clear();
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    if (b.mode === 'chargeR') continue;
    const cx = Math.floor(b.x / CELL);
    const cy = Math.floor(b.y / CELL);
    const k = cx * 10007 + cy;
    let cell = grid.get(k);
    if (!cell) { cell = []; grid.set(k, cell); }
    cell.push(b);
  }
}

/* =========================================================================
   碰撞检测与响应
   ========================================================================= */
function resolvePair(s, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const minD = a.r + b.r;
  const d2 = dx * dx + dy * dy;
  if (d2 >= minD * minD || d2 < 1e-8) return;

  const d = Math.sqrt(d2);
  const nx = dx / d, ny = dy / d;
  const overlap = minD - d;

  const im1 = 1 / a.m, im2 = 1 / b.m;
  const imSum = im1 + im2;
  if (imSum <= 0) return;

  const corr = overlap / imSum;
  a.x -= nx * corr * im1;
  a.y -= ny * corr * im1;
  b.x += nx * corr * im2;
  b.y += ny * corr * im2;

  const rvx = b.vx - a.vx;
  const rvy = b.vy - a.vy;
  const vn = rvx * nx + rvy * ny;
  if (vn > 0) return;

  const e = CONFIG.RESTITUTION;
  const j = -(1 + e) * vn / imSum;
  a.vx -= j * nx * im1;
  a.vy -= j * ny * im1;
  b.vx += j * nx * im2;
  b.vy += j * ny * im2;

  const tx = -ny, ty = nx;
  const vt = rvx * tx + rvy * ty;
  a.angularVelocity -= vt * 0.0035;
  b.angularVelocity += vt * 0.0035;
  a.angularVelocity = clamp(a.angularVelocity, -40, 40);
  b.angularVelocity = clamp(b.angularVelocity, -40, 40);

  if (a.mode !== 'chargeL' && a.mode !== 'chargeR') {
    a.squashX = 1.15; a.squashY = 0.90;
    a.sqVX = 0; a.sqVY = 0;
  }
  if (b.mode !== 'chargeL' && b.mode !== 'chargeR') {
    b.squashX = 1.15; b.squashY = 0.90;
    b.sqVX = 0; b.sqVY = 0;
  }

  const impact = -vn;
  if (impact > 160 && s.sparkBudget > 0) {
    s.sparkBudget--;
    addEffect(s, {
      type: 'spark',
      x: (a.x + b.x) * 0.5,
      y: (a.y + b.y) * 0.5,
      r: 3 + Math.min(5, impact * 0.006),
      angle: Math.atan2(ny, nx),
      life: 0.08, maxLife: 0.08
    });
  }
}

function handleCollisions(s) {
  const balls = s.balls;
  const grid = s.grid;
  buildGrid(s);
  s.sparkBudget = 10;

  for (let i = 0; i < balls.length; i++) {
    const a = balls[i];
    if (a.mode === 'chargeR') continue;

    const cx = Math.floor(a.x / CELL);
    const cy = Math.floor(a.y / CELL);
    const reach = (a.r + 50 > CELL) ? 2 : 1;

    for (let gx = cx - reach; gx <= cx + reach; gx++) {
      for (let gy = cy - reach; gy <= cy + reach; gy++) {
        const cell = grid.get(gx * 10007 + gy);
        if (!cell) continue;
        for (let k = 0; k < cell.length; k++) {
          const b = cell[k];
          if (b === a || b.id <= a.id) continue;
          if (b.mode === 'chargeR') continue;
          resolvePair(s, a, b);
        }
      }
    }
  }
}

/* =========================================================================
   特效
   ========================================================================= */
function addEffect(s, e) {
  if (s.effects.length >= CONFIG.MAX_EFFECTS) s.effects.shift();
  s.effects.push(e);
}

function updateEffects(s, dt) {
  const effects = s.effects;
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i];
    e.life -= dt;
    if (e.life <= 0) effects.splice(i, 1);
  }
}

function drawEffects(ctx, s) {
  const effects = s.effects;
  for (let i = 0; i < effects.length; i++) {
    const e = effects[i];
    const t = 1 - e.life / e.maxLife;

    if (e.type === 'flash') {
      const rr = e.r * (0.4 + t * 1.1);
      const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, rr);
      g.addColorStop(0, 'rgba(255,255,255,' + (0.6 * (1 - t)) + ')');
      g.addColorStop(0.45, 'rgba(255,245,225,' + (0.3 * (1 - t)) + ')');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(e.x, e.y, rr, 0, TAU);
      ctx.fill();
    } else if (e.type === 'spark') {
      const a = 1 - t;
      const sp = e.r * (1 + t * 0.8);
      ctx.save();
      ctx.translate(e.x, e.y);
      ctx.rotate(e.angle);
      ctx.strokeStyle = 'rgba(255,255,255,' + a + ')';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(-sp, 0); ctx.lineTo(sp, 0);
      ctx.moveTo(0, -sp); ctx.lineTo(0, sp);
      ctx.stroke();
      ctx.restore();
    } else if (e.type === 'line') {
      const a = 1 - t;
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.22 * a) + ')';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(e.x, e.y);
      ctx.lineTo(e.x2, e.y2);
      ctx.stroke();
    }
  }
}

/* =========================================================================
   拖尾
   ========================================================================= */
function spawnTrail(s, x, y, vx, vy) {
  const charge = s.charge;
  const r = rand(CONFIG.TRAIL_R_MIN, CONFIG.TRAIL_R_MAX);
  const speed = Math.hypot(vx, vy);

  if (charge.active && charge.button === 0) {
    spawnBall(s, {
      x: x, y: y,
      vx: vx * 0.4, vy: vy * 0.4,
      r: r,
      color1: pick(CONFIG.CANDY),
      mode: 'chargeL',
      angularVelocity: (speed / Math.max(r, 2)) * 0.5 * (Math.random() < 0.5 ? 1 : -1),
      life: Infinity
    });
    return;
  }
  if (charge.active && charge.button === 2) {
    const ti = randInt(0, CONFIG.R_ORBITS.length - 1);
    const orbitR = CONFIG.R_ORBITS[ti];
    const a = Math.random() * TAU;
    const p = Math.min(charge.t / CONFIG.CHARGE_MAX, 1);
    spawnBall(s, {
      x: charge.x + Math.cos(a) * orbitR,
      y: charge.y + Math.sin(a) * orbitR,
      r: Math.max(3, r * 0.8),
      color1: pick(CONFIG.GLASS),
      mode: 'chargeR',
      orbitR: orbitR,
      orbitA: a,
      orbitW: orbitSpeed(orbitR, p) * 0.85,
      angularVelocity: rand(2, 6) * (Math.random() < 0.5 ? 1 : -1)
    });
    return;
  }

  spawnBall(s, {
    x: x, y: y,
    vx: vx * CONFIG.TRAIL_SPEED_FACTOR,
    vy: vy * CONFIG.TRAIL_SPEED_FACTOR,
    r: r,
    color1: pick(CONFIG.CANDY),
    angularVelocity: (speed / Math.max(r, 2)) * 0.5 * (Math.random() < 0.5 ? 1 : -1),
    gravity: CONFIG.TRAIL_GRAVITY,
    life: rand(CONFIG.TRAIL_LIFE_MIN, CONFIG.TRAIL_LIFE_MAX),
    mode: 'free'
  });
}

/* =========================================================================
   单击：彩球爆发 + 彩球圆环 + 母球连锁碰撞
   ========================================================================= */
function clickBurst(s, x, y) {
  const n = randInt(CONFIG.CLICK_COUNT_MIN, CONFIG.CLICK_COUNT_MAX);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rand(-0.2, 0.2);
    const sp = rand(CONFIG.CLICK_SPEED_MIN, CONFIG.CLICK_SPEED_MAX);
    const r = rand(CONFIG.CLICK_R_MIN, CONFIG.CLICK_R_MAX);
    spawnBall(s, {
      x: x, y: y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      r: r,
      color1: pick(CONFIG.CANDY),
      gravity: CONFIG.GRAVITY,
      angularVelocity: (sp / r) * 0.8 * (Math.random() < 0.5 ? 1 : -1),
      life: 3.0, maxLife: 3.0,
      mode: 'free'
    });
  }

  const rn = randInt(CONFIG.CLICK_RING_COUNT_MIN, CONFIG.CLICK_RING_COUNT_MAX);
  const maxR = CONFIG.CLICK_RING_RADIUS;
  for (let i = 0; i < rn; i++) {
    const a = (i / rn) * TAU;
    spawnBall(s, {
      x: x + Math.cos(a) * 10,
      y: y + Math.sin(a) * 10,
      vx: Math.cos(a) * (maxR / CONFIG.CLICK_RING_LIFE),
      vy: Math.sin(a) * (maxR / CONFIG.CLICK_RING_LIFE),
      r: rand(2.5, 4.5),
      color1: pick(CONFIG.CANDY),
      gravity: 0,
      angularVelocity: rand(-8, 8),
      life: CONFIG.CLICK_RING_LIFE,
      maxLife: CONFIG.CLICK_RING_LIFE,
      mode: 'free'
    });
  }

  addEffect(s, {
    type: 'spark',
    x: x, y: y, r: 14, angle: Math.random() * TAU,
    life: 0.1, maxLife: 0.1
  });

  // 母球方向：沿用鼠标最后一段移动方向（与原型一致，用未平滑的原始速度）
  let dirX = s.rawVx || 0, dirY = s.rawVy || 0;
  const dl = Math.hypot(dirX, dirY);
  if (dl < 30) {
    const a = Math.random() * TAU;
    dirX = Math.cos(a); dirY = Math.sin(a);
  } else {
    dirX /= dl; dirY /= dl;
  }
  const sp = rand(CONFIG.MOTHER_SPEED_MIN, CONFIG.MOTHER_SPEED_MAX);
  const mother = spawnBall(s, {
    x: x, y: y,
    vx: dirX * sp,
    vy: dirY * sp,
    r: CONFIG.MOTHER_R,
    m: CONFIG.MOTHER_R * CONFIG.MOTHER_R * CONFIG.MOTHER_R * 0.05,
    color1: '#FFFFFF',
    color2: '#E8E8FF',
    gravity: 0,
    angularVelocity: rand(18, 26) * (Math.random() < 0.5 ? 1 : -1),
    life: CONFIG.MOTHER_LIFE,
    maxLife: CONFIG.MOTHER_LIFE,
    mode: 'free',
    mother: true
  });
  if (mother) {
    mother.squashAngle = Math.atan2(dirY, dirX);
    mother.squashX = 1.35;
    mother.squashY = 0.78;
  }
}

/* =========================================================================
   蓄力系统
   ========================================================================= */
function startCharge(s, button, x, y) {
  const charge = s.charge;
  charge.active = true;
  charge.button = button;
  charge.t = 0;
  charge.x = x;
  charge.y = y;
  charge.jx = 0;
  charge.jy = 0;
  charge.spawnAcc = 0;
  charge.splashTimer = 0.35;
  charge.cracks.length = 0;
}

function cancelCharge(s) {
  const charge = s.charge;
  const balls = s.balls;
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    if (b.mode === 'chargeL') {
      b.mode = 'free';
      b.gravity = CONFIG.GRAVITY;
      b.vx = rand(-100, 100);
      b.vy = rand(-100, 100);
      b.life = 1.0; b.maxLife = 1.0;
    } else if (b.mode === 'chargeR') {
      b.mode = 'freeR';
      b.gravity = 0;
      const a = b.orbitA;
      const sp = b.orbitW * b.orbitR;
      b.vx = -Math.sin(a) * sp;
      b.vy = Math.cos(a) * sp;
      b.life = 0.8; b.maxLife = 0.8;
    }
  }
  charge.active = false;
  charge.cracks.length = 0;
}

function orbitSpeed(r, p) {
  const v = (150 + 1100 * p) * (45 / (r + 40));
  return v / r;
}

function updateCharge(s, dt) {
  const charge = s.charge;
  const balls = s.balls;

  if (!charge.active) {
    for (let i = charge.cracks.length - 1; i >= 0; i--) {
      charge.cracks[i].life -= dt;
      if (charge.cracks[i].life <= 0) charge.cracks.splice(i, 1);
    }
    return;
  }

  charge.t += dt;
  const p = Math.min(charge.t / CONFIG.CHARGE_MAX, 1);

  charge.x = s.input.x;
  charge.y = s.input.y;

  const shakeAmt = Math.max(0, (p - 0.55) / 0.45) * 3;
  if (shakeAmt > 0) {
    charge.jx = rand(-shakeAmt, shakeAmt);
    charge.jy = rand(-shakeAmt, shakeAmt);
  } else {
    charge.jx *= 0.7;
    charge.jy *= 0.7;
  }

  const cx = charge.x;
  const cy = charge.y;

  if (charge.button === 0) {
    /* ---------------- 左键：弹性压缩弹射 ---------------- */
    const rate = CONFIG.L_CHARGE_RATE_BASE +
      (CONFIG.L_CHARGE_RATE_MAX - CONFIG.L_CHARGE_RATE_BASE) * p;
    charge.spawnAcc += rate * dt;

    while (charge.spawnAcc >= 1) {
      charge.spawnAcc -= 1;
      if (balls.length >= CONFIG.MAX_BALLS - 10) break;

      const a = Math.random() * TAU;
      const dist = 150 + Math.random() * 220;
      const sx = cx + Math.cos(a) * dist;
      const sy = cy + Math.sin(a) * dist;
      const sp = 260 + Math.random() * 340;
      const r = rand(5, 12);

      spawnBall(s, {
        x: sx, y: sy,
        vx: -Math.cos(a) * sp + rand(-70, 70),
        vy: -Math.sin(a) * sp + rand(-70, 70),
        r: r,
        color1: pick(CONFIG.CANDY),
        angularVelocity: rand(-8, 8),
        mode: 'chargeL',
        life: Infinity
      });
    }

    const k = Math.min(1, 9 * dt);
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (b.mode !== 'chargeL') continue;

      const dx = cx - b.x;
      const dy = cy - b.y;
      const d = Math.hypot(dx, dy) || 0.001;
      const nx = dx / d, ny = dy / d;
      const targetSp = Math.min(d * 3.6, 820);
      b.vx += (nx * targetSp - b.vx) * k;
      b.vy += (ny * targetSp - b.vy) * k;

      const f = clamp(1 - d / CONFIG.L_CLUSTER_R, 0, 1);
      const ff = f * f * Math.min(1, charge.t / 0.9);
      b.squashX = 1 + 0.35 * ff;
      b.squashY = 1 - 0.30 * ff;
      b.squashAngle = Math.atan2(dy, dx);
      b.sqVX = 0; b.sqVY = 0;

      b.angularVelocity *= Math.pow(0.35, dt);

      const edge = clamp(d / 80, 0, 1);
      if (Math.random() < 0.35 * (0.4 + p)) {
        b.jx = rand(-1.8, 1.8) * edge;
        b.jy = rand(-1.8, 1.8) * edge;
      } else {
        b.jx *= 0.75;
        b.jy *= 0.75;
      }
    }

    const crackRate = 6 + 26 * p;
    if (Math.random() < crackRate * dt) {
      charge.cracks.push({
        a: Math.random() * TAU,
        len: rand(18, 58) * (0.5 + p * 0.7),
        life: 0.15, maxLife: 0.15
      });
    }
  } else {
    /* ---------------- 右键：旋转飞散 ---------------- */
    const rate = CONFIG.R_CHARGE_RATE_BASE +
      (CONFIG.R_CHARGE_RATE_MAX - CONFIG.R_CHARGE_RATE_BASE) * p;
    charge.spawnAcc += rate * dt;

    const maxTrack = 1 + Math.floor(p * 4.99);

    while (charge.spawnAcc >= 1) {
      charge.spawnAcc -= 1;
      if (balls.length >= CONFIG.MAX_BALLS - 10) break;

      const ti = randInt(0, Math.min(maxTrack, CONFIG.R_ORBITS.length) - 1);
      const orbitR = CONFIG.R_ORBITS[ti];
      const a = Math.random() * TAU;

      spawnBall(s, {
        x: cx + Math.cos(a) * orbitR,
        y: cy + Math.sin(a) * orbitR,
        r: rand(4, 10),
        color1: pick(CONFIG.GLASS),
        mode: 'chargeR',
        orbitR: orbitR,
        orbitA: a,
        orbitW: orbitSpeed(orbitR, p),
        angularVelocity: (CONFIG.R_SPIN_MIN +
          (CONFIG.R_SPIN_MAX - CONFIG.R_SPIN_MIN) * p) * (Math.random() < 0.5 ? 1 : -1)
      });
    }

    const spinTarget = CONFIG.R_SPIN_MIN + (CONFIG.R_SPIN_MAX - CONFIG.R_SPIN_MIN) * p;
    const pulse = 1 + 0.04 * Math.sin(charge.t * (10 + 30 * p));
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (b.mode !== 'chargeR') continue;

      b.orbitW = orbitSpeed(b.orbitR, p);
      b.orbitA += b.orbitW * dt;

      let jitterR = 0, jitterA = 0;
      if (charge.t > 1.5 && b.orbitR < 45) {
        jitterR = rand(-3, 3) * p;
        jitterA = rand(-0.05, 0.05) * p;
      }

      const rr = b.orbitR * pulse + jitterR;
      b.x = cx + Math.cos(b.orbitA + jitterA) * rr;
      b.y = cy + Math.sin(b.orbitA + jitterA) * rr;

      const sgn = b.angularVelocity >= 0 ? 1 : -1;
      b.angularVelocity += (spinTarget * sgn - b.angularVelocity) * Math.min(1, 3 * dt);
    }

    charge.splashTimer -= dt;
    if (charge.splashTimer <= 0) {
      charge.splashTimer = 0.45 - 0.25 * p + Math.random() * 0.12;
      let outer = null, outerR = 0;
      for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        if (b.mode === 'chargeR' && b.orbitR > outerR) { outer = b; outerR = b.orbitR; }
      }
      if (outer && outerR > 50) {
        const a = outer.orbitA;
        const sp = outer.orbitW * outer.orbitR * 1.3;
        outer.mode = 'freeR';
        outer.gravity = 0;
        outer.vx = -Math.sin(a) * sp;
        outer.vy = Math.cos(a) * sp;
        outer.life = 1.4; outer.maxLife = 1.4;
        outer.r0 = outer.r;
        outer.squashAngle = Math.atan2(outer.vy, outer.vx);
        outer.squashX = 1.3;
        outer.squashY = 0.8;
      }
    }
  }

  for (let i = charge.cracks.length - 1; i >= 0; i--) {
    charge.cracks[i].life -= dt;
    if (charge.cracks[i].life <= 0) charge.cracks.splice(i, 1);
  }
}

/* =========================================================================
   松开爆发
   ========================================================================= */
function releaseCharge(s) {
  const charge = s.charge;
  const balls = s.balls;
  if (!charge.active) return;
  const btn = charge.button;
  const t = charge.t;
  const p = Math.pow(clamp(t / CONFIG.CHARGE_MAX, 0, 1), 1.6);
  const cx = charge.x;
  const cy = charge.y;

  if (t < CONFIG.CHARGE_MIN) {
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (b.mode === 'chargeL') {
        b.mode = 'free';
        b.gravity = CONFIG.GRAVITY;
        b.vx = rand(-130, 130);
        b.vy = rand(-130, 130);
        b.life = 1.0; b.maxLife = 1.0;
        b.r0 = b.r;
      } else if (b.mode === 'chargeR') {
        const a = b.orbitA;
        const sp = b.orbitW * b.orbitR * 1.2;
        b.mode = 'freeR';
        b.gravity = 0;
        b.vx = -Math.sin(a) * sp;
        b.vy = Math.cos(a) * sp;
        b.life = 0.9; b.maxLife = 0.9;
        b.r0 = b.r;
      }
    }
    charge.active = false;
    charge.cracks.length = 0;
    return;
  }

  if (btn === 0) burstLeft(s, cx, cy, p);
  else burstRight(s, cx, cy, p);

  charge.active = false;
  charge.cracks.length = 0;
}

/* ---------------- 左键：径向弹开 + 重力 ---------------- */
function burstLeft(s, cx, cy, p) {
  const balls = s.balls;
  const group = [];
  let maxD = 50;
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    if (b.mode !== 'chargeL') continue;
    const d = Math.hypot(b.x - cx, b.y - cy);
    if (d > maxD) maxD = d;
    group.push(b);
  }
  maxD = Math.max(maxD, 50);

  const baseSpeed = 400 + 1400 * p;

  for (let i = 0; i < group.length; i++) {
    const b = group[i];
    const dx = b.x - cx;
    const dy = b.y - cy;
    const d = Math.hypot(dx, dy) || 0.001;
    const nx = dx / d, ny = dy / d;

    const inner = 1 - Math.min(d / maxD, 1);
    const speed = baseSpeed * (0.72 + 0.55 * inner);

    b.vx = nx * speed;
    b.vy = ny * speed;
    b.squashAngle = Math.atan2(dy, dx);
    b.squashX = 1.40;
    b.squashY = 0.72;
    b.sqVX = 0; b.sqVY = 0;
    b.gravity = CONFIG.GRAVITY;
    b.mode = 'free';
    b.jx = 0; b.jy = 0;
    b.angularVelocity = (speed / Math.max(b.r, 3)) * 1.5 * (Math.random() < 0.5 ? 1 : -1);
    b.life = 3.2;
    b.maxLife = 3.2;
    b.r0 = b.r;
    b.alpha = 1;
  }

  const n = 24 + Math.floor(16 * p);
  const maxR = 150 + 450 * p;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rand(-0.06, 0.06);
    const sp = maxR / 0.45 * rand(0.85, 1.15);
    spawnBall(s, {
      x: cx + Math.cos(a) * 8,
      y: cy + Math.sin(a) * 8,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      r: rand(2, 4),
      color1: pick(CONFIG.CANDY),
      gravity: 0,
      angularVelocity: rand(-14, 14),
      life: 0.5, maxLife: 0.5,
      mode: 'free'
    });
  }

  addEffect(s, {
    type: 'flash',
    x: cx, y: cy, r: 60,
    life: 0.15, maxLife: 0.15
  });
}

/* ---------------- 右键：切向甩出 + 无重力 + 马格努斯 ---------------- */
function burstRight(s, cx, cy, p) {
  const balls = s.balls;
  const group = [];
  for (let i = 0; i < balls.length; i++) {
    if (balls[i].mode === 'chargeR') group.push(balls[i]);
  }

  for (let i = 0; i < group.length; i++) {
    const b = group[i];
    const a = b.orbitA;
    const tx = -Math.sin(a);
    const ty = Math.cos(a);
    const speed = b.orbitW * b.orbitR * (1.4 + 1.8 * p);

    b.vx = tx * speed;
    b.vy = ty * speed;
    b.gravity = 0;
    b.mode = 'freeR';
    b.angularVelocity = b.angularVelocity * (1 + p * 0.8) + rand(-3, 3);
    b.life = 2.4;
    b.maxLife = 2.4;
    b.r0 = b.r;
    b.alpha = 1;
    b.squashAngle = Math.atan2(ty, tx);
    b.squashX = 1.35;
    b.squashY = 0.76;
    b.sqVX = 0; b.sqVY = 0;
  }

  const arms = 2 + Math.floor(p * 2.99);
  const maxR = 150 + 450 * p;
  const perArm = 14;
  for (let arm = 0; arm < arms; arm++) {
    const a0 = (arm / arms) * TAU;
    for (let i = 0; i < perArm; i++) {
      const t = (i + 1) / perArm;
      const rad = 15 + t * maxR * 0.35;
      const ang = a0 + t * 2.2;
      const sp = 400 + 900 * p;
      spawnBall(s, {
        x: cx + Math.cos(ang) * rad,
        y: cy + Math.sin(ang) * rad,
        vx: Math.cos(ang) * sp - Math.sin(ang) * sp * 0.6,
        vy: Math.sin(ang) * sp + Math.cos(ang) * sp * 0.6,
        r: rand(2, 4),
        color1: pick(CONFIG.GLASS),
        gravity: 0,
        angularVelocity: rand(-22, 22),
        life: 0.6, maxLife: 0.6,
        mode: 'freeR'
      });
    }
  }

  const burstN = randInt(8, 16);
  for (let i = 0; i < burstN; i++) {
    const a = (i / burstN) * TAU;
    const sp = 260 + 500 * p;
    spawnBall(s, {
      x: cx, y: cy,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      r: rand(3, 6),
      color1: pick(CONFIG.GLASS),
      gravity: 0,
      angularVelocity: rand(-20, 20),
      life: 1.2, maxLife: 1.2,
      mode: 'freeR'
    });
  }
}

/* =========================================================================
   球体更新
   ========================================================================= */
function updateBalls(s, dt) {
  const balls = s.balls;
  for (let i = balls.length - 1; i >= 0; i--) {
    const b = balls[i];

    // ---- 寿命 ----
    if (b.maxLife !== Infinity) {
      b.life -= dt;
      if (b.life <= 0) { killBall(s, i); continue; }
      const frac = b.life / b.maxLife;
      if (frac < 0.4) {
        const sc = frac / 0.4;
        b.alpha = sc;
        b.r = b.r0 * (0.22 + 0.78 * sc);
        b.m = b.r * b.r * b.r * 0.01;
        if (b.mode === 'free') b.angularVelocity *= Math.pow(0.25, dt);
      }
    }

    // ---- 旋转 ----
    b.rotation += b.angularVelocity * dt;

    // ---- 弹性形变弹簧恢复 ----
    if (b.mode !== 'chargeL' && b.mode !== 'chargeR') {
      b.sqVX += (1 - b.squashX) * CONFIG.SQ_K * dt;
      b.sqVX *= Math.exp(-CONFIG.SQ_D * dt);
      b.squashX += b.sqVX * dt;
      b.sqVY += (1 - b.squashY) * CONFIG.SQ_K * dt;
      b.sqVY *= Math.exp(-CONFIG.SQ_D * dt);
      b.squashY += b.sqVY * dt;
      if (b.squashX < 0.5) b.squashX = 0.5;
      if (b.squashY < 0.5) b.squashY = 0.5;
    }

    // 蓄力球位置由 updateCharge 驱动
    if (b.mode === 'chargeR') continue;

    // ---- 马格努斯效应（右键飞行球） ----
    if (b.mode === 'freeR') {
      const w = b.angularVelocity;
      if (Math.abs(w) > 0.05) {
        b.vx += CONFIG.MAGNUS * w * (-b.vy) * dt;
        b.vy += CONFIG.MAGNUS * w * (b.vx) * dt;
      }
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > 1) {
        const dec = Math.min(100 * dt, sp);
        b.vx -= b.vx / sp * dec;
        b.vy -= b.vy / sp * dec;
      }
    }

    // ---- 重力 ----
    if (b.gravity) b.vy += b.gravity * dt;

    // ---- 积分 ----
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    // ---- 母球轨迹 ----
    if (b.mother) {
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > 10) {
        addEffect(s, {
          type: 'line',
          x: b.x, y: b.y,
          x2: b.x - b.vx * 0.03,
          y2: b.y - b.vy * 0.03,
          life: 0.4, maxLife: 0.4
        });
      }
    }

    // ---- 屏幕外剔除 ----
    if (b.x < -400 || b.x > s.W + 400 || b.y > s.H + 300 || b.y < -800) {
      killBall(s, i);
      continue;
    }
  }
}

/* =========================================================================
   蓄力可视化（无进度条 / 圆环 / 百分比 / 文字）
   ========================================================================= */
function drawChargeVisuals(ctx, s) {
  const charge = s.charge;
  if (!charge.active) return;
  const p = Math.min(charge.t / CONFIG.CHARGE_MAX, 1);
  const cx = charge.x + charge.jx;
  const cy = charge.y + charge.jy;

  if (charge.button === 0) {
    const coreR = CONFIG.L_CORE_R_MIN +
      (CONFIG.L_CORE_R_MAX - CONFIG.L_CORE_R_MIN) * p;
    const pulseFreq = 6 + 26 * p;
    const pulse = 1 + 0.1 * Math.sin(charge.t * pulseFreq);
    const R = coreR * pulse;

    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 2.6);
    g.addColorStop(0.0, 'rgba(255,255,255,' + (0.55 + 0.45 * p) + ')');
    g.addColorStop(0.35, 'rgba(255,244,224,' + (0.30 + 0.35 * p) + ')');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 2.6, 0, TAU);
    ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,' + (0.5 + 0.5 * p) + ')';
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.7, 0, TAU);
    ctx.fill();

    if (charge.cracks.length) {
      const r0 = 10 + 14 * p;
      ctx.lineWidth = 1;
      for (let i = 0; i < charge.cracks.length; i++) {
        const c = charge.cracks[i];
        const a = c.life / c.maxLife;
        ctx.strokeStyle = 'rgba(255,255,255,' + (0.5 * a) + ')';
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(c.a) * r0, cy + Math.sin(c.a) * r0);
        ctx.lineTo(cx + Math.cos(c.a) * (r0 + c.len),
                   cy + Math.sin(c.a) * (r0 + c.len));
        ctx.stroke();
      }
    }
  } else {
    const size = 8 + 12 * p;
    const rot = charge.t * (8 + 34 * p);
    ctx.lineWidth = 1;
    for (let i = 0; i < 2; i++) {
      const sgn = i === 0 ? 1 : -1;
      ctx.beginPath();
      const steps = 22;
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const ang = sgn * (t * TAU * 1.4) + rot;
        const rad = size * 0.5 * (0.25 + 0.75 * t);
        const px = cx + Math.cos(ang) * rad;
        const py = cy + Math.sin(ang) * rad;
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.35 + 0.5 * p) + ')';
      ctx.stroke();
    }
    const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 1.6);
    cg.addColorStop(0, 'rgba(255,255,255,' + (0.35 + 0.5 * p) + ')');
    cg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.arc(cx, cy, size * 1.6, 0, TAU);
    ctx.fill();
  }
}

export class CursorBall extends CursorEffectElement {
  // 原型用的是 mousemove / mousedown / mouseup（不是 pointer 事件族），
  // 不声明这一行，基类会去监听 pointermove，动效将完全收不到鼠标输入。
  inputFamily = 'mouse';

  /* =========================================================================
     初始化
     ========================================================================= */
  // 只建池与状态，不注册任何监听（监听、DPR 缩放、rAF 全归基类）
  setup({ canvas, ctx, width, height, input }) {
    // 与原型一致：初始光标位置取视口中心。
    // 基类的 input 从 (0, 0) 起算，若不在这里对齐，首帧的位移会按「从左上角跳过来」计算，
    // 速度与拖尾生成量会和原型不同。
    input.x = input.lx = width * 0.5;
    input.y = input.ly = height * 0.5;

    return {
      // 本实例的画布上下文（已按 DPR 缩放过，统一使用 CSS 像素坐标）
      ctx,

      // 画布尺寸（CSS 像素），由基类 onResize 同步
      W: width,
      H: height,

      input,

      // 原型口径的鼠标速度：原始逐帧位移 / dt，不平滑、无钳制、无上限。
      // 基类的 input.vx / vy 是平滑值（且带 >300px 归零、6000 封顶），
      // 而原型用的是未平滑的 mouse.vx / mouse.vy，二者差别可观（影响拖尾球初速与母球方向），
      // 为与原型逐帧对齐，这里另存一份原始速度。
      rawVx: 0,
      rawVy: 0,

      // 离屏贴图的创建者：用元素自身的 ownerDocument，不碰全局对象，也绝不挂进 DOM
      doc: canvas.ownerDocument,

      // 颜色解析缓存与球体贴图缓存（原型是模块级 Map，这里每实例一份）
      rgbCache: new Map(),
      texCache: new Map(),

      // 球对象池与在场球列表
      pool: [],
      balls: [],
      idCounter: 0,

      // 空间网格（Spatial Hash）
      grid: new Map(),

      // 特效列表
      effects: [],

      // 单帧火花预算（原型的模块级 sparkBudget）
      sparkBudget: 0,

      // 蓄力状态
      charge: {
        active: false,
        button: -1,
        t: 0,
        x: 0, y: 0,
        jx: 0, jy: 0,
        spawnAcc: 0,
        splashTimer: 0,
        cracks: []
      }
    };
  }

  /* =========================================================================
     输入（按键）—— 鼠标位移由基类写入 this.input，原始速度在 update() 里算好存入 state，
     这里只处理左右键交互
     ========================================================================= */
  onPointerDown(e) {
    const s = this.state;
    if (!s) return;

    // 与原型一致：以 mousedown 的事件坐标作为爆发 / 蓄力原点
    if (e.button === 0) {
      clickBurst(s, e.clientX, e.clientY);
      startCharge(s, 0, e.clientX, e.clientY);
    } else if (e.button === 2) {
      // 原型的右键 preventDefault 与 contextmenu 拦截由基类统一处理
      startCharge(s, 2, e.clientX, e.clientY);
    }
  }

  onPointerUp(e) {
    const s = this.state;
    if (!s) return;
    if (!s.charge.active) return;
    if (e.button === s.charge.button) {
      releaseCharge(s);
    }
  }

  // 失焦时按键状态已丢失：原型 window blur 的行为
  onBlur() {
    const s = this.state;
    if (s && s.charge.active) cancelCharge(s);
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
     更新
     ========================================================================= */
  update(dt, s) {
    if (!s) return;
    const inp = s.input;

    // —— 鼠标位移 / 速度 ——
    // 基类的 input.vx / vy 带平滑与「>300px 归零、6000 封顶」保护，与原型不符；
    // 原型用的是未平滑的 mouse.vx / mouse.vy，且对跳变不做任何处理，这里照原型复算。
    const mdx = inp.x - inp.lx;
    const mdy = inp.y - inp.ly;
    const mdist = Math.hypot(mdx, mdy);

    s.rawVx = dt > 0 ? mdx / dt : 0;
    s.rawVy = dt > 0 ? mdy / dt : 0;

    // —— 拖尾生成 ——
    if (mdist > 2) {
      const count = clamp(Math.floor(mdist / CONFIG.TRAIL_PER_PX), 1,
        CONFIG.TRAIL_MAX_PER_FRAME);
      for (let i = 0; i < count; i++) {
        const t = count === 1 ? 1 : (i + 1) / count;
        const x = inp.lx + mdx * t;
        const y = inp.ly + mdy * t;
        spawnTrail(s, x, y, s.rawVx, s.rawVy);
      }
    }

    // —— 蓄力 ——
    updateCharge(s, dt);

    // —— 球体 ——
    updateBalls(s, dt);

    // —— 碰撞 ——
    handleCollisions(s);

    // —— 特效 ——
    updateEffects(s, dt);
  }

  /* =========================================================================
     渲染
     ========================================================================= */
  render(s) {
    if (!s) return;
    const ctx = s.ctx;

    // 清屏：原型在这里先 setTransform 再铺一层 #090b10 底色（它是整页背景动效，
    // 靠不透明画布承载底色）。移植成光标层后必须透明，只清除上一帧内容，
    // 绝不覆盖宿主页面；setTransform 由基类 _measure() 负责。
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, s.W, s.H);

    for (let i = 0; i < s.balls.length; i++) drawBall(ctx, s, s.balls[i]);
    drawEffects(ctx, s);
    drawChargeVisuals(ctx, s);
  }
}

if (!customElements.get('cursor-ball')) {
  customElements.define('cursor-ball', CursorBall);
}

export default CursorBall;
