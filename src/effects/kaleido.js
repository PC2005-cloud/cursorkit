/**
 * cursor-kaleido —— 鼠标光标万花筒动效（左键径向对称 / 右键平行镜面隧道）。
 *
 * 由 html/万花筒.html 原型移植：算法流程、数值、视觉表现与原文件一一对应。
 * 作为光标层组件，原型页面自身的行为已剔除：
 *   - 原型的深色底 #04060c 写在 CSS 的 html,body 上，不是画布填充；render() 本来
 *     就以 clearRect 起手（原型第 1419 行），绘制中没有任何「整屏铺底」，
 *     万花筒图案、光晕、离屏贴图等有明确形状的填充全部保留，绝不覆盖宿主页面；
 *   - 不拦截 contextmenu（原型第 1243 行 preventDefault），统一交给基类处理；
 *   - 画布创建、DPR 适配（封顶 2）、setTransform、尺寸同步、监听注册、rAF 循环、
 *     原型的 window resize 监听与 canvas 尺寸逻辑全部由基类负责；
 *   - 速度：原型全程不使用速度——既没有 vx / vy，也没有任何「位移 / dt」，
 *     只用到「位移方向」（阈值 1.5px）与「位移距离」（拖尾按 7px 累积生成）。
 *     因此基类平滑后的 input.vx / vy / speed 一律不参与计算，也不需要另算原始速度。
 *   - 锚点：原型在 mousemove 回调里推进锚点，属于事件级口径（见 _updateDir / _emitTrail
 *     上方注释与依据行号），因此位移统一取 input.lx / ly（最后一段位移起点）。
 *
 * 原型监听 mousemove / mousedown / mouseup，因此声明 inputFamily = 'mouse'。
 * 所有运行状态都放在 setup() 返回的 state 上，多实例互不干扰。
 */

import { CursorEffectElement } from '../core/base.js';
import { TAU, clamp, lerp, rand, randInt } from '../core/utils.js';

// =====================================================================
// CONFIG —— 全局参数集中配置
// =====================================================================
const CONFIG = {
  MAX_SHAPES: 900,
  MAX_EFFECTS: 500,
  MAX_DRAWS: 6000,
  TEX_SIZE_TIERS: [8, 16, 32, 64, 128],

  RADIAL: {
    SECTOR_START: 4,
    SECTOR_MAX: 16,
    SECTOR_STEP: 2,
    SECTOR_INTERVAL: 0.35,
    SECTOR_LERP: 9,
    HOLD_MAX: 2.5,
    PATTERN_RADIUS: 140,
    AXIS_ALPHA: 0.15,
    AXIS_LINE_W: 1,
    CORE_SIZE_MIN: 15,
    CORE_SIZE_GROW: 10,
    PULSE_FREQ: 0.8,
    PULSE_AMP: 0.05,
    JITTER_FREQ: 2,
    JITTER_POS: 1.0,
    SHAKE_POWER: 0.55,
    SHAKE_AMP: 3,
    SPAWN_INTERVAL: 0.3,
    REARRANGE_ANGLE: Math.PI / 4,
    REARRANGE_TIME: 0.15
  },

  TUNNEL: {
    DIST_START: 80,
    DIST_MIN: 30,
    DIST_LERP: 5,
    LAYERS: 3,
    LAYER_SCALE: 0.85,
    LAYER_ALPHA: 0.65,
    HOLD_MAX: 2.5,
    MIRROR_LINE_LEN: 400,
    MIRROR_ALPHA: 0.2,
    PULSE_FREQ: 0.7,
    PULSE_AMP: 0.1,
    LIGHT_RADIUS: 15,
    LIGHT_ALPHA: 0.6,
    LIGHT_START: 1.0,
    ECHO_START: 1.5,
    SPAWN_INTERVAL: 0.12,
    SPAWN_SPEED_MIN: 100,
    SPAWN_SPEED_MAX: 300,
    COLLAPSE_TIME: 0.15,
    BEAM_COUNT: 30,
    BEAM_COUNT_POWER: 100,
    BEAM_SPEED: 400,
    BEAM_SPEED_POWER: 1200
  },

  TRAIL: {
    STEP: 7,
    SIZE_MIN: 4,
    SIZE_MAX: 12,
    SPEED_MIN: 50,
    SPEED_MAX: 150,
    SPIN_MIN: 1,
    SPIN_MAX: 3,
    LIFE_MIN: 0.8,
    LIFE_MAX: 1.5,
    DRAG: 1.4,
    COPY_DELAY_MIN: 0.003,
    COPY_DELAY_MAX: 0.008
  },

  CLICK: {
    CORE_SIZE_MIN: 10,
    CORE_SIZE_MAX: 16,
    BURST_MIN: 8,
    BURST_MAX: 14,
    BURST_SIZE_MIN: 4,
    BURST_SIZE_MAX: 8,
    BURST_SPEED_MIN: 150,
    BURST_SPEED_MAX: 400,
    RING_MIN: 12,
    RING_MAX: 18,
    RING_RADIUS: 46,
    PULSE_RADIUS: 20,
    PULSE_LIFE: 0.15,
    RADIATE_MIN: 6,
    RADIATE_MAX: 10,
    RADIATE_LIFE: 0.25,
    GHOST_LIFE: 0.3
  },

  PALETTE: [
    '#FF3D5A', '#FF8C1A', '#FFD23F', '#3DD68C', '#3DDBF0',
    '#3D7BFF', '#8A5CFF', '#FF5CD8', '#FFFFFF',
    '#4FE3FF', '#2B7BFF', '#FF4FD8'
  ],
  RADIAL_COLOR_COUNT: 9,
  COLOR_WHITE: 8,
  COLOR_ICE: 9,
  COLOR_ELEC: 10,
  COLOR_MAGENTA: 11,

  SHAPE_TYPES: 5
};

// 原型 CONFIG.TUNNEL.ECHO_START 全文未被引用（死配置），按「CONFIG 数值原样保留」保留

// 贴图矩阵维度（与原型一致，由 CONFIG 推导）
const TEX_COLORS = CONFIG.PALETTE.length;
const TEX_SIZES = CONFIG.TEX_SIZE_TIERS.length;

// 原型用固定种子的 mulberry32 生成图形贴图，保证每次运行的贴图完全一致
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// =====================================================================
// 离屏纹理预渲染
// 300 张贴图（5 形状 × 12 颜色 × 5 尺寸）在 setup() 里一次性烘焙，
// 与原型第 1462 行「启动时调用一次 buildTextures()」一致，不在每帧创建。
// 这里的 createElement / width / height / getContext 只作用于离屏贴图画布，
// 与基类的主画布无关，且绝不 appendChild。
// =====================================================================
function paintShape(g, type, R, color, seed) {
  const rnd = mulberry32(seed);
  g.clearRect(0, 0, R * 2, R * 2);
  g.save();
  g.translate(R, R);
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.strokeStyle = color;
  g.fillStyle = color;

  if (type === 0) {
    const pts = [];
    for (let i = 0; i < 3; i++) {
      const ang = -Math.PI / 2 + i * TAU / 3 + (rnd() - 0.5) * 0.7;
      const rr = R * (0.62 + rnd() * 0.3);
      pts.push([Math.cos(ang) * rr, Math.sin(ang) * rr]);
    }
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i <= 3; i++) {
      const p = pts[i % 3], q = pts[(i - 1) % 3];
      const mx = (p[0] + q[0]) * 0.5, my = (p[1] + q[1]) * 0.5;
      g.quadraticCurveTo(q[0], q[1], mx, my);
    }
    g.closePath();
    g.globalAlpha = 0.30;
    g.fill();
    g.globalAlpha = 0.95;
    g.lineWidth = Math.max(1, R * 0.1);
    g.stroke();
    g.globalAlpha = 1;
    g.fillStyle = '#ffffff';
    for (let i = 0; i < 3; i++) {
      g.beginPath();
      g.arc(pts[i][0], pts[i][1], Math.max(0.7, R * 0.08), 0, TAU);
      g.fill();
    }
  } else if (type === 1) {
    const ratio = 2 + rnd() * 2;
    const half = R * 0.9;
    const w = half / ratio;
    g.beginPath();
    g.moveTo(0, -half);
    g.lineTo(w, 0);
    g.lineTo(0, half);
    g.lineTo(-w, 0);
    g.closePath();
    g.globalAlpha = 0.30;
    g.fill();
    g.globalAlpha = 0.95;
    g.lineWidth = Math.max(1, R * 0.09);
    g.stroke();
  } else if (type === 2) {
    const rings = 1 + Math.floor(rnd() * 3);
    g.globalAlpha = 0.92;
    for (let i = 0; i < rings; i++) {
      const rr = R * (0.86 - i * 0.3);
      if (rr < R * 0.16) break;
      g.lineWidth = Math.max(0.8, R * (0.05 + rnd() * 0.05));
      g.beginPath();
      g.arc(0, 0, rr, 0, TAU);
      g.stroke();
    }
  } else if (type === 3) {
    const n = 4 + Math.floor(rnd() * 5);
    const outer = R * 0.9;
    const inner = outer * (0.34 + rnd() * 0.16);
    g.beginPath();
    for (let i = 0; i < n * 2; i++) {
      const ang = -Math.PI / 2 + i * Math.PI / n;
      const rr = (i & 1) ? inner : outer;
      const x = Math.cos(ang) * rr, y = Math.sin(ang) * rr;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
    g.globalAlpha = 0.30;
    g.fill();
    g.globalAlpha = 0.95;
    g.lineWidth = Math.max(1, R * 0.08);
    g.stroke();
    g.globalAlpha = 1;
    g.fillStyle = '#ffffff';
    for (let i = 0; i < n; i++) {
      const ang = -Math.PI / 2 + i * TAU / n;
      g.beginPath();
      g.arc(Math.cos(ang) * outer, Math.sin(ang) * outer, Math.max(0.7, R * 0.07), 0, TAU);
      g.fill();
    }
  } else {
    const w = R * (0.5 + rnd() * 0.16);
    g.beginPath();
    g.moveTo(0, R * 0.92);
    g.bezierCurveTo(w, R * 0.55, w * 1.2, -R * 0.5, 0, -R * 0.92);
    g.bezierCurveTo(-w * 1.2, -R * 0.5, -w, R * 0.55, 0, R * 0.92);
    g.closePath();
    g.globalAlpha = 0.32;
    g.fill();
    g.globalAlpha = 0.9;
    g.lineWidth = Math.max(1, R * 0.09);
    g.stroke();
  }
  g.restore();
}

function buildTextures(doc) {
  const tex = new Array(CONFIG.SHAPE_TYPES * TEX_COLORS * TEX_SIZES);
  for (let t = 0; t < CONFIG.SHAPE_TYPES; t++) {
    for (let c = 0; c < TEX_COLORS; c++) {
      for (let si = 0; si < TEX_SIZES; si++) {
        const size = CONFIG.TEX_SIZE_TIERS[si];
        const cv = doc.createElement('canvas');
        cv.width = size;
        cv.height = size;
        const g = cv.getContext('2d');
        paintShape(g, t, size * 0.5, CONFIG.PALETTE[c], t * 977 + c * 131 + si * 17 + 7);
        tex[(t * TEX_COLORS + c) * TEX_SIZES + si] = cv;
      }
    }
  }
  return tex;
}

function texIndexForSize(size) {
  if (size <= 10) return 0;
  if (size <= 20) return 1;
  if (size <= 44) return 2;
  if (size <= 88) return 3;
  return 4;
}

function drawTex(ctx, s, type, colorIdx, size) {
  if (size <= 0.4) return;
  const si = texIndexForSize(size);
  const cv = s.tex[(type * TEX_COLORS + colorIdx) * TEX_SIZES + si];
  const h = size * 0.5;
  ctx.drawImage(cv, -h, -h, size, size);
}

// =====================================================================
// 图形对象池
// 原型每次 spawn 都新建字面量对象（不是复用池），因此不存在「池字段未重置」问题
// =====================================================================
function spawnShape(s, o) {
  if (s.shapes.length >= CONFIG.MAX_SHAPES) return null;
  const sh = {
    x: o.x, y: o.y,
    vx: o.vx || 0, vy: o.vy || 0,
    rot: o.rot || 0, vrot: o.vrot || 0,
    size: o.size,
    type: o.type,
    colorIdx: o.colorIdx,
    life: o.life, maxLife: o.life,
    age: 0,
    drag: o.drag === undefined ? CONFIG.TRAIL.DRAG : o.drag,
    mode: o.mode || 'radial',
    copyDelay: o.copyDelay === undefined
      ? rand(CONFIG.TRAIL.COPY_DELAY_MIN, CONFIG.TRAIL.COPY_DELAY_MAX)
      : o.copyDelay,
    nx: o.nx === undefined ? 1 : o.nx,
    ny: o.ny === undefined ? 0 : o.ny,
    decon: 0,
    deconOn: !!o.deconOn,
    cooling: !!o.cooling,
    cool: 0
  };
  s.shapes.push(sh);
  return sh;
}

// =====================================================================
// 特效池
// =====================================================================
function addEffect(s, e) {
  if (s.effects.length >= CONFIG.MAX_EFFECTS) s.effects.shift();
  s.effects.push(e);
}

function updateEffects(s, dt) {
  for (let i = s.effects.length - 1; i >= 0; i--) {
    const e = s.effects[i];
    e.age += dt;
    if (e.age >= e.life) {
      s.effects.splice(i, 1);
    }
  }
}

function renderEffects(ctx, s) {
  for (let i = 0; i < s.effects.length; i++) {
    const e = s.effects[i];
    const k = 1 - e.age / e.life;
    if (k <= 0) continue;
    if (e.kind === 'pulse') {
      const r = e.radius * (0.4 + 0.6 * (1 - k));
      const grad = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, r);
      grad.addColorStop(0, 'rgba(255,255,255,' + (0.55 * k).toFixed(3) + ')');
      grad.addColorStop(0.5, 'rgba(180,230,255,' + (0.25 * k).toFixed(3) + ')');
      grad.addColorStop(1, 'rgba(120,200,255,0)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(e.x, e.y, r, 0, TAU);
      ctx.fill();
    } else if (e.kind === 'line') {
      ctx.globalAlpha = k * e.alpha;
      ctx.strokeStyle = e.color;
      ctx.lineWidth = e.width;
      ctx.beginPath();
      ctx.moveTo(e.x1, e.y1);
      ctx.lineTo(e.x2, e.y2);
      ctx.stroke();
    } else if (e.kind === 'ring') {
      // 圆环冲击波：从 startRadius 过渡到 endRadius，同时淡出
      const r = lerp(e.startRadius, e.endRadius, 1 - k);
      ctx.globalAlpha = clamp(k * e.alpha, 0, 1);
      ctx.strokeStyle = e.color;
      ctx.lineWidth = Math.max(0.4, e.width * k);
      ctx.beginPath();
      ctx.arc(e.x, e.y, r, 0, TAU);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

// =====================================================================
// 径向对称复制
// =====================================================================
function drawRadialCopiesAt(ctx, s, x, y, type, size, rot, alpha, copyDelay, age, whiteMix) {
  const M = s.input;
  const cx = M.x;
  const cy = M.y;
  const N = Math.max(2, Math.round(s.sectorDisplay));
  const dx = x - cx, dy = y - cy;

  for (let k = 0; k < N; k++) {
    if (s.drawBudget <= 0) return;
    const a2 = age - k * copyDelay;
    if (a2 < 0) continue;
    const vis = Math.min(1, a2 / 0.04);

    const th = k * TAU / N + s.axisOffset;
    const c = Math.cos(th), sn = Math.sin(th);
    const px = cx + dx * c - dy * sn;
    const py = cy + dx * sn + dy * c;

    let ci = Math.floor(k * CONFIG.RADIAL_COLOR_COUNT / N) % CONFIG.RADIAL_COLOR_COUNT;
    if (whiteMix > 0.5) ci = CONFIG.COLOR_WHITE;

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(rot + th);
    if (k & 1) ctx.scale(-1, 1);
    ctx.globalAlpha = clamp(alpha * vis, 0, 1);
    drawTex(ctx, s, type, ci, size);
    ctx.restore();
    s.drawBudget--;
  }
}

// =====================================================================
// 平行镜面反射复制
// =====================================================================
function drawTunnelCopiesAt(ctx, s, x, y, type, size, rot, alpha, age, colorIdx, nx, ny) {
  const ang = Math.atan2(ny, nx);
  const D = s.tunnelDist;
  const L = CONFIG.TUNNEL.LAYERS;

  for (let i = -L; i <= L; i++) {
    if (s.drawBudget <= 0) return;
    const ai = Math.abs(i);
    const a2 = age - ai * 0.01;
    if (a2 < 0) continue;
    const vis = Math.min(1, a2 / 0.03);

    const off = i * D * 2;
    const px = x + nx * off;
    const py = y + ny * off;

    const sc = Math.pow(CONFIG.TUNNEL.LAYER_SCALE, ai);
    const al = Math.pow(CONFIG.TUNNEL.LAYER_ALPHA, ai) * alpha * vis;
    if (al < 0.008) continue;

    let ci = colorIdx;
    if (ai === 1) ci = CONFIG.COLOR_ICE;
    else if (ai === 2) ci = CONFIG.COLOR_ELEC;
    else if (ai >= 3) ci = CONFIG.COLOR_MAGENTA;

    ctx.save();
    ctx.translate(px, py);
    if (i & 1) {
      ctx.rotate(ang);
      ctx.scale(-1, 1);
      ctx.rotate(-ang);
    }
    ctx.rotate(rot);
    ctx.globalAlpha = clamp(al, 0, 1);
    drawTex(ctx, s, type, ci, size * sc);
    ctx.restore();
    s.drawBudget--;
  }
}

// =====================================================================
// 图形绘制
// =====================================================================
function drawShapeObject(ctx, s, sh) {
  const baseAlpha = clamp(sh.life / sh.maxLife, 0, 1);
  if (baseAlpha <= 0.01) return;

  let type = sh.type;
  let size = sh.size;
  let whiteMix = 0;

  if (sh.decon > 0) {
    size = sh.size * (1 - 0.55 * sh.decon);
    if (sh.decon > 0.5) {
      type = (sh.type % 2 === 0) ? 0 : 1;
      whiteMix = 1;
    } else {
      whiteMix = sh.decon * 2;
    }
  }

  let colorIdx = sh.colorIdx;
  if (sh.cooling) {
    if (sh.cool > 0.55) colorIdx = CONFIG.COLOR_ELEC;
    else if (sh.cool > 0.22) colorIdx = CONFIG.COLOR_ICE;
    else colorIdx = CONFIG.COLOR_WHITE;
  } else if (whiteMix > 0.5) {
    colorIdx = CONFIG.COLOR_WHITE;
  }

  if (sh.mode === 'radial') {
    drawRadialCopiesAt(ctx, s, sh.x, sh.y, type, size, sh.rot, baseAlpha, sh.copyDelay, sh.age, whiteMix);
  } else if (sh.mode === 'tunnel') {
    drawTunnelCopiesAt(ctx, s, sh.x, sh.y, type, size, sh.rot, baseAlpha, sh.age, colorIdx, sh.nx, sh.ny);
  } else {
    if (s.drawBudget <= 0) return;
    ctx.save();
    ctx.translate(sh.x, sh.y);
    ctx.rotate(sh.rot);
    ctx.globalAlpha = baseAlpha;
    drawTex(ctx, s, type, colorIdx, size);
    ctx.restore();
    s.drawBudget--;
  }
}

// =====================================================================
// 径向蓄力图案
// =====================================================================
const RING_SPECS = [
  { count: 8, baseR: 30, size: 10, speed: 1.0 },
  { count: 12, baseR: 60, size: 8, speed: 1.5 },
  { count: 16, baseR: 95, size: 6.5, speed: 2.0 }
];

function computePatternElements(s, t, now) {
  const p = clamp(t / CONFIG.RADIAL.HOLD_MAX, 0, 1);
  const pulse = 1 + CONFIG.RADIAL.PULSE_AMP * Math.sin(now * CONFIG.RADIAL.PULSE_FREQ * TAU);
  const cx = s.input.x + s.shakeX;
  const cy = s.input.y + s.shakeY;
  const els = [];

  els.push({
    x: cx, y: cy,
    type: s.coreType,
    size: (CONFIG.RADIAL.CORE_SIZE_MIN + CONFIG.RADIAL.CORE_SIZE_GROW * p) * pulse,
    rot: s.coreRot + now * 0.5,
    alpha: 1
  });

  for (let ri = 0; ri < RING_SPECS.length; ri++) {
    const appear = clamp((p - ri * 0.28) / 0.2, 0, 1);
    if (appear <= 0) continue;
    const spec = RING_SPECS[ri];
    const radius = spec.baseR * (1 + 0.5 * p) * pulse;
    const spin = now * spec.speed * 0.4;

    for (let j = 0; j < spec.count; j++) {
      const ang = j * TAU / spec.count + spin + ri * 0.5;
      const jx = Math.sin(now * CONFIG.RADIAL.JITTER_FREQ * TAU + j * 1.7 + ri * 2.1) * CONFIG.RADIAL.JITTER_POS;
      const jy = Math.cos(now * CONFIG.RADIAL.JITTER_FREQ * TAU + j * 2.3 + ri * 1.3) * CONFIG.RADIAL.JITTER_POS;
      els.push({
        x: cx + Math.cos(ang) * radius + jx,
        y: cy + Math.sin(ang) * radius + jy,
        type: (j + ri * 2) % CONFIG.SHAPE_TYPES,
        size: spec.size * (0.85 + 0.3 * ((j * 7 + ri * 13) % 10) / 10),
        rot: now * spec.speed + j * 0.4,
        alpha: appear
      });
    }
  }
  return els;
}

function renderRadialPattern(ctx, s, now) {
  const els = computePatternElements(s, s.leftT, now);
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    drawRadialCopiesAt(ctx, s, el.x, el.y, el.type, el.size, el.rot, el.alpha, 0.004, s.leftT, 0);
  }
}

// =====================================================================
// 镜像轴可视化
// =====================================================================
function renderRadialAxes(ctx, s, now) {
  const N = Math.max(2, Math.round(s.sectorDisplay));
  const p = clamp(s.leftT / CONFIG.RADIAL.HOLD_MAX, 0, 1);
  const R = CONFIG.RADIAL.PATTERN_RADIUS * (0.3 + 0.7 * p) * 1.2;
  const cx = s.input.x + s.shakeX;
  const cy = s.input.y + s.shakeY;

  ctx.save();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = CONFIG.RADIAL.AXIS_LINE_W;
  for (let k = 0; k < N; k++) {
    const grow = clamp((s.leftT - k * 0.05) * 4, 0, 1);
    if (grow <= 0.001) continue;
    const a = k * TAU / N + s.axisOffset;
    ctx.globalAlpha = CONFIG.RADIAL.AXIS_ALPHA * grow * (0.5 + 0.5 * p);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * R * grow, cy + Math.sin(a) * R * grow);
    ctx.stroke();
  }
  ctx.restore();
}

// =====================================================================
// 镜面可视化（增强版）——平行镜面 + 动态光线 + 万花筒花环 + 中心光源
// =====================================================================
function renderTunnelMirrors(ctx, s, now) {
  const p = clamp(s.rightT / CONFIG.TUNNEL.HOLD_MAX, 0, 1);
  const cx = s.input.x + s.shakeX;
  const cy = s.input.y + s.shakeY;
  const nx = s.tunnelNX, ny = s.tunnelNY;
  const sx = -ny, sy = nx;
  const D = s.tunnelDist;
  const burstPhase = s.tunnelBurst
    ? clamp(s.tunnelBurst.t / 0.1, 0, 1)
    : 0;
  const fade = 1 - burstPhase;
  const len = CONFIG.TUNNEL.MIRROR_LINE_LEN * fade;

  ctx.save();

  // ---- 镜面线 ----
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  ctx.globalAlpha = CONFIG.TUNNEL.MIRROR_ALPHA * (0.4 + 0.6 * p) * fade;
  for (let k = -1; k <= 1; k += 2) {
    const ox = cx + nx * k * D * 0.5;
    const oy = cy + ny * k * D * 0.5;
    ctx.beginPath();
    ctx.moveTo(ox - sx * len * 0.5, oy - sy * len * 0.5);
    ctx.lineTo(ox + sx * len * 0.5, oy + sy * len * 0.5);
    ctx.stroke();
  }

  // ---- 沿法线方向的动态光线（强化隧道纵深）----
  if (p > 0.12 && fade > 0) {
    ctx.globalAlpha = 0.14 * p * fade;
    ctx.strokeStyle = '#4FE3FF';
    ctx.lineWidth = 0.8;
    const rayCount = 6 + Math.floor(p * 10);
    for (let i = 0; i < rayCount; i++) {
      const t = (i / Math.max(1, rayCount - 1)) * 2 - 1;
      const ox = cx + sx * t * 130;
      const oy = cy + sy * t * 130;
      const rl = 80 + 320 * p;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(ox + nx * rl, oy + ny * rl);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(ox - nx * rl, oy - ny * rl);
      ctx.stroke();
    }
  }

  // ---- 万花筒花环：围绕光标的旋转点阵 + 沿法线的对称椭圆环 ----
  if (p > 0.2 && fade > 0) {
    const flowerP = clamp((p - 0.2) / 0.8, 0, 1);

    // 围绕光标的旋转对称点阵
    ctx.globalAlpha = flowerP * 0.5 * fade;
    ctx.strokeStyle = '#4FE3FF';
    ctx.lineWidth = 1;
    const ptN = 6 + Math.floor(flowerP * 10);
    const ptR = 35 + 90 * flowerP;
    for (let i = 0; i < ptN; i++) {
      const a = i * TAU / ptN + now * 0.35;
      const px = cx + Math.cos(a) * ptR;
      const py = cy + Math.sin(a) * ptR;
      ctx.beginPath();
      ctx.arc(px, py, 2 + 2.5 * flowerP, 0, TAU);
      ctx.stroke();
    }

    // 沿法线方向的镜像椭圆环（呼应镜像复制）
    ctx.globalAlpha = flowerP * 0.3 * fade;
    ctx.strokeStyle = '#2B7BFF';
    for (let i = -3; i <= 3; i++) {
      if (i === 0) continue;
      const sign = Math.sign(i);
      const dist = Math.abs(i) * D * 0.9;
      const wx = cx + nx * sign * dist;
      const wy = cy + ny * sign * dist;
      const rr = 18 + 6 * Math.abs(i) + 4 * flowerP;
      ctx.save();
      ctx.translate(wx, wy);
      ctx.rotate(Math.atan2(ny, nx));
      ctx.beginPath();
      ctx.ellipse(0, 0, rr, rr * 0.35, 0, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    // 垂直镜面方向的对称"翅膀"点阵（增强线性对称）
    ctx.globalAlpha = flowerP * 0.35 * fade;
    ctx.fillStyle = '#4FE3FF';
    const wingN = 4 + Math.floor(flowerP * 6);
    for (let i = 1; i <= wingN; i++) {
      const t = i / wingN;
      const d1 = t * 220 * (0.4 + 0.6 * p);
      for (let sgn = -1; sgn <= 1; sgn += 2) {
        const wx = cx + sx * sgn * d1;
        const wy = cy + sy * sgn * d1;
        ctx.beginPath();
        ctx.arc(wx, wy, 1.5 + 1.5 * (1 - t), 0, TAU);
        ctx.fill();
      }
    }
  }

  // ---- 中心光源 ----
  if (s.rightT > CONFIG.TUNNEL.LIGHT_START && fade > 0) {
    const k = clamp((s.rightT - CONFIG.TUNNEL.LIGHT_START) / 0.6, 0, 1);
    const r = CONFIG.TUNNEL.LIGHT_RADIUS * (0.6 + 0.6 * k) *
      (1 + 0.12 * Math.sin(now * 2.4));
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 2.6);
    grad.addColorStop(0, 'rgba(255,255,255,' + (0.7 * k * fade).toFixed(3) + ')');
    grad.addColorStop(0.35, 'rgba(180,240,255,' + (0.35 * k * fade).toFixed(3) + ')');
    grad.addColorStop(0.7, 'rgba(80,180,255,' + (0.12 * k * fade).toFixed(3) + ')');
    grad.addColorStop(1, 'rgba(40,120,255,0)');
    ctx.globalAlpha = 1;
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 2.6, 0, TAU);
    ctx.fill();
  }

  ctx.restore();
}

// =====================================================================
// 鼠标输入
// =====================================================================
function spawnTrailShape(s, x, y) {
  const T = CONFIG.TRAIL;
  const size = rand(T.SIZE_MIN, T.SIZE_MAX);
  const speed = rand(T.SPEED_MIN, T.SPEED_MAX);
  const dir = Math.random() * TAU;
  const type = randInt(0, CONFIG.SHAPE_TYPES - 1);
  let colorIdx;
  let mode;
  if (s.currentMode === 'tunnel') {
    mode = 'tunnel';
    colorIdx = randInt(9, 10);
    if (Math.random() < 0.25) colorIdx = CONFIG.COLOR_WHITE;
  } else {
    mode = 'radial';
    colorIdx = randInt(0, 8);
  }
  spawnShape(s, {
    x: x, y: y,
    vx: Math.cos(dir) * speed,
    vy: Math.sin(dir) * speed,
    rot: Math.random() * TAU,
    vrot: rand(T.SPIN_MIN, T.SPIN_MAX) * (Math.random() < 0.5 ? -1 : 1),
    size: size,
    type: type,
    colorIdx: colorIdx,
    life: rand(T.LIFE_MIN, T.LIFE_MAX),
    drag: T.DRAG,
    mode: mode,
    nx: s.tunnelNX,
    ny: s.tunnelNY
  });
}

// =====================================================================
// 左键单击：对称花环 + 光晕脉冲 + 镜像重排
// =====================================================================
function doLeftClick(s, x, y) {
  const coreSize = rand(CONFIG.CLICK.CORE_SIZE_MIN, CONFIG.CLICK.CORE_SIZE_MAX);
  const coreType = randInt(0, CONFIG.SHAPE_TYPES - 1);

  const burst = randInt(CONFIG.CLICK.BURST_MIN, CONFIG.CLICK.BURST_MAX);
  for (let i = 0; i < burst; i++) {
    const a = Math.random() * TAU;
    const sp = rand(CONFIG.CLICK.BURST_SPEED_MIN, CONFIG.CLICK.BURST_SPEED_MAX);
    spawnShape(s, {
      x: x, y: y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      rot: Math.random() * TAU,
      vrot: rand(-3, 3),
      size: rand(CONFIG.CLICK.BURST_SIZE_MIN, CONFIG.CLICK.BURST_SIZE_MAX),
      type: randInt(0, CONFIG.SHAPE_TYPES - 1),
      colorIdx: randInt(0, 8),
      life: rand(0.7, 1.3),
      drag: 1.6,
      mode: s.currentMode === 'tunnel' ? 'tunnel' : 'radial',
      nx: s.tunnelNX,
      ny: s.tunnelNY
    });
  }

  const ringN = randInt(CONFIG.CLICK.RING_MIN, CONFIG.CLICK.RING_MAX);
  const ringR = CONFIG.CLICK.RING_RADIUS;
  for (let i = 0; i < ringN; i++) {
    const a = i * TAU / ringN;
    spawnShape(s, {
      x: x + Math.cos(a) * ringR,
      y: y + Math.sin(a) * ringR,
      vx: Math.cos(a) * 60,
      vy: Math.sin(a) * 60,
      rot: a,
      vrot: rand(-2, 2),
      size: rand(5, 9),
      type: i % CONFIG.SHAPE_TYPES,
      colorIdx: randInt(0, 8),
      life: rand(0.7, 1.1),
      drag: 2.0,
      mode: s.currentMode === 'tunnel' ? 'tunnel' : 'radial',
      nx: s.tunnelNX,
      ny: s.tunnelNY
    });
  }

  spawnShape(s, {
    x: x, y: y,
    vx: 0, vy: 0,
    rot: 0,
    vrot: 1.2,
    size: coreSize,
    type: coreType,
    colorIdx: randInt(0, 8),
    life: 1.0,
    drag: 1.2,
    mode: s.currentMode === 'tunnel' ? 'tunnel' : 'radial',
    nx: s.tunnelNX,
    ny: s.tunnelNY
  });

  addEffect(s, {
    kind: 'pulse',
    x: x, y: y,
    radius: CONFIG.CLICK.PULSE_RADIUS,
    life: CONFIG.CLICK.PULSE_LIFE,
    age: 0
  });

  const nLines = randInt(CONFIG.CLICK.RADIATE_MIN, CONFIG.CLICK.RADIATE_MAX);
  for (let i = 0; i < nLines; i++) {
    const a = i * TAU / nLines + Math.random() * 0.1;
    const len = rand(40, 80);
    addEffect(s, {
      kind: 'line',
      x1: x, y1: y,
      x2: x + Math.cos(a) * len,
      y2: y + Math.sin(a) * len,
      life: CONFIG.CLICK.RADIATE_LIFE,
      age: 0,
      alpha: 0.55,
      width: 1,
      color: '#ffffff'
    });
  }

  s.axisAnimT = 0;

  const ghostN = Math.min(s.shapes.length, 40);
  for (let i = 0; i < ghostN; i++) {
    const g = s.shapes[s.shapes.length - 1 - i];
    if (!g) break;
    const ga = Math.random() * TAU;
    const gr = rand(8, 26);
    spawnShape(s, {
      x: g.x + Math.cos(ga) * gr,
      y: g.y + Math.sin(ga) * gr,
      vx: 0, vy: 0,
      rot: g.rot + CONFIG.RADIAL.REARRANGE_ANGLE * 0.5,
      vrot: 0,
      size: g.size * 0.85,
      type: g.type,
      colorIdx: g.colorIdx,
      life: CONFIG.CLICK.GHOST_LIFE,
      drag: 3,
      mode: 'free',
      nx: g.nx, ny: g.ny
    });
  }
}

// =====================================================================
// 左键松开：径向爆发
// =====================================================================
function releaseLeft(s) {
  const t = s.leftT;
  s.leftDown = false;
  s.leftT = 0;

  if (t < 0.12) return;

  const power = Math.pow(clamp(t / CONFIG.RADIAL.HOLD_MAX, 0, 1), 1.6);
  const cx = s.input.x + s.shakeX;
  const cy = s.input.y + s.shakeY;

  s.sectorDisplay += 2;

  // 原型用 performance.now() / 1000 重算当前图案；移植后统一使用帧时钟 s.now，
  // 与上一帧渲染出的图案保持同一相位，爆发图形与屏幕上的花环严格对齐
  const els = computePatternElements(s, t, s.now);

  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    let ax = el.x - cx;
    let ay = el.y - cy;
    const d = Math.hypot(ax, ay);
    if (d < 0.001) {
      const a = Math.random() * TAU;
      ax = Math.cos(a); ay = Math.sin(a);
    } else {
      ax /= d; ay /= d;
    }
    const sp = 250 + 800 * power;
    spawnShape(s, {
      x: el.x, y: el.y,
      vx: ax * sp,
      vy: ay * sp,
      rot: el.rot,
      vrot: rand(-4, 4),
      size: el.size,
      type: el.type,
      colorIdx: randInt(0, 8),
      life: rand(0.6, 1.0),
      drag: 0.8,
      mode: 'free',
      nx: s.tunnelNX, ny: s.tunnelNY,
      deconOn: true
    });
  }

  addEffect(s, {
    kind: 'pulse',
    x: cx, y: cy,
    radius: 200 + 500 * power,
    life: 0.3,
    age: 0
  });

  const ghostCount = Math.min(els.length, 70);
  for (let i = 0; i < ghostCount; i++) {
    const el = els[(i * 3) % els.length];
    spawnShape(s, {
      x: el.x, y: el.y,
      vx: 0, vy: 0,
      rot: el.rot,
      vrot: 0,
      size: el.size * 1.05,
      type: el.type,
      colorIdx: randInt(0, 8),
      life: 0.5,
      drag: 3,
      mode: 'free',
      nx: s.tunnelNX, ny: s.tunnelNY
    });
  }
}

// =====================================================================
// 右键松开：隧道崩溃
// =====================================================================
function releaseRight(s) {
  const t = s.rightT;
  s.rightDown = false;
  s.rightT = 0;

  const power = t < 0.12 ? 0.12 : Math.pow(clamp(t / CONFIG.TUNNEL.HOLD_MAX, 0, 1), 1.6);
  const cx = s.input.x + s.shakeX;
  const cy = s.input.y + s.shakeY;

  s.tunnelBurst = {
    t: 0,
    power: power,
    nx: s.tunnelNX,
    ny: s.tunnelNY,
    cx: cx,
    cy: cy,
    fired: false
  };
}

// =====================================================================
// 隧道爆发（增强版）——中心闪光 + 冲击波环 + 径向万花筒爆发 + 双向光束
// =====================================================================
function fireTunnelBeam(s, b) {
  const count = Math.floor(CONFIG.TUNNEL.BEAM_COUNT + CONFIG.TUNNEL.BEAM_COUNT_POWER * b.power);
  const speed = CONFIG.TUNNEL.BEAM_SPEED + CONFIG.TUNNEL.BEAM_SPEED_POWER * b.power;
  const px = -b.ny, py = b.nx;

  // ---- 1. 中心过曝闪光 ----
  addEffect(s, {
    kind: 'pulse',
    x: b.cx, y: b.cy,
    radius: 70 + 120 * b.power,
    life: 0.3,
    age: 0
  });

  // ---- 2. 径向万花筒冲击波环（从中心向外扩散的多重环）----
  const ringCount = 4;
  for (let r = 0; r < ringCount; r++) {
    addEffect(s, {
      kind: 'ring',
      x: b.cx, y: b.cy,
      startRadius: 8,
      endRadius: 130 + 320 * b.power + r * 70,
      life: 0.55 + r * 0.12,
      age: 0,
      alpha: 0.7 - r * 0.13,
      width: 3.2 - r * 0.6,
      color: r === 0 ? '#ffffff' : (r === 1 ? '#4FE3FF' : (r === 2 ? '#2B7BFF' : '#FF4FD8'))
    });
  }

  // ---- 3. 中心径向爆发的万花筒图形（全方向一圈，形成对称花环冲击）----
  const radialN = 14 + Math.floor(b.power * 14);
  for (let i = 0; i < radialN; i++) {
    const a = i * TAU / radialN;
    const sp = 220 + 550 * b.power;
    spawnShape(s, {
      x: b.cx + Math.cos(a) * 10,
      y: b.cy + Math.sin(a) * 10,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      rot: a,
      vrot: rand(-3.5, 3.5),
      size: rand(5, 12),
      type: randInt(0, CONFIG.SHAPE_TYPES - 1),
      colorIdx: CONFIG.COLOR_WHITE,
      life: rand(0.55, 1.05),
      drag: 0.6,
      mode: 'free',
      nx: b.nx, ny: b.ny,
      deconOn: true,
      cooling: true
    });
  }

  // ---- 4. 双向光束（主力爆发）----
  for (let sgn = -1; sgn <= 1; sgn += 2) {
    const sideCount = Math.floor(count * 0.5);

    for (let i = 0; i < sideCount; i++) {
      const spread = rand(-42, 42);
      const lead = rand(0, 70);
      spawnShape(s, {
        x: b.cx + px * spread + b.nx * sgn * lead,
        y: b.cy + py * spread + b.ny * sgn * lead,
        vx: b.nx * sgn * speed + px * rand(-70, 70),
        vy: b.ny * sgn * speed + py * rand(-70, 70),
        rot: Math.atan2(b.ny * sgn, b.nx * sgn),
        vrot: rand(-2.8, 2.8),
        size: rand(4, 13),
        type: randInt(0, CONFIG.SHAPE_TYPES - 1),
        colorIdx: CONFIG.COLOR_WHITE,
        life: rand(0.7, 1.4),
        drag: 0.3,
        mode: 'free',
        nx: b.nx, ny: b.ny,
        deconOn: true,
        cooling: true
      });
    }

    // 沿光束方向的连续冲击波环
    for (let r = 0; r < 4; r++) {
      addEffect(s, {
        kind: 'ring',
        x: b.cx + b.nx * sgn * (r * 55 + 25),
        y: b.cy + b.ny * sgn * (r * 55 + 25),
        startRadius: 4,
        endRadius: 45 + 50 * b.power + r * 18,
        life: 0.5 + r * 0.08,
        age: 0,
        alpha: 0.5 - r * 0.1,
        width: 2.6 - r * 0.5,
        color: r === 0 ? '#4FE3FF' : (r === 1 ? '#2B7BFF' : '#4FE3FF')
      });
    }
  }

  // ---- 5. 隧道残影（沿光束方向两侧的平行线段）----
  for (let sgn = -1; sgn <= 1; sgn += 2) {
    for (let i = 0; i < 8; i++) {
      const off = rand(-60, 60);
      const len = rand(200, 420) * (0.6 + 0.4 * b.power);
      addEffect(s, {
        kind: 'line',
        x1: b.cx + px * off,
        y1: b.cy + py * off,
        x2: b.cx + px * off + b.nx * sgn * len,
        y2: b.cy + py * off + b.ny * sgn * len,
        life: 0.5 + Math.random() * 0.2,
        age: 0,
        alpha: 0.12 + 0.08 * Math.random(),
        width: 1,
        color: Math.random() < 0.7 ? '#4FE3FF' : '#2B7BFF'
      });
    }
  }

  // ---- 6. 爆发后花形残影（收缩式幻影）----
  addEffect(s, {
    kind: 'ring',
    x: b.cx, y: b.cy,
    startRadius: 200 + 260 * b.power,
    endRadius: 40,
    life: 0.75,
    age: 0,
    alpha: 0.28,
    width: 1.2,
    color: '#FF4FD8'
  });
  addEffect(s, {
    kind: 'ring',
    x: b.cx, y: b.cy,
    startRadius: 140 + 180 * b.power,
    endRadius: 20,
    life: 0.6,
    age: 0.08,
    alpha: 0.32,
    width: 1.5,
    color: '#4FE3FF'
  });
}

export class CursorKaleido extends CursorEffectElement {
  /** 主题光标：品红描边 + 电弧装饰 */
  cursorTheme() {
    return {
      edge: '#ff8fd0',
      fill: 'rgba(34, 12, 28, .88)',
      glow: '#ff5cb8',
      deco: { color: [255, 143, 208], style: 'arc', rate: 19, speedGain: 0.3 }
    };
  }

  // 原型用的是 mousemove / mousedown / mouseup（不是 pointer 事件族），
  // 不声明这一行，基类会去监听 pointermove，动效将完全收不到鼠标输入。
  inputFamily = 'mouse';

  // =====================================================================
  // 初始化
  // 只烘焙贴图、建状态，不注册任何监听（监听、DPR 缩放、rAF 全归基类）
  // =====================================================================
  setup({ canvas, ctx, width, height, input }) {
    // 与原型一致：初始光标位置取视口中心（原型第 1464~1467 行）。
    // 基类的 input 从 (0, 0) 起算，若不在这里对齐，首帧会按「从左上角跳过来」
    // 计算位移，拖尾生成量会和原型不同。
    input.x = input.lx = width * 0.5;
    input.y = input.ly = height * 0.5;
    input.frameLx = input.x;
    input.frameLy = input.y;

    // 离屏贴图的创建者：取元素自身的 ownerDocument，不碰全局对象，也绝不挂进 DOM
    const doc = canvas.ownerDocument;

    return {
      // 本实例的画布上下文（已按 DPR 缩放过，统一使用 CSS 像素坐标）
      ctx,

      // 画布尺寸（CSS 像素），由基类 onResize 同步
      W: width,
      H: height,

      input,

      // 离屏贴图的创建者：取元素自身的 ownerDocument，不碰全局对象，也绝不挂进 DOM
      doc,

      // 贴图矩阵：5 形状 × 12 颜色 × 5 尺寸，setup() 里一次性烘焙（非每帧）
      tex: buildTextures(doc),

      // 图形 / 特效列表与单帧绘制预算（原型的模块级 shapes / effects / drawBudget）
      shapes: [],
      effects: [],
      drawBudget: 0,

      // 帧时钟：原型用 rAF 时间戳（秒）驱动所有正弦相位，这里按 dt 累加
      now: 0,

      // 光标方向（原型 state.lastDirX / lastDirY）
      // hasMouse：原型首个 mousemove 只对齐锚点、不更新方向（第 826~830 行）
      hasMouse: false,
      lastDirX: 1, lastDirY: 0,
      currentMode: 'radial',

      // 左右键状态
      leftDown: false, leftT: 0,
      rightDown: false, rightT: 0,

      // 径向对称扇区
      sectorTarget: CONFIG.RADIAL.SECTOR_START,
      sectorDisplay: CONFIG.RADIAL.SECTOR_START,

      // 镜像重排动画
      axisOffset: 0,
      axisAnimT: -1,

      // 中心核心图形
      coreType: 0,
      coreRot: 0,

      // 蓄力期生成计时器
      spawnTimerL: 0,
      spawnTimerR: 0,

      // 拖尾按位移累积生成
      trailAccum: 0,

      // 平行镜面隧道
      tunnelDist: CONFIG.TUNNEL.DIST_START,
      tunnelNX: 1, tunnelNY: 0,
      tunnelBurst: null,

      // 蓄力微震
      shakeX: 0, shakeY: 0
    };
  }

  // =====================================================================
  // 输入（按键）—— 位移由基类写入 this.input，这里只处理左右键交互
  // =====================================================================
  onPointerDown(e) {
    const s = this.state;
    if (!s) return;
    const M = s.input;

    if (e.button === 0) {
      s.currentMode = 'radial';
      s.leftDown = true;
      s.leftT = 0;
      s.sectorDisplay = CONFIG.RADIAL.SECTOR_START;
      s.sectorTarget = CONFIG.RADIAL.SECTOR_START;
      s.coreType = randInt(0, CONFIG.SHAPE_TYPES - 1);
      s.coreRot = Math.random() * TAU;
      s.spawnTimerL = 0;
      // 与原型一致：以 state.mouseX / mouseY（最后一次 mousemove 的位置）为爆发原点，
      // 不是 mousedown 的事件坐标
      doLeftClick(s, M.x, M.y);
    } else if (e.button === 2) {
      s.currentMode = 'tunnel';
      s.rightDown = true;
      s.rightT = 0;
      s.spawnTimerR = 0;
      if (Math.hypot(s.lastDirX, s.lastDirY) < 0.1) {
        s.tunnelNX = 1;
        s.tunnelNY = 0;
      } else {
        s.tunnelNX = s.lastDirX;
        s.tunnelNY = s.lastDirY;
      }
    }
  }

  onPointerUp(e) {
    const s = this.state;
    if (!s) return;
    if (e.button === 0 && s.leftDown) releaseLeft(s);
    else if (e.button === 2 && s.rightDown) releaseRight(s);
  }

  // 失焦时按键状态已丢失（原型 window blur 的行为），清空蓄力并重置对称态
  onBlur() {
    const s = this.state;
    if (!s) return;
    s.leftDown = false;
    s.rightDown = false;
    s.leftT = 0;
    s.rightT = 0;
    s.sectorTarget = CONFIG.RADIAL.SECTOR_START;
    s.sectorDisplay = CONFIG.RADIAL.SECTOR_START;
    s.axisAnimT = -1;
    s.axisOffset = 0;
    s.tunnelBurst = null;
  }

  // =====================================================================
  // 尺寸 —— 只同步动效自己的 W / H，画布尺寸与 DPR 由基类维护
  // =====================================================================
  onResize(width, height) {
    const s = this.state;
    if (!s) return;
    s.W = width;
    s.H = height;
  }

  // =====================================================================
  // 鼠标位移：方向（原型 updateDir，第 775~789 行）
  //
  // 锚点口径：原型的 state.lastX / lastY 只在 updateDir 内推进，而 updateDir 唯一
  // 的调用点是 mousemove 回调 onMouseMove（第 831 行），第 828 行的
  // state.lastX = x 同样位于该回调内；每帧函数 update()（第 1264 行）与 frame()
  // （第 1446 行）全文都没有推进锚点。因此这是「事件级」口径，位移取 input.lx / ly
  // （上一段位移的起点 = 上一个 mousemove 的位置），与原型逐事件一致；
  // 不用 frameLx / frameLy。
  // =====================================================================
  _updateDir(s) {
    const M = s.input;
    const dx = M.x - M.lx;
    const dy = M.y - M.ly;

    // 原型首个 mousemove 先把锚点对齐到当前坐标，updateDir 拿到的位移恒为 0，
    // 方向保持初值 (1, 0)：这里同样跳过首次方向更新
    if (!s.hasMouse) {
      if (dx === 0 && dy === 0) return;
      s.hasMouse = true;
      return;
    }

    const d = Math.hypot(dx, dy);
    if (d > 1.5) {
      s.lastDirX = dx / d;
      s.lastDirY = dy / d;
      if (s.currentMode === 'tunnel') {
        s.tunnelNX = s.lastDirX;
        s.tunnelNY = s.lastDirY;
      }
    }
  }

  // =====================================================================
  // 拖尾生成：原型写在 mousemove 回调里（第 837~847 行），按事件位移累积，
  // 每满 CONFIG.TRAIL.STEP(7px) 生成一个图形，位置沿该段位移插值。
  // 移植后按帧执行，同样用事件级锚点 lx / ly 作为这段位移的起点。
  // =====================================================================
  _emitTrail(s) {
    const M = s.input;
    const dx = M.x - M.lx;
    const dy = M.y - M.ly;
    const dist = Math.hypot(dx, dy);

    s.trailAccum += dist;
    const step = CONFIG.TRAIL.STEP;
    while (s.trailAccum >= step) {
      s.trailAccum -= step;
      const t = 1 - s.trailAccum / Math.max(dist, 0.001);
      spawnTrailShape(s,
        M.x - dx * (1 - t) + rand(-2, 2),
        M.y - dy * (1 - t) + rand(-2, 2));
    }
  }

  // =====================================================================
  // 更新逻辑
  // =====================================================================
  update(dt, s) {
    if (!s) return;

    // 帧时钟：原型由 rAF 传入 now（秒），所有正弦相位与旋转都基于它
    s.now += dt;

    // ---- 鼠标方向与拖尾（原型的事件路径，发生在每帧更新之前）----
    this._updateDir(s);
    this._emitTrail(s);

    // ---- 左键扇区增长 ----
    if (s.leftDown) {
      s.leftT += dt;
      const steps = Math.floor(s.leftT / CONFIG.RADIAL.SECTOR_INTERVAL);
      s.sectorTarget = Math.min(
        CONFIG.RADIAL.SECTOR_MAX,
        CONFIG.RADIAL.SECTOR_START + steps * CONFIG.RADIAL.SECTOR_STEP
      );
      const p = clamp(s.leftT / CONFIG.RADIAL.HOLD_MAX, 0, 1);
      if (p > CONFIG.RADIAL.SHAKE_POWER) {
        const k = (p - CONFIG.RADIAL.SHAKE_POWER) / (1 - CONFIG.RADIAL.SHAKE_POWER);
        s.shakeX = (Math.random() - 0.5) * CONFIG.RADIAL.SHAKE_AMP * k;
        s.shakeY = (Math.random() - 0.5) * CONFIG.RADIAL.SHAKE_AMP * k;
      } else {
        s.shakeX = 0;
        s.shakeY = 0;
      }

      s.spawnTimerL += dt;
      if (s.spawnTimerL > CONFIG.RADIAL.SPAWN_INTERVAL) {
        s.spawnTimerL = 0;
        const el = computePatternElements(s, s.leftT, s.now);
        const pick = el[randInt(0, el.length - 1)];
        if (pick) {
          spawnShape(s, {
            x: pick.x, y: pick.y,
            vx: rand(-20, 20), vy: rand(-20, 20),
            rot: Math.random() * TAU,
            vrot: rand(-1.5, 1.5),
            size: rand(5, 10),
            type: randInt(0, CONFIG.SHAPE_TYPES - 1),
            colorIdx: randInt(0, 8),
            life: 1.5,
            drag: 1.5,
            mode: 'radial',
            nx: s.tunnelNX, ny: s.tunnelNY
          });
        }
      }
    } else {
      s.shakeX = 0;
      s.shakeY = 0;
    }

    s.sectorDisplay += (s.sectorTarget - s.sectorDisplay) *
      Math.min(1, dt * CONFIG.RADIAL.SECTOR_LERP);
    if (!s.leftDown) {
      s.sectorTarget += (CONFIG.RADIAL.SECTOR_START - s.sectorTarget) * Math.min(1, dt * 1.5);
    }

    // ---- 镜像重排动画 ----
    if (s.axisAnimT >= 0) {
      s.axisAnimT += dt;
      const total = CONFIG.RADIAL.REARRANGE_TIME * 2;
      const p = s.axisAnimT / total;
      if (p >= 1) {
        s.axisAnimT = -1;
        s.axisOffset = 0;
      } else {
        const tri = p < 0.5 ? p * 2 : (1 - p) * 2;
        s.axisOffset = tri * CONFIG.RADIAL.REARRANGE_ANGLE;
      }
    }

    // ---- 右键隧道 ----
    if (s.tunnelBurst) {
      s.tunnelBurst.t += dt;
      s.tunnelDist = Math.max(0, s.tunnelDist * Math.exp(-dt * 20));
      if (!s.tunnelBurst.fired && s.tunnelBurst.t >= CONFIG.TUNNEL.COLLAPSE_TIME) {
        s.tunnelBurst.fired = true;
        fireTunnelBeam(s, s.tunnelBurst);
      }
      if (s.tunnelBurst.t > 1.5) s.tunnelBurst = null;
    } else {
      let dTarget = CONFIG.TUNNEL.DIST_START;
      if (s.rightDown) {
        s.rightT += dt;
        const p = clamp(s.rightT / CONFIG.TUNNEL.HOLD_MAX, 0, 1);
        dTarget = lerp(CONFIG.TUNNEL.DIST_START, CONFIG.TUNNEL.DIST_MIN, p);
        dTarget *= (1 + CONFIG.TUNNEL.PULSE_AMP * Math.sin(s.now * CONFIG.TUNNEL.PULSE_FREQ * TAU));

        if (p > CONFIG.RADIAL.SHAKE_POWER) {
          const k = (p - CONFIG.RADIAL.SHAKE_POWER) / (1 - CONFIG.RADIAL.SHAKE_POWER);
          s.shakeX = (Math.random() - 0.5) * 3 * k + s.tunnelNX * (Math.random() - 0.5) * 3 * k;
          s.shakeY = (Math.random() - 0.5) * 3 * k + s.tunnelNY * (Math.random() - 0.5) * 3 * k;
        } else {
          s.shakeX = 0;
          s.shakeY = 0;
        }

        s.spawnTimerR += dt;
        if (s.spawnTimerR > CONFIG.TUNNEL.SPAWN_INTERVAL) {
          s.spawnTimerR = 0;
          const speed = rand(CONFIG.TUNNEL.SPAWN_SPEED_MIN, CONFIG.TUNNEL.SPAWN_SPEED_MAX);
          const sgn = Math.random() < 0.5 ? -1 : 1;
          spawnShape(s, {
            x: s.input.x + rand(-10, 10),
            y: s.input.y + rand(-10, 10),
            vx: s.tunnelNX * sgn * speed,
            vy: s.tunnelNY * sgn * speed,
            rot: Math.random() * TAU,
            vrot: rand(-1.6, 1.6),
            size: rand(5, 11),
            type: randInt(0, CONFIG.SHAPE_TYPES - 1),
            colorIdx: randInt(9, 10),
            life: rand(0.9, 1.6),
            drag: 0.6,
            mode: 'tunnel',
            nx: s.tunnelNX, ny: s.tunnelNY
          });
        }
      }
      // 【原型缺陷修复】原型第 1377 行写的是 CONFIG.TUNNEL.LERP —— TUNNEL 下根本没有
      // 这个键（只有 DIST_LERP），dt * undefined = NaN，于是 state.tunnelDist 从
      // 第一帧起就恒为 NaN（(dTarget - tunnelDist) 为 0 也救不了：0 * NaN = NaN）：
      // 隧道镜像副本 / 镜面线 / 椭圆环的坐标全变 NaN 而永不绘制，爆发期的
      // Math.max(0, NaN * exp) 仍是 NaN，永久无法恢复。
      // 这里改用原型已声明却从未被引用的 CONFIG.TUNNEL.DIST_LERP（= 5），恢复其本意。
      s.tunnelDist += (dTarget - s.tunnelDist) * Math.min(1, dt * CONFIG.TUNNEL.DIST_LERP);
    }

    // ---- 图形更新 ----
    for (let i = s.shapes.length - 1; i >= 0; i--) {
      const sh = s.shapes[i];
      sh.age += dt;
      sh.life -= dt;
      if (sh.life <= 0) {
        s.shapes.splice(i, 1);
        continue;
      }
      sh.x += sh.vx * dt;
      sh.y += sh.vy * dt;
      sh.rot += sh.vrot * dt;

      const damp = Math.exp(-sh.drag * dt);
      sh.vx *= damp;
      sh.vy *= damp;
      sh.vrot *= Math.exp(-0.6 * dt);

      if (sh.x < -300 || sh.x > s.W + 300 || sh.y < -300 || sh.y > s.H + 300) {
        sh.life = Math.min(sh.life, 0.15);
      }

      if (sh.deconOn && sh.decon < 1) {
        sh.decon = Math.min(1, sh.decon + dt / 0.4);
      }

      if (sh.cooling && sh.cool < 1) {
        sh.cool = Math.min(1, sh.cool + dt * 1.6);
      }
    }

    updateEffects(s, dt);
  }

  // =====================================================================
  // 渲染：原型此处已是 clearRect 起手，没有任何整屏铺底，画布保持透明
  // =====================================================================
  render(s) {
    if (!s) return;
    const ctx = s.ctx;

    // 画布缓冲、DPR 与 setTransform 由基类维护，这里统一使用 CSS 像素坐标
    ctx.clearRect(0, 0, s.W, s.H);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 1;

    s.drawBudget = CONFIG.MAX_DRAWS;

    for (let i = 0; i < s.shapes.length; i++) {
      if (s.drawBudget <= 0) break;
      drawShapeObject(ctx, s, s.shapes[i]);
    }

    if (s.leftDown && s.leftT > 0.1) {
      renderRadialPattern(ctx, s, s.now);
      renderRadialAxes(ctx, s, s.now);
    }

    if (s.rightDown || s.tunnelBurst) {
      renderTunnelMirrors(ctx, s, s.now);
    }

    renderEffects(ctx, s);

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }
}

if (!customElements.get('cursor-kaleido')) {
  customElements.define('cursor-kaleido', CursorKaleido);
}

export default CursorKaleido;
