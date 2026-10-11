/**
 * cursor-geom —— 鼠标光标几何体动效（左键多面体锻造 / 右键镶嵌编织）。
 *
 * 由 html/几何体.html 原型移植：算法流程、数值、视觉表现与原文件一一对应。
 * 作为光标层组件，原型页面自身的行为已剔除：
 *   - 原型的深色底 #04060c 写在 CSS 的 html,body 上，不是画布填充；
 *     绘制中本来就没有整屏铺底，render() 只做 clearRect，绝不覆盖宿主页面；
 *   - 不拦截 contextmenu，宿主页面的右键菜单不受影响；
 *   - 画布创建、DPR 适配（封顶 2）、尺寸同步、监听注册、rAF 循环、鼠标速度平滑
 *     以及「>300px 跳变归零 / 6000 封顶」全部由基类负责。
 *
 * 原型监听 mousemove / mousedown / mouseup，因此声明 inputFamily = 'mouse'。
 * 所有运行状态都放在 setup() 返回的 state 上，多实例互不干扰。
 */

import { CursorEffectElement } from '../core/base.js';
import { TAU, clamp, lerp, rand } from '../core/utils.js';

/* ============================================================
   全局配置
   ============================================================ */
const CONFIG = {
  MAX_PARTICLES: 2600,      // 粒子池上限
  DPR_MAX: 2,               // 最大像素比

  /* 拖尾 */
  TRAIL: {
    MIN_SPEED: 40,          // 触发拖尾的最低速度 px/s
    EMIT_PER_PX: 0.11,      // 每像素生成数量
    MAX_PER_FRAME: 8,       // 单次事件最多生成
    LIFE_MIN: 0.5,          // 最短寿命
    LIFE_MAX: 1.2,          // 最长寿命
    LINK_DIST: 60,          // 星座连线距离
    LINK_ALPHA: 0.12,       // 星座连线透明度
    LINK_MAX: 180           // 参与连线的拖尾上限
  },

  /* 单击 */
  CLICK: {
    TRI_DUR: 0.4,           // 三角形存活时长
    SHARD_MIN: 12,          // 碎片最少
    SHARD_MAX: 18,          // 碎片最多
    SHARD_SPD_MIN: 250,
    SHARD_SPD_MAX: 600,
    SHARD_LIFE: 0.7,
    HEXRING_LIFE: 0.35,
    STAR_LIFE: 0.12,
    D_RADIUS: 200,          // 三角剖分半径
    GRID_SPACING: 46,       // 剖分网格间距
    SNAP_TIME: 0.15,        // 吸附时长
    NET_LIFE: 0.45          // 网络存活时长
  },

  /* 左键锻造 */
  FORGE: {
    MAX_TIME: 2.5,          // 蓄力总时长
    STAGE_START: [0, 0.1, 0.6, 1.1, 1.6, 2.1], // 各阶段起始时间
    RADII: [0, 30, 52, 74, 96, 124],           // 各阶段半径
    ROT_X: 0.4,             // X 轴角速度
    ROT_Y: 0.6,             // Y 轴角速度
    SHAKE_AT: 0.55,         // 开始微震的进度
    ATTRACT_R: 150          // 吸附拖尾的半径
  },

  /* 右键镶嵌 */
  WEAVE: {
    MAX_TIME: 2.5,
    HEX_SIZE: 20,           // 六边形外接圆半径
    RING_INTERVAL: 0.2,     // 每圈铺展间隔
    MAX_RINGS: 7,           // 最大圈数
    ROT_SPEED: 0.1,         // 旋转角速度
    FRACTAL_AT: 1.2,        // 开始分形递归的时间
    FRACTAL_R: 120,         // 分形作用半径
    TENSION_AT: 1.5,        // 边界波动开始时间
    SHAKE_AT: 0.55
  }
};

/* ============================================================
   常量 / 工具函数
   ============================================================ */
const PHI = (1 + Math.sqrt(5)) / 2;
const FOV = 700;

const easeOutCubic = x => 1 - Math.pow(1 - x, 3);

/* 十六进制色 + 透明度 → rgba 字符串 */
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}

/* 两个十六进制色按 t 混合（原型逐通道 Math.round，与 utils.mixColor 的数组语义不同） */
function mixHex(h1, h2, t) {
  const a = parseInt(h1.slice(1), 16), b = parseInt(h2.slice(1), 16);
  const r = Math.round(((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * t);
  const g = Math.round(((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * t);
  const bl = Math.round((a & 255) + ((b & 255) - (a & 255)) * t);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1);
}

/* 碎片随机冷色 */
const COLD = ['#4FE3FF', '#2B7BFF', '#9B5CFF', '#FFFFFF'];
function pickCold() { return COLD[(Math.random() * COLD.length) | 0]; }

/* ============================================================
   粒子池
   ============================================================ */
// 原型还有一个 VERT: 3（顶点粒子），全链路不可达，未移植
const T = {
  TRAIL: 1, SHARD: 2, GLOW: 4, STAR: 5,
  SEG: 6, POLYRING: 7, HEXRING: 8, NET: 9
};

function makeP() {
  return {
    type: 0, x: 0, y: 0, vx: 0, vy: 0,
    life: 0, maxLife: 1, delay: 0,
    r: 0, rot: 0, vrot: 0, sides: 3,
    color: '#FFFFFF', color2: '#FFFFFF',
    alpha: 1, len: 0, drag: 1,
    snap: 0, snapDur: 1, stx: 0, sty: 0, tx: 0, ty: 0,
    data: null, scale: 1
  };
}

/* ============================================================
   多面体几何数学
   ============================================================ */
const GS = {};

function normVerts(raw) {
  let m = 0;
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    const d = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    if (d > m) m = d;
  }
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    out.push([v[0] / m, v[1] / m, v[2] / m]);
  }
  return out;
}

function edgesFromFaces(faces) {
  const seen = new Set(), out = [];
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    for (let k = 0; k < f.length; k++) {
      const a = f[k], b = f[(k + 1) % f.length];
      const key = a < b ? a + '-' + b : b + '-' + a;
      if (!seen.has(key)) { seen.add(key); out.push([a, b]); }
    }
  }
  return out;
}

function defShape(name, verts, faces) {
  GS[name] = { verts: normVerts(verts), faces: faces, edges: edgesFromFaces(faces) };
}

defShape('tetra',
  [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]],
  [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]]);

defShape('cube',
  [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
   [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
  [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [0, 3, 7, 4], [1, 2, 6, 5]]);

defShape('octa',
  [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]],
  [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]]);

defShape('icosa',
  [[-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
   [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
   [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1]],
  [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
   [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
   [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
   [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]]);

/* 各阶段使用的形状（阶段0为点，无形状） */
const FORGE_SHAPES = [null, GS.tetra, GS.cube, GS.octa, GS.icosa, GS.icosa];

/* 各阶段配色 [顶点, 棱边, 面] */
const FORGE_PALETTE = [
  ['#FFFFFF', '#4FE3FF', '#4FE3FF'],
  ['#FFFFFF', '#4FE3FF', '#2B7BFF'],
  ['#C9F5FF', '#7FEAFF', '#2B7BFF'],
  ['#A3E4FF', '#4FE3FF', '#2B7BFF'],
  ['#7FB6FF', '#4FE3FF', '#9B5CFF'],
  ['#9B5CFF', '#D8F4FF', '#9B5CFF']
];

/* 透视投影：把三维点数组投影到屏幕 */
function projectPoints(pts, cx, cy, rotX, rotY) {
  const cX = Math.cos(rotX), sX = Math.sin(rotX);
  const cY = Math.cos(rotY), sY = Math.sin(rotY);
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const x1 = p[0] * cY + p[2] * sY;
    const z1 = -p[0] * sY + p[2] * cY;
    const y1 = p[1] * cX - z1 * sX;
    const z2 = p[1] * sX + z1 * cX;
    const pp = FOV / (FOV + z2);
    out.push({
      x: cx + x1 * pp, y: cy + y1 * pp, z: z2, s: pp,
      wx: x1, wy: y1, wz: z2
    });
  }
  return out;
}

/* ============================================================
   镶嵌网格数学（六边形轴向坐标）
   ============================================================ */
function ringAxial(k) {
  const out = [];
  if (k === 0) { out.push([0, 0]); return out; }
  for (let q = -k; q <= k; q++) {
    for (let r = -k; r <= k; r++) {
      const s = -q - r;
      if (Math.max(Math.abs(q), Math.abs(r), Math.abs(s)) === k) out.push([q, r]);
    }
  }
  return out;
}

function axialToLocal(q, r, size) {
  return { x: size * 1.5 * q, y: size * Math.sqrt(3) * (r + q / 2) };
}

/* 德劳内三角剖分（Bowyer-Watson） */
function circumcircle(a, b, c) {
  const ax = a.x, ay = a.y, bx = b.x, by = b.y, cx2 = c.x, cy2 = c.y;
  const d = 2 * (ax * (by - cy2) + bx * (cy2 - ay) + cx2 * (ay - by));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx2 * cx2 + cy2 * cy2;
  const ux = (a2 * (by - cy2) + b2 * (cy2 - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx2 - bx) + b2 * (ax - cx2) + c2 * (bx - ax)) / d;
  const r2 = (ax - ux) * (ax - ux) + (ay - uy) * (ay - uy);
  return { x: ux, y: uy, r2: r2 };
}

function bowyerWatson(pts) {
  const n = pts.length;
  if (n < 3) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const dx = maxX - minX, dy = maxY - minY;
  const dm = Math.max(dx, dy) || 1;
  const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;

  const P = pts.slice();
  const off = P.length;
  P.push({ x: midX - 20 * dm, y: midY - dm });
  P.push({ x: midX, y: midY + 20 * dm });
  P.push({ x: midX + 20 * dm, y: midY - dm });

  let tris = [[off, off + 1, off + 2]];

  for (let i = 0; i < off; i++) {
    const p = P[i];
    const bad = [];
    for (let t = 0; t < tris.length; t++) {
      const tr = tris[t];
      const cc = circumcircle(P[tr[0]], P[tr[1]], P[tr[2]]);
      if (!cc) { bad.push(tr); continue; }
      const ddx = p.x - cc.x, ddy = p.y - cc.y;
      if (ddx * ddx + ddy * ddy <= cc.r2) bad.push(tr);
    }
    if (!bad.length) continue;

    const edges = [];
    for (let bi = 0; bi < bad.length; bi++) {
      const tr = bad[bi];
      const es = [[tr[0], tr[1]], [tr[1], tr[2]], [tr[2], tr[0]]];
      for (let ei = 0; ei < 3; ei++) {
        const a = es[ei][0], b = es[ei][1];
        let shared = false;
        for (let bj = 0; bj < bad.length; bj++) {
          if (bj === bi) continue;
          const t2 = bad[bj];
          if ((t2[0] === a && t2[1] === b) || (t2[1] === a && t2[0] === b) ||
              (t2[0] === a && t2[2] === b) || (t2[2] === a && t2[0] === b) ||
              (t2[1] === a && t2[2] === b) || (t2[2] === a && t2[1] === b)) {
            shared = true; break;
          }
        }
        if (!shared) edges.push([a, b]);
      }
    }

    const next = [];
    for (let t = 0; t < tris.length; t++) {
      if (bad.indexOf(tris[t]) === -1) next.push(tris[t]);
    }
    for (let e = 0; e < edges.length; e++) next.push([edges[e][0], edges[e][1], i]);
    tris = next;
  }

  const out = [];
  for (let t = 0; t < tris.length; t++) {
    const tr = tris[t];
    if (tr[0] < off && tr[1] < off && tr[2] < off) out.push(tr);
  }
  return out;
}

/* ============================================================
   拖尾 / 碎片 / 特效 绘制
   ============================================================ */
function drawTrail(ctx, p, t) {
  ctx.globalAlpha = t * p.alpha;
  ctx.strokeStyle = p.color;
  ctx.lineWidth = p.r;
  ctx.lineCap = 'round';
  const ex = p.x - Math.cos(p.rot) * p.len;
  const ey = p.y - Math.sin(p.rot) * p.len;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(ex, ey);
  ctx.stroke();
}

function drawShard(ctx, p, t) {
  const a = t;
  ctx.beginPath();
  for (let k = 0; k < p.sides; k++) {
    const ang = p.rot + k * TAU / p.sides;
    const px = p.x + Math.cos(ang) * p.r;
    const py = p.y + Math.sin(ang) * p.r;
    if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.globalAlpha = a * 0.13;
  ctx.fillStyle = p.color;
  ctx.fill();
  ctx.globalAlpha = a * 0.9;
  ctx.strokeStyle = p.color;
  ctx.lineWidth = 1;
  ctx.stroke();
}

/* 光晕粒子：贴图由调用方从实例缓存里取（sprite 为离屏贴图） */
function drawGlowP(ctx, p, t, sprite) {
  const R = p.r * (1 + (1 - t) * 0.6);
  ctx.globalAlpha = t * p.alpha;
  ctx.drawImage(sprite, p.x - R, p.y - R, R * 2, R * 2);
}

function drawStar(ctx, p, t) {
  const s = p.r * (0.6 + (1 - t) * 0.8);
  const s2 = s * 0.5;
  ctx.globalAlpha = t;
  ctx.strokeStyle = p.color;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(p.x - s, p.y); ctx.lineTo(p.x + s, p.y);
  ctx.moveTo(p.x, p.y - s); ctx.lineTo(p.x, p.y + s);
  ctx.moveTo(p.x - s2, p.y - s2); ctx.lineTo(p.x + s2, p.y + s2);
  ctx.moveTo(p.x + s2, p.y - s2); ctx.lineTo(p.x - s2, p.y + s2);
  ctx.stroke();
}

function drawSeg(ctx, p, t) {
  const hx = Math.cos(p.rot) * p.len * 0.5;
  const hy = Math.sin(p.rot) * p.len * 0.5;
  ctx.globalAlpha = t;
  ctx.strokeStyle = p.color;
  ctx.lineWidth = p.r;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(p.x - hx, p.y - hy);
  ctx.lineTo(p.x + hx, p.y + hy);
  ctx.stroke();
}

function drawPolyRing(ctx, p, t) {
  const k = 1 - t;
  const R = lerp(10, p.r, easeOutCubic(k));
  ctx.globalAlpha = (1 - k) * 0.9 * p.alpha;
  ctx.strokeStyle = p.color;
  ctx.lineWidth = lerp(2.4, 0.5, k);
  ctx.beginPath();
  for (let i = 0; i <= p.sides; i++) {
    const ang = p.rot + i * TAU / p.sides;
    const x = p.x + Math.cos(ang) * R;
    const y = p.y + Math.sin(ang) * R;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawHexRing(ctx, p, t) {
  const k = 1 - t;
  const R = lerp(10, p.r, easeOutCubic(k));
  ctx.globalAlpha = (1 - k);
  ctx.strokeStyle = p.color;
  ctx.lineWidth = lerp(2.2, 0.4, k);
  ctx.beginPath();
  for (let i = 0; i <= 6; i++) {
    const ang = p.rot + i * TAU / 6;
    const x = p.x + Math.cos(ang) * R;
    const y = p.y + Math.sin(ang) * R;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  ctx.globalAlpha = (1 - k) * 0.9;
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const ang = p.rot + i * TAU / 6;
    const x = p.x + Math.cos(ang) * R;
    const y = p.y + Math.sin(ang) * R;
    ctx.moveTo(x + 2, y);
    ctx.arc(x, y, 2, 0, TAU);
  }
  ctx.fill();
}

function drawNet(ctx, p) {
  const d = p.data;
  if (!d) return;
  const elapsed = p.maxLife - p.life;
  let a, scale;
  const T1 = 0.25, T2 = 0.30;
  if (elapsed < T1) {
    a = 0.4 * (elapsed / T1);
    scale = 1;
  } else if (elapsed < T2) {
    a = 0.8;
    scale = 1;
  } else {
    const k = clamp((elapsed - T2) / Math.max(p.maxLife - T2, 0.001), 0, 1);
    a = 0.8 * (1 - k);
    scale = 1 - 0.15 * k;
  }
  ctx.globalAlpha = a;
  ctx.strokeStyle = d.color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < d.edges.length; i++) {
    const e = d.edges[i];
    const A = d.nodes[e[0]], B = d.nodes[e[1]];
    if (!A || !B) continue;
    ctx.moveTo(d.cx + (A.x - d.cx) * scale, d.cy + (A.y - d.cy) * scale);
    ctx.lineTo(d.cx + (B.x - d.cx) * scale, d.cy + (B.y - d.cy) * scale);
  }
  ctx.stroke();
}

export class CursorGeom extends CursorEffectElement {
  /**
   * 滚轮动效：几何棱片旋转飞出，带明显自转与重力。
   */
  wheelTheme() {
    return {
      style: 'shard',
      color:  [157, 184, 232],
      color2: [220, 235, 255],
      sizeMin: 2.4, sizeMax: 6.5,
      lifeMin: 0.5, lifeMax: 1.0,
      upSpeed: 330,
      downSpeed: 290,
      spread: 120,
      gravity: 380,
      drag: 0.8,
      spin: 6,
      jitter: 8
    };
  }

  /** 主题光标：钢蓝描边 + 电弧装饰 */
  cursorTheme() {
    return {
      edge: '#9db8e8',
      fill: 'rgba(16, 22, 34, .88)',
      glow: '#7f9fd0',
      deco: { color: [157, 184, 232], style: 'arc', rate: 16, speedGain: 0.24 }
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

    const pool = [];
    for (let i = 0; i < CONFIG.MAX_PARTICLES; i++) pool.push(makeP());

    return {
      // 本实例的画布上下文（已按 DPR 缩放过，统一使用 CSS 像素坐标）
      ctx,

      // 画布尺寸（CSS 像素），由基类 onResize 同步
      W: width,
      H: height,

      input,

      // 离屏光晕贴图的宿主文档：取元素自身的 ownerDocument，不碰全局 document
      doc: canvas.ownerDocument,

      // 光晕精灵缓存（按颜色预渲染径向渐变），每个实例一份
      glow: new Map(),

      // 粒子池 / 存活表
      pool,
      active: [],

      // 拖尾生成累加器
      emitAcc: 0,

      // 星座连线复用缓冲，避免每帧分配
      trailBuf: [],

      // 左右键状态（原型用真实按下时刻判定短按/长按）
      leftDown: false, rightDown: false,
      leftStart: 0, rightStart: 0,
      leftX: 0, leftY: 0, rightX: 0, rightY: 0,

      // 单击三角形动画
      clickTri: null,

      // 左键锻造状态
      forge: {
        on: false,
        t: 0,
        x: 0, y: 0,
        stage: -1,
        stageT: 0,
        rotX: 0, rotY: 0,
        flash: 0,
        verts2d: [],
        edges2d: [],
        faces2d: []
      },

      // 右键镶嵌状态
      weave: {
        on: false,
        t: 0,
        x: 0, y: 0,
        rot: 0,
        hexes: [],
        rings: 0,
        nextRingT: 0
      }
    };
  }

  /* ============================================================
     光晕精灵 / 粒子池
     ============================================================ */
  // 原型在模块级用全局 document 预渲染光晕贴图并全局缓存；
  // 移植后改用元素自身的 ownerDocument 创建、缓存挂到 state 上，多实例互不干扰。
  // 这里的 getContext / width / height 只作用于离屏贴图画布，与主画布无关。
  _getGlow(s, color) {
    let sp = s.glow.get(color);
    if (sp) return sp;
    const size = 128;
    const cv = s.doc.createElement('canvas');
    cv.width = cv.height = size;
    const g = cv.getContext('2d');
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, hexA(color, 1));
    grad.addColorStop(0.3, hexA(color, 0.45));
    grad.addColorStop(1, hexA(color, 0));
    g.fillStyle = grad;
    // 贴图自身的整块填充：它落在离屏画布上，不是视口铺底，必须保留
    g.fillRect(0, 0, size, size);
    s.glow.set(color, cv);
    return cv;
  }

  _alloc(s) {
    let p;
    if (s.pool.length) {
      p = s.pool.pop();
    } else if (s.active.length) {
      p = s.active.shift(); // 超出上限：回收最旧
    } else {
      p = makeP();
    }
    p.type = 0; p.x = 0; p.y = 0; p.vx = 0; p.vy = 0;
    p.life = 0; p.maxLife = 1; p.delay = 0;
    p.r = 0; p.rot = 0; p.vrot = 0; p.sides = 3;
    p.color = '#FFFFFF'; p.color2 = '#FFFFFF';
    p.alpha = 1; p.len = 0; p.drag = 1;
    p.snap = 0; p.snapDur = 1; p.stx = 0; p.sty = 0; p.tx = 0; p.ty = 0;
    p.data = null; p.scale = 1;
    s.active.push(p);
    return p;
  }

  /* ============================================================
     输入（按键）—— 鼠标速度由基类算好，这里只处理左右键交互
     ============================================================ */
  onPointerDown(e) {
    const s = this.state;
    if (!s) return;

    if (e.button === 0) {
      s.leftDown = true;
      s.leftStart = performance.now();
      s.leftX = e.clientX; s.leftY = e.clientY;
      this._startForge(s, s.leftX, s.leftY);
    } else if (e.button === 2) {
      s.rightDown = true;
      s.rightStart = performance.now();
      s.rightX = e.clientX; s.rightY = e.clientY;
      this._startWeave(s, s.rightX, s.rightY);
    }
  }

  onPointerUp(e) {
    const s = this.state;
    if (!s) return;

    // 与原型一致：以真实按住时长区分「单击」与「蓄力释放」
    if (e.button === 0 && s.leftDown) {
      s.leftDown = false;
      const t = (performance.now() - s.leftStart) / 1000;
      if (t < 0.12) {
        this._cancelForge(s);
        this._doClick(s, s.leftX, s.leftY);
      } else {
        this._releaseForge(s);
      }
    } else if (e.button === 2 && s.rightDown) {
      s.rightDown = false;
      const t = (performance.now() - s.rightStart) / 1000;
      if (t < 0.12) {
        this._cancelWeave(s);
        this._doRightClick(s, s.rightX, s.rightY);
      } else {
        this._releaseWeave(s);
      }
    }
  }

  // 失焦时按键状态已丢失（原型 window blur 的行为），直接取消蓄力
  onBlur() {
    const s = this.state;
    if (!s) return;
    if (s.leftDown) { s.leftDown = false; this._cancelForge(s); }
    if (s.rightDown) { s.rightDown = false; this._cancelWeave(s); }
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
     拖尾粒子生成
     ============================================================ */
  // 原型写在 mousemove 里（逐事件）；移植后按帧用基类算好的位移与速度处理，
  // 速度平滑、>300px 跳变归零、6000 封顶都在基类，这里不再重复计算。
  _emitTrail(s) {
    const M = s.input;
    const dx = M.x - M.lx;
    const dy = M.y - M.ly;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const speed = M.speed;

    if (!(dist > 0.6 && speed > CONFIG.TRAIL.MIN_SPEED)) return;

    s.emitAcc += dist * CONFIG.TRAIL.EMIT_PER_PX;
    const n = Math.min(Math.floor(s.emitAcc), CONFIG.TRAIL.MAX_PER_FRAME);
    s.emitAcc -= n;
    if (s.emitAcc > 4) s.emitAcc = 4;

    const ang = Math.atan2(dy, dx);
    const ox = M.lx, oy = M.ly;
    for (let i = 0; i < n; i++) {
      const f = (i + 1) / (n + 1);
      const px = ox + dx * f, py = oy + dy * f;
      this._spawnTrail(s, px, py, ang, speed);
      if (Math.random() < 0.35) this._spawnShard(s, px, py, ang, speed * 0.10);
    }
  }

  _spawnTrail(s, x, y, ang, speed) {
    const p = this._alloc(s);
    p.type = T.TRAIL;
    p.x = x; p.y = y;
    p.rot = ang;
    p.len = clamp(speed * 0.022, 4, 15);
    p.r = rand(0.9, 2.0);
    p.maxLife = p.life = rand(CONFIG.TRAIL.LIFE_MIN, CONFIG.TRAIL.LIFE_MAX);
    p.color = Math.random() < 0.18 ? '#9B5CFF' : '#4FE3FF';
    p.vx = Math.cos(ang) * speed * 0.03;
    p.vy = Math.sin(ang) * speed * 0.03;
    p.drag = 0;
    p.alpha = 0.95;
    return p;
  }

  _spawnShard(s, x, y, ang, speed) {
    const p = this._alloc(s);
    p.type = T.SHARD;
    p.x = x; p.y = y;
    const a = ang + rand(-0.9, 0.9);
    const sp = speed * rand(0.3, 0.9);
    p.vx = Math.cos(a) * sp;
    p.vy = Math.sin(a) * sp;
    p.sides = 3 + ((Math.random() * 4) | 0);
    p.r = rand(3, 9);
    p.rot = rand(0, TAU);
    p.vrot = rand(-4, 4);
    p.maxLife = p.life = rand(0.5, 1.2);
    p.color = pickCold();
    p.drag = 2;
    return p;
  }

  /* ============================================================
     特效生成器
     ============================================================ */
  _spawnStar(s, x, y, r, color, life) {
    const p = this._alloc(s);
    p.type = T.STAR;
    p.x = x; p.y = y;
    p.r = r;
    p.color = color || '#FFFFFF';
    p.maxLife = p.life = life || 0.15;
    return p;
  }

  _spawnGlowNode(s, x, y, r, color, life, alpha) {
    const p = this._alloc(s);
    p.type = T.GLOW;
    p.x = x; p.y = y;
    p.r = r;
    p.color = color;
    p.alpha = alpha === undefined ? 0.3 : alpha;
    p.maxLife = p.life = life || 0.4;
    return p;
  }

  _spawnSeg(s, x, y, ang, len, spd, color) {
    const p = this._alloc(s);
    p.type = T.SEG;
    p.x = x; p.y = y;
    p.rot = ang;
    p.len = len;
    p.r = rand(1.2, 2.2);
    p.vx = Math.cos(ang) * spd;
    p.vy = Math.sin(ang) * spd;
    p.color = color;
    p.drag = 2;
    p.maxLife = p.life = rand(0.8, 1.6);
    return p;
  }

  _spawnPolyRing(s, x, y, sides, maxR, color, life, rot) {
    const p = this._alloc(s);
    p.type = T.POLYRING;
    p.x = x; p.y = y;
    p.sides = sides;
    p.r = maxR;
    p.rot = rot || 0;
    p.color = color;
    p.alpha = 1;
    p.maxLife = p.life = life || 0.35;
    return p;
  }

  _spawnTriWire(s, x, y) {
    const p = this._alloc(s);
    p.type = T.POLYRING;
    p.x = x; p.y = y;
    p.sides = 3;
    p.r = rand(10, 22);
    p.rot = rand(0, TAU);
    p.color = '#4FE3FF';
    p.alpha = 1;
    p.maxLife = p.life = 0.2;
    return p;
  }

  _spawnNet(s, nodes, edges, cx, cy, color) {
    const p = this._alloc(s);
    p.type = T.NET;
    p.x = cx; p.y = cy;
    p.data = { nodes: nodes, edges: edges, cx: cx, cy: cy, color: color };
    p.maxLife = p.life = CONFIG.CLICK.NET_LIFE;
    return p;
  }

  /* ============================================================
     左键单击效果
     ============================================================ */
  _doClick(s, x, y) {
    s.clickTri = { x: x, y: y, t: 0, rot: Math.random() * TAU, broken: false };

    /* 几何碎片散射 */
    const n = CONFIG.CLICK.SHARD_MIN +
      ((Math.random() * (CONFIG.CLICK.SHARD_MAX - CONFIG.CLICK.SHARD_MIN + 1)) | 0);
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * TAU;
      const sp = rand(CONFIG.CLICK.SHARD_SPD_MIN, CONFIG.CLICK.SHARD_SPD_MAX);
      const p = this._alloc(s);
      p.type = T.SHARD;
      p.x = x; p.y = y;
      p.vx = Math.cos(ang) * sp;
      p.vy = Math.sin(ang) * sp;
      p.sides = Math.random() < 0.5 ? 3 : 4;
      p.r = rand(3, 8);
      p.rot = Math.random() * TAU;
      p.vrot = rand(-5, 5);
      p.maxLife = p.life = CONFIG.CLICK.SHARD_LIFE;
      p.color = pickCold();
      p.drag = 2;
    }

    /* 六边形线框环 */
    const h = this._alloc(s);
    h.type = T.HEXRING;
    h.x = x; h.y = y;
    h.r = 70;
    h.rot = Math.random() * TAU;
    h.color = '#4FE3FF';
    h.maxLife = h.life = CONFIG.CLICK.HEXRING_LIFE;

    /* 顶点闪点 */
    this._spawnStar(s, x, y, 26, '#FFFFFF', CONFIG.CLICK.STAR_LIFE);
    this._spawnGlowNode(s, x, y, 16, '#4FE3FF', 0.25, 0.45);

    /* 三角剖分重构 */
    this._doDelaunaySnap(s, x, y);
  }

  /* 对周围拖尾碎片做网格重构 */
  _doDelaunaySnap(s, cx, cy) {
    const R = CONFIG.CLICK.D_RADIUS;
    const R2 = R * R;
    const S = CONFIG.CLICK.GRID_SPACING;
    const hh = S * Math.sqrt(3) / 2;

    const map = new Map();
    const affected = [];

    for (let i = 0; i < s.active.length; i++) {
      const p = s.active[i];
      if (p.type !== T.TRAIL && p.type !== T.SHARD) continue;
      if (p.life <= 0) continue;
      const dx = p.x - cx, dy = p.y - cy;
      if (dx * dx + dy * dy > R2) continue;

      /* 找最近的三角格节点 */
      let bestI = 0, bestJ = 0, bestD = Infinity;
      const j0 = Math.round(dy / hh);
      for (let j = j0 - 1; j <= j0 + 1; j++) {
        const off = (j & 1) ? S * 0.5 : 0;
        const i0 = Math.round((dx - off) / S);
        for (let ii = i0 - 1; ii <= i0 + 1; ii++) {
          const nx = ii * S + off, ny = j * hh;
          const d = (nx - dx) * (nx - dx) + (ny - dy) * (ny - dy);
          if (d < bestD) { bestD = d; bestI = ii; bestJ = j; }
        }
      }
      const off = (bestJ & 1) ? S * 0.5 : 0;
      const nx = bestI * S + off, ny = bestJ * hh;
      const key = bestI + ',' + bestJ;
      let node = map.get(key);
      if (!node) {
        node = { x: cx + nx, y: cy + ny };
        map.set(key, node);
      }
      affected.push({ p: p, node: node });
    }

    if (affected.length < 3) return;

    /* 视觉对齐 */
    for (let i = 0; i < affected.length; i++) {
      const p = affected[i].p;
      p.snapDur = CONFIG.CLICK.SNAP_TIME;
      p.snap = p.snapDur;
      p.stx = p.x; p.sty = p.y;
      p.tx = affected[i].node.x;
      p.ty = affected[i].node.y;
    }

    /* 三角剖分 */
    const nodes = [];
    map.forEach(function (v) { nodes.push(v); });
    if (nodes.length < 3) return;
    const tris = bowyerWatson(nodes);
    if (!tris.length) return;

    const seen = new Set();
    const edges = [];
    for (let i = 0; i < tris.length; i++) {
      const t = tris[i];
      const pairs = [[t[0], t[1]], [t[1], t[2]], [t[2], t[0]]];
      for (let k = 0; k < 3; k++) {
        const a = pairs[k][0], b = pairs[k][1];
        const key = a < b ? a + '_' + b : b + '_' + a;
        if (!seen.has(key)) { seen.add(key); edges.push([a, b]); }
      }
    }
    if (!edges.length) return;

    this._spawnNet(s, nodes, edges, cx, cy, '#4FE3FF');

    /* 网络节点上的小三角形线框 */
    const cnt = 3 + ((Math.random() * 3) | 0);
    for (let i = 0; i < cnt; i++) {
      const nd = nodes[(Math.random() * nodes.length) | 0];
      this._spawnTriWire(s, nd.x, nd.y);
    }
  }

  /* 单击三角形动画 */
  _updateClickTri(s, dt) {
    const clickTri = s.clickTri;
    if (!clickTri) return;
    clickTri.t += dt;
    clickTri.rot += dt * 1.6;
    if (!clickTri.broken && clickTri.t >= CONFIG.CLICK.TRI_DUR) {
      clickTri.broken = true;
      for (let i = 0; i < 3; i++) {
        const a0 = clickTri.rot + i * TAU / 3;
        const a1 = clickTri.rot + (i + 1) * TAU / 3;
        const mx = clickTri.x + (Math.cos(a0) + Math.cos(a1)) * 9;
        const my = clickTri.y + (Math.sin(a0) + Math.sin(a1)) * 9;
        const ang = Math.atan2(my - clickTri.y, mx - clickTri.x);
        this._spawnSeg(s, mx, my, ang, rand(14, 26), rand(180, 320), '#4FE3FF');
      }
    }
    if (clickTri.t > CONFIG.CLICK.TRI_DUR + 0.15) s.clickTri = null;
  }

  _drawClickTriFx(s) {
    const ctx = s.ctx;
    const clickTri = s.clickTri;
    if (!clickTri || clickTri.broken) return;
    const t = clickTri.t;
    let sc;
    if (t < 0.15) sc = (t / 0.15) * 1.2;
    else sc = 1.2 - ((t - 0.15) / 0.25) * 0.2;
    sc = Math.max(sc, 0);

    const R = 26 * sc;
    const pts = [];
    for (let i = 0; i < 3; i++) {
      const ang = clickTri.rot + i * TAU / 3 - Math.PI / 2;
      pts.push({ x: clickTri.x + Math.cos(ang) * R, y: clickTri.y + Math.sin(ang) * R });
    }

    ctx.globalAlpha = 0.12;
    ctx.fillStyle = '#2B7BFF';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(pts[1].x, pts[1].y);
    ctx.lineTo(pts[2].x, pts[2].y);
    ctx.closePath();
    ctx.fill();

    ctx.globalAlpha = 0.95;
    ctx.strokeStyle = '#4FE3FF';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(pts[1].x, pts[1].y);
    ctx.lineTo(pts[2].x, pts[2].y);
    ctx.closePath();
    ctx.stroke();

    /* 顶点 */
    const sp = this._getGlow(s, '#4FE3FF');
    for (let i = 0; i < 3; i++) {
      ctx.globalAlpha = 0.6;
      ctx.drawImage(sp, pts[i].x - 10, pts[i].y - 10, 20, 20);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.arc(pts[i].x, pts[i].y, 2.6 * sc, 0, TAU);
      ctx.fill();
    }
  }

  /* ============================================================
     左键 —— 多面体锻造
     ============================================================ */
  _startForge(s, x, y) {
    const forge = s.forge;
    forge.on = true;
    forge.t = 0;
    forge.x = x; forge.y = y;
    forge.stage = -1;
    forge.stageT = 0;
    forge.rotX = 0;
    forge.rotY = 0;
    forge.flash = 0;
    forge.verts2d.length = 0;
    forge.edges2d.length = 0;
    forge.faces2d.length = 0;
    this._setForgeStage(s, 0);
  }

  _cancelForge(s) {
    const forge = s.forge;
    forge.on = false;
    forge.stage = -1;
    forge.flash = 0;
    forge.verts2d.length = 0;
    forge.edges2d.length = 0;
    forge.faces2d.length = 0;
  }

  _setForgeStage(s, stage) {
    const forge = s.forge;
    if (forge.stage === stage) return;
    if (forge.stage >= 0 && forge.verts2d.length) {
      /* 旧结构瓦解：抛散碎片 */
      const pal = FORGE_PALETTE[Math.max(forge.stage, 0)];
      const cnt = 6 + ((forge.stage * 1.5) | 0);
      for (let i = 0; i < cnt; i++) {
        const v = forge.verts2d[(Math.random() * forge.verts2d.length) | 0];
        if (!v) continue;
        const ang = Math.random() * TAU;
        const p = this._alloc(s);
        p.type = T.SHARD;
        p.x = v.x; p.y = v.y;
        const sp = rand(80, 260);
        p.vx = Math.cos(ang) * sp;
        p.vy = Math.sin(ang) * sp;
        p.sides = 3 + ((Math.random() * 3) | 0);
        p.r = rand(3, 7);
        p.rot = Math.random() * TAU;
        p.vrot = rand(-5, 5);
        p.maxLife = p.life = rand(0.4, 0.9);
        p.color = Math.random() < 0.5 ? pal[1] : pal[2];
        p.drag = 2;
      }
      for (let i = 0; i < 6; i++) {
        const e = forge.edges2d[(Math.random() * forge.edges2d.length) | 0];
        if (!e) continue;
        const f = Math.random();
        const px = lerp(e.x1, e.x2, f), py = lerp(e.y1, e.y2, f);
        const ang = Math.atan2(e.y2 - e.y1, e.x2 - e.x1) + rand(-0.4, 0.4);
        this._spawnSeg(s, px, py, ang, rand(8, 18), rand(120, 300), pal[1]);
      }
    }
    forge.stage = stage;
    forge.stageT = 0;
  }

  _updateForge(s, dt) {
    const forge = s.forge;
    if (!forge.on && forge.flash <= 0) return;

    if (forge.flash > 0) {
      forge.flash -= dt;
      if (forge.flash <= 0 && !forge.on) {
        forge.stage = -1;
        forge.verts2d.length = 0;
        forge.edges2d.length = 0;
        forge.faces2d.length = 0;
        return;
      }
    }

    if (forge.on) {
      forge.t += dt;
      forge.stageT += dt;

      /* 阶段推进 */
      let ns = 0;
      for (let i = CONFIG.FORGE.STAGE_START.length - 1; i >= 0; i--) {
        if (forge.t >= CONFIG.FORGE.STAGE_START[i]) { ns = i; break; }
      }
      this._setForgeStage(s, ns);

      const spd = 1 + forge.stage * 0.08;
      forge.rotX += CONFIG.FORGE.ROT_X * spd * dt;
      forge.rotY += CONFIG.FORGE.ROT_Y * spd * dt;

      /* 吸附附近拖尾粒子到最近顶点 */
      if (forge.verts2d.length) {
        const AR = CONFIG.FORGE.ATTRACT_R, AR2 = AR * AR;
        const lim = Math.min(s.active.length, 400);
        for (let i = 0; i < lim; i++) {
          const p = s.active[i];
          if (p.type !== T.TRAIL && p.type !== T.SHARD) continue;
          if (p.snap > 0 || p.life <= 0) continue;
          const dx = p.x - forge.x, dy = p.y - forge.y;
          if (dx * dx + dy * dy > AR2) continue;
          let bd = Infinity, bv = null;
          for (let k = 0; k < forge.verts2d.length; k++) {
            const v = forge.verts2d[k];
            const d = (v.x - p.x) * (v.x - p.x) + (v.y - p.y) * (v.y - p.y);
            if (d < bd) { bd = d; bv = v; }
          }
          if (bv) {
            p.snapDur = 0.3;
            p.snap = p.snapDur;
            p.stx = p.x; p.sty = p.y;
            p.tx = bv.x; p.ty = bv.y;
          }
        }
      }
    }

    /* 计算本帧几何 */
    this._buildForgeGeometry(s);
  }

  _buildForgeGeometry(s) {
    const forge = s.forge;
    forge.verts2d.length = 0;
    forge.edges2d.length = 0;
    forge.faces2d.length = 0;

    const st = forge.stage;
    if (st < 0) return;

    const pal = FORGE_PALETTE[Math.max(st, 0)];
    const R = CONFIG.FORGE.RADII[Math.max(st, 0)];
    const shape = FORGE_SHAPES[Math.max(st, 0)];

    /* 结构稳定脉动 */
    const pf = 2 + st * 0.8;
    const pulse = 1 + Math.sin(forge.stageT * pf) * 0.05;

    /* 微震 */
    let shakeX = 0, shakeY = 0;
    if (forge.on && forge.t / CONFIG.FORGE.MAX_TIME > CONFIG.FORGE.SHAKE_AT) {
      const jt = forge.t * 60;
      shakeX = Math.sin(jt) * Math.sin(jt * 1.7) * 2.5;
      shakeY = Math.cos(jt * 1.3) * Math.sin(jt * 2.1) * 2.5;
    }

    const cx = forge.x + shakeX;
    const cy = forge.y + shakeY;

    /* 阶段 0：只有中心点 */
    if (st === 0 || !shape) {
      const app = clamp(forge.stageT / 0.1, 0, 1);
      forge.verts2d.push({ x: cx, y: cy, r: 3.2 * app, s: 1, z: 0, idx: -1 });
      return;
    }

    const lt = forge.on ? forge.t - CONFIG.FORGE.STAGE_START[Math.max(st, 0)] : 1;

    /* 生成三维点 */
    const pts3 = [];
    const N = shape.verts.length;
    for (let i = 0; i < N; i++) {
      const v = shape.verts[i];
      pts3.push([v[0] * R * pulse, v[1] * R * pulse, v[2] * R * pulse]);
    }

    /* 阶段 5：卫星小四面体 */
    let satOffset = -1;
    const SAT = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];
    const satScale = R * 0.22;
    if (st === 5) {
      satOffset = N;
      const satNorm = [];
      let mm = 0;
      for (let i = 0; i < 4; i++) {
        const d = Math.sqrt(SAT[i][0] * SAT[i][0] + SAT[i][1] * SAT[i][1] + SAT[i][2] * SAT[i][2]);
        if (d > mm) mm = d;
      }
      for (let i = 0; i < 4; i++) satNorm.push([SAT[i][0] / mm, SAT[i][1] / mm, SAT[i][2] / mm]);
      for (let i = 0; i < N; i++) {
        const base = shape.verts[i];
        for (let k = 0; k < 4; k++) {
          const sv = satNorm[k];
          pts3.push([
            base[0] * R * pulse + sv[0] * satScale,
            base[1] * R * pulse + sv[1] * satScale,
            base[2] * R * pulse + sv[2] * satScale
          ]);
        }
      }
    }

    const proj = projectPoints(pts3, cx, cy, forge.rotX, forge.rotY);

    /* 顶点出现进度 */
    for (let i = 0; i < proj.length; i++) {
      const localIdx = i < N ? i : (i - satOffset) % 4;
      const app = forge.on ? clamp((lt - localIdx * 0.015) / 0.12, 0, 1) : 1;
      const pop = app < 1 ? 1 + Math.sin(app * Math.PI) * 0.5 : 1;
      proj[i].app = app;
      proj[i].r = (i < N ? 2.6 : 1.7) * pop * (0.7 + proj[i].s * 0.4);
    }

    /* ---- 面 ---- */
    const faceList = [];
    for (let i = 0; i < shape.faces.length; i++) {
      const f = shape.faces[i];
      const app = forge.on ? clamp((lt - 0.28 - i * 0.008) / 0.14, 0, 1) : 1;
      if (app <= 0) continue;
      let zsum = 0;
      for (let k = 0; k < f.length; k++) zsum += proj[f[k]].z;
      faceList.push({ idx: i, z: zsum / f.length, app: app });
    }
    faceList.sort(function (a, b) { return b.z - a.z; });

    for (let i = 0; i < faceList.length; i++) {
      const fl = faceList[i];
      const f = shape.faces[fl.idx];
      const fv = [];
      for (let k = 0; k < f.length; k++) {
        const pv = proj[f[k]];
        if (pv.app <= 0) { fv.length = 0; break; }
        /* 扇形展开：从面中心向外 */
        fv.push({ x: pv.x, y: pv.y });
      }
      if (fv.length < 3) continue;
      let mx = 0, my = 0;
      for (let k = 0; k < fv.length; k++) { mx += fv[k].x; my += fv[k].y; }
      mx /= fv.length; my /= fv.length;
      const pts = [];
      for (let k = 0; k < fv.length; k++) {
        pts.push({ x: mx + (fv[k].x - mx) * fl.app, y: my + (fv[k].y - my) * fl.app });
      }
      forge.faces2d.push({ pts: pts, color: pal[2], app: fl.app });
    }

    /* ---- 棱边 ---- */
    for (let i = 0; i < shape.edges.length; i++) {
      const e = shape.edges[i];
      const A = proj[e[0]], B = proj[e[1]];
      if (!A || !B) continue;
      const grow = forge.on ? clamp((lt - 0.2 - i * 0.022) / 0.08, 0, 1) : 1;
      if (grow <= 0) continue;
      /* 棱边抖动 */
      let jx = 0, jy = 0;
      if (forge.on && forge.t / CONFIG.FORGE.MAX_TIME > CONFIG.FORGE.SHAKE_AT) {
        const jt = forge.t * 120 + i;
        jx = Math.sin(jt) * 1.4;
        jy = Math.cos(jt * 1.3) * 1.4;
      }
      forge.edges2d.push({
        x1: A.x + jx, y1: A.y + jy,
        x2: A.x + (B.x - A.x) * grow + jx,
        y2: A.y + (B.y - A.y) * grow + jy,
        a: A.s, b: B.s,
        grow: grow,
        color: pal[1]
      });
    }

    /* 卫星棱边 */
    if (st === 5 && satOffset >= 0) {
      for (let i = 0; i < N; i++) {
        const b = satOffset + i * 4;
        const satEdges = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
        for (let k = 0; k < 6; k++) {
          const A = proj[b + satEdges[k][0]];
          const B = proj[b + satEdges[k][1]];
          if (!A || !B) continue;
          const grow = forge.on ? clamp((lt - 0.2 - i * 0.02) / 0.08, 0, 1) : 1;
          if (grow <= 0) continue;
          forge.edges2d.push({
            x1: A.x, y1: A.y,
            x2: A.x + (B.x - A.x) * grow,
            y2: A.y + (B.y - A.y) * grow,
            a: A.s, b: B.s, grow: grow, color: pal[1]
          });
        }
      }
    }

    /* ---- 顶点 ---- */
    for (let i = 0; i < proj.length; i++) {
      const pv = proj[i];
      if (pv.app <= 0) continue;
      forge.verts2d.push({
        x: pv.x, y: pv.y,
        r: pv.r * pv.app,
        s: pv.s,
        z: pv.z,
        idx: i,
        app: pv.app
      });
    }
  }

  _releaseForge(s) {
    const forge = s.forge;
    if (!forge.on) return;
    const t = forge.t;
    const power = Math.pow(clamp(t / CONFIG.FORGE.MAX_TIME, 0, 1), 1.6);
    const pal = FORGE_PALETTE[Math.max(forge.stage, 0)];

    forge.on = false;
    forge.flash = 0.06;

    const verts = forge.verts2d.slice();
    const edges = forge.edges2d.slice();
    const faces = forge.faces2d.slice();

    /* 1. 过曝顶点爆裂 */
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      this._spawnStar(s, v.x, v.y, 12 + 10 * power, '#FFFFFF', 0.15);
      this._spawnGlowNode(s, v.x, v.y, 5 + 8 * power,
        Math.random() < 0.12 ? '#FF4FD8' : pal[0], 0.4, 0.4);
    }

    /* 2. 棱边碎裂 */
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const ang = Math.atan2(e.y2 - e.y1, e.x2 - e.x1);
      const n = 2 + ((Math.random() * 3) | 0);
      for (let k = 0; k < n; k++) {
        const f = (k + 1) / (n + 1);
        const px = lerp(e.x1, e.x2, f);
        const py = lerp(e.y1, e.y2, f);
        this._spawnSeg(s, px, py, ang + rand(-0.25, 0.25), rand(8, 20),
          200 + 700 * power, Math.random() < 0.4 ? '#FFFFFF' : e.color);
      }
    }

    /* 3. 面炸裂 */
    for (let i = 0; i < faces.length; i++) {
      const f = faces[i];
      let mx = 0, my = 0;
      for (let k = 0; k < f.pts.length; k++) { mx += f.pts[k].x; my += f.pts[k].y; }
      mx /= f.pts.length; my /= f.pts.length;
      const n = 3 + ((Math.random() * 4) | 0);
      for (let k = 0; k < n; k++) {
        const ang = Math.random() * TAU;
        const sp = 250 + 850 * power;
        const p = this._alloc(s);
        p.type = T.SHARD;
        p.x = mx + rand(-6, 6);
        p.y = my + rand(-6, 6);
        p.vx = Math.cos(ang) * sp * rand(0.5, 1);
        p.vy = Math.sin(ang) * sp * rand(0.5, 1);
        const rnd = Math.random();
        p.sides = rnd < 0.6 ? 3 : (rnd < 0.85 ? 4 : (rnd < 0.95 ? 5 : 6));
        p.r = rand(4, 11);
        p.rot = Math.random() * TAU;
        p.vrot = rand(-4, 4);
        p.maxLife = p.life = rand(1.2, 2.0);
        p.color = pal[2];
        p.drag = 2;
      }
    }

    /* 4. 多边形冲击波（依次扩散的壳层） */
    const maxR = 100 + 420 * power;
    const shells = [[3, 0.42], [4, 0.62], [6, 0.82], [6, 1.0]];
    for (let i = 0; i < shells.length; i++) {
      const r = maxR * shells[i][1];
      if (r < 12) continue;
      const p = this._spawnPolyRing(s, forge.x, forge.y, shells[i][0], r, '#4FE3FF', 0.32, forge.rotY);
      p.delay = i * 0.07;
    }

    /* 5. 结构性碎片雨 */
    const total = 80 + Math.floor(320 * power);
    const totalClamped = Math.min(total, 420);
    for (let i = 0; i < totalClamped; i++) {
      const ang = Math.random() * TAU;
      const sp = 250 + 850 * power;
      const rnd = Math.random();
      const sides = rnd < 0.6 ? 3 : (rnd < 0.85 ? 4 : (rnd < 0.95 ? 5 : 6));
      const p = this._alloc(s);
      p.type = T.SHARD;
      p.x = forge.x + Math.cos(ang) * rand(0, 24);
      p.y = forge.y + Math.sin(ang) * rand(0, 24);
      p.vx = Math.cos(ang) * sp * rand(0.35, 1);
      p.vy = Math.sin(ang) * sp * rand(0.35, 1);
      p.sides = sides;
      p.r = rand(3.5, 10);
      p.rot = Math.random() * TAU;
      p.vrot = rand(-4, 4);
      p.maxLife = p.life = rand(1.2, 2.0);
      p.color = Math.random() < 0.7 ? pal[2] : (Math.random() < 0.5 ? '#FFFFFF' : '#9B5CFF');
      p.drag = 2;
      p.delay = Math.random() * 0.06;
    }

    /* 6. 顶点余晖星图 */
    for (let i = 0; i < Math.min(verts.length, 24); i++) {
      const v = verts[i];
      const p = this._spawnGlowNode(s, v.x, v.y, 4 + Math.random() * 6, pal[0], 0.4, 0.3);
      p.delay = Math.random() * 0.1;
    }

    /* 7. 网格残余 */
    if (verts.length >= 4) {
      const nodes = [];
      for (let i = 0; i < verts.length; i++) nodes.push({ x: verts[i].x, y: verts[i].y });
      const edgesN = [];
      const maxD = 80 * 80;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y;
          if (dx * dx + dy * dy < maxD) edgesN.push([i, j]);
        }
      }
      if (edgesN.length) {
        const net = this._spawnNet(s, nodes, edgesN, forge.x, forge.y, pal[1]);
        net.maxLife = net.life = 0.6;
        net.delay = 0.25;
      }
    }
  }

  /* ============================================================
     右键 —— 镶嵌编织
     ============================================================ */
  _startWeave(s, x, y) {
    const weave = s.weave;
    weave.on = true;
    weave.t = 0;
    weave.x = x; weave.y = y;
    weave.rot = 0;
    weave.hexes.length = 0;
    weave.rings = 0;
    this._addRing(s, 0);
    weave.nextRingT = CONFIG.WEAVE.RING_INTERVAL;
  }

  _cancelWeave(s) {
    const weave = s.weave;
    weave.on = false;
    weave.hexes.length = 0;
    weave.rings = 0;
  }

  _addRing(s, k) {
    const weave = s.weave;
    const list = ringAxial(k);
    const size = CONFIG.WEAVE.HEX_SIZE;
    for (let i = 0; i < list.length; i++) {
      const q = list[i][0], r = list[i][1];
      const lp = axialToLocal(q, r, size);
      weave.hexes.push({
        q: q, r: r,
        lx: lp.x, ly: lp.y,
        ring: k,
        t: 0,
        d: Math.sqrt(lp.x * lp.x + lp.y * lp.y)
      });
    }
    weave.rings = k;
  }

  _updateWeave(s, dt) {
    const weave = s.weave;
    if (!weave.on) return;
    weave.t += dt;

    const prog = clamp(weave.t / CONFIG.WEAVE.MAX_TIME, 0, 1);
    weave.rot += CONFIG.WEAVE.ROT_SPEED * (1 + prog * 0.6) * dt;

    while (weave.t >= weave.nextRingT && weave.rings < CONFIG.WEAVE.MAX_RINGS) {
      this._addRing(s, weave.rings + 1);
      weave.nextRingT += CONFIG.WEAVE.RING_INTERVAL;
    }

    for (let i = 0; i < weave.hexes.length; i++) {
      const h = weave.hexes[i];
      if (h.t < 1) h.t = Math.min(1, h.t + dt / 0.12);
    }
  }

  _drawWeave(s) {
    const weave = s.weave;
    if (!weave.on || !weave.hexes.length) return;
    const ctx = s.ctx;

    const size = CONFIG.WEAVE.HEX_SIZE;
    const prog = clamp(weave.t / CONFIG.WEAVE.MAX_TIME, 0, 1);
    const breath = 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(weave.t * (3 + prog * 5)));
    const colOuter = mixHex('#FFD24A', '#FF6B1A', prog * 0.9);
    const tension = weave.t > CONFIG.WEAVE.TENSION_AT
      ? clamp((weave.t - CONFIG.WEAVE.TENSION_AT) / 0.8, 0, 1) : 0;

    const cosR = Math.cos(weave.rot), sinR = Math.sin(weave.rot);

    /* 中心微震 */
    let sx = 0, sy = 0;
    if (weave.t / CONFIG.WEAVE.MAX_TIME > CONFIG.WEAVE.SHAKE_AT) {
      const jt = weave.t * 62;
      sx = Math.sin(jt * 1.2) * 2.4;
      sy = Math.cos(jt * 1.7) * 2.4;
    }
    const ox = weave.x + sx, oy = weave.y + sy;

    const fractOn = weave.t >= CONFIG.WEAVE.FRACTAL_AT;
    const fProg = fractOn ? clamp((weave.t - CONFIG.WEAVE.FRACTAL_AT) / 0.6, 0, 1) : 0;

    /* 按圈分层绘制 */
    for (let k = 0; k <= weave.rings; k++) {
      const mixT = clamp(k / Math.max(weave.rings, 1), 0, 1);
      const col = mixHex('#FFD24A', colOuter, mixT);
      const inner = k < weave.rings;

      ctx.beginPath();
      let any = false;

      for (let i = 0; i < weave.hexes.length; i++) {
        const h = weave.hexes[i];
        if (h.ring !== k) continue;
        any = true;

        const app = easeOutCubic(h.t);
        const sc = 0.4 + 0.6 * app;

        let hx = h.lx * cosR - h.ly * sinR;
        let hy = h.lx * sinR + h.ly * cosR;

        /* 边界张力波动 */
        if (tension > 0 && k === weave.rings) {
          const wob = Math.sin(weave.t * 9 + h.q * 1.7 + h.r * 2.3) * 8 * tension;
          const len = Math.sqrt(hx * hx + hy * hy) || 1;
          hx += (hx / len) * wob;
          hy += (hy / len) * wob;
        }

        const px = ox + hx;
        const py = oy + hy;
        const r = size * sc;

        for (let v = 0; v <= 6; v++) {
          const ang = weave.rot + v * Math.PI / 3;
          const vx = px + Math.cos(ang) * r;
          const vy = py + Math.sin(ang) * r;
          if (v === 0) ctx.moveTo(vx, vy); else ctx.lineTo(vx, vy);
        }
      }

      if (!any) continue;

      ctx.globalAlpha = breath * (inner ? 0.9 : 0.55) * (0.5 + 0.5 * k / Math.max(weave.rings, 1));
      ctx.strokeStyle = col;
      ctx.lineWidth = inner ? 1.6 : 1.0;
      ctx.stroke();

      /* 顶点亮点 */
      ctx.beginPath();
      let vcount = 0;
      for (let i = 0; i < weave.hexes.length; i++) {
        const h = weave.hexes[i];
        if (h.ring !== k || h.t < 1) continue;
        const app = easeOutCubic(h.t);
        let hx = h.lx * cosR - h.ly * sinR;
        let hy = h.lx * sinR + h.ly * cosR;
        if (tension > 0 && k === weave.rings) {
          const wob = Math.sin(weave.t * 9 + h.q * 1.7 + h.r * 2.3) * 8 * tension;
          const len = Math.sqrt(hx * hx + hy * hy) || 1;
          hx += (hx / len) * wob;
          hy += (hy / len) * wob;
        }
        const px = ox + hx, py = oy + hy;
        const r = size * (0.4 + 0.6 * app);
        for (let v = 0; v < 6; v++) {
          const ang = weave.rot + v * Math.PI / 3;
          const vx = px + Math.cos(ang) * r;
          const vy = py + Math.sin(ang) * r;
          ctx.moveTo(vx + 1.6, vy);
          ctx.arc(vx, vy, 1.6, 0, TAU);
          vcount++;
        }
        if (vcount > 600) break;
      }
      ctx.globalAlpha = breath * 0.9;
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
    }

    /* 分形递归：六边形内部三角形分割 */
    if (fractOn && fProg > 0) {
      const R2 = CONFIG.WEAVE.FRACTAL_R * CONFIG.WEAVE.FRACTAL_R;
      ctx.beginPath();
      let drew = false;
      for (let i = 0; i < weave.hexes.length; i++) {
        const h = weave.hexes[i];
        if (h.d * h.d > R2) continue;
        if (h.t < 1) continue;
        const hx = h.lx * cosR - h.ly * sinR;
        const hy = h.lx * sinR + h.ly * cosR;
        const px = ox + hx, py = oy + hy;
        const r = size * fProg;
        for (let v = 0; v < 6; v++) {
          const ang = weave.rot + v * Math.PI / 3;
          const vx = px + Math.cos(ang) * r;
          const vy = py + Math.sin(ang) * r;
          ctx.moveTo(px, py);
          ctx.lineTo(vx, vy);
        }
        drew = true;
      }
      if (drew) {
        ctx.globalAlpha = 0.5 * fProg;
        ctx.strokeStyle = '#3DFFD0';
        ctx.lineWidth = 0.9;
        ctx.stroke();
      }
    }

    /* 中心光晕 */
    const sp = this._getGlow(s, '#FFD24A');
    const gr = 40 + 30 * prog;
    ctx.globalAlpha = 0.25 * breath;
    ctx.drawImage(sp, ox - gr, oy - gr, gr * 2, gr * 2);
  }

  _releaseWeave(s) {
    const weave = s.weave;
    if (!weave.on) return;
    const t = weave.t;
    const power = Math.pow(clamp(t / CONFIG.WEAVE.MAX_TIME, 0, 1), 1.6);
    const prog = clamp(t / CONFIG.WEAVE.MAX_TIME, 0, 1);

    weave.on = false;

    const cosR = Math.cos(weave.rot), sinR = Math.sin(weave.rot);
    const size = CONFIG.WEAVE.HEX_SIZE;
    const maxRing = Math.max(weave.rings, 0);

    const colOuter = mixHex('#FFD24A', '#FF6B1A', prog * 0.9);

    /* 折叠一帧：顶点向中心收 8%，视觉上通过缩小起始半径表现 */
    for (let i = 0; i < weave.hexes.length; i++) {
      const h = weave.hexes[i];
      const delay = (maxRing - h.ring) * 0.045;

      const hx = h.lx * cosR - h.ly * sinR;
      const hy = h.lx * sinR + h.ly * cosR;
      const px = weave.x + hx * 0.92;
      const py = weave.y + hy * 0.92;

      const mixT = clamp(h.ring / Math.max(maxRing, 1), 0, 1);
      const col = mixHex('#FFD24A', colOuter, mixT);

      /* 6 个三角形碎片，从各自格子中心飞出 */
      for (let k = 0; k < 6; k++) {
        const a0 = weave.rot + k * Math.PI / 3;
        const a1 = weave.rot + (k + 1) * Math.PI / 3;
        const v0x = px + Math.cos(a0) * size, v0y = py + Math.sin(a0) * size;
        const v1x = px + Math.cos(a1) * size, v1y = py + Math.sin(a1) * size;
        const tx = (px + v0x + v1x) / 3;
        const ty = (py + v0y + v1y) / 3;

        const ang = Math.atan2(ty - py, tx - px);
        const spd = (250 + 800 * power) * rand(0.6, 1.1);

        const p = this._alloc(s);
        p.type = T.SHARD;
        p.x = tx; p.y = ty;
        p.vx = Math.cos(ang) * spd;
        p.vy = Math.sin(ang) * spd;
        p.sides = 3;
        p.r = rand(4, 9);
        p.rot = Math.random() * TAU;
        p.vrot = rand(-5, 5);
        p.maxLife = p.life = rand(1.0, 1.8);
        p.color = Math.random() < 0.25 ? '#3DFFD0' : col;
        p.drag = 2;
        p.delay = delay;
      }

      /* 顶点余晖 */
      if (Math.random() < 0.25) {
        const g = this._spawnGlowNode(s, px, py, rand(3, 7), col, 0.4, 0.35);
        g.delay = delay;
      }
    }

    /* 六边形轮廓冲击波 */
    const maxR = 120 + 450 * power;
    const shells = 4;
    for (let i = 0; i < shells; i++) {
      const r = maxR * ((i + 1) / shells);
      if (r < 20) continue;
      const p = this._spawnPolyRing(s, weave.x, weave.y, 6, r, '#FFD24A', 0.42, weave.rot);
      p.delay = i * 0.08;
    }
    const p2 = this._spawnPolyRing(s, weave.x, weave.y, 6, maxR * 0.5, '#3DFFD0', 0.3, weave.rot + 0.5);
    p2.delay = 0.05;

    /* 网格网络余晖 */
    const nodes = [];
    const step = Math.max(1, Math.floor(weave.hexes.length / 26));
    for (let i = 0; i < weave.hexes.length; i += step) {
      const h = weave.hexes[i];
      const hx = h.lx * cosR - h.ly * sinR;
      const hy = h.lx * sinR + h.ly * cosR;
      nodes.push({ x: weave.x + hx, y: weave.y + hy });
    }
    if (nodes.length >= 3) {
      const edgesN = [];
      const maxD = 100 * 100;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y;
          if (dx * dx + dy * dy < maxD) edgesN.push([i, j]);
        }
      }
      if (edgesN.length) {
        const net = this._spawnNet(s, nodes, edgesN, weave.x, weave.y, '#FFD24A');
        net.maxLife = net.life = 0.5;
        net.delay = 0.2;
      }
    }

    weave.hexes.length = 0;
    weave.rings = 0;
  }

  /* 右键短按：小六边形铺展一圈后碎裂 */
  _doRightClick(s, x, y) {
    const size = CONFIG.WEAVE.HEX_SIZE * 0.9;
    const cx = x, cy = y;

    /* 生成一圈小六边形轮廓 */
    const ring = ringAxial(1);
    const all = [{ q: 0, r: 0 }].concat(ring.map(function (a) { return { q: a[0], r: a[1] }; }));

    for (let i = 0; i < all.length; i++) {
      const lp = axialToLocal(all[i].q, all[i].r, size);
      const px = cx + lp.x, py = cy + lp.y;
      const p = this._spawnPolyRing(s, px, py, 6, size * 1.6, '#FFD24A', 0.35, Math.random() * TAU);
      p.sides = 6;
    }

    for (let i = 0; i < 14; i++) {
      const ang = Math.random() * TAU;
      const sp = rand(180, 380);
      const p = this._alloc(s);
      p.type = T.SHARD;
      p.x = cx; p.y = cy;
      p.vx = Math.cos(ang) * sp;
      p.vy = Math.sin(ang) * sp;
      p.sides = 3;
      p.r = rand(3, 7);
      p.rot = Math.random() * TAU;
      p.vrot = rand(-5, 5);
      p.maxLife = p.life = rand(0.6, 1.0);
      p.color = Math.random() < 0.3 ? '#FF9F1C' : '#FFD24A';
      p.drag = 2;
    }

    this._spawnStar(s, cx, cy, 18, '#FFD24A', 0.12);
    this._spawnGlowNode(s, cx, cy, 12, '#FFD24A', 0.25, 0.4);
  }

  /* ============================================================
     粒子更新 / 绘制
     ============================================================ */
  _updateParticles(s, dt) {
    const active = s.active;
    const pool = s.pool;
    const dragK = [
      Math.pow(0.90, dt * 60),
      Math.pow(0.965, dt * 60),
      Math.pow(0.997, dt * 60)
    ];
    let w = 0;
    for (let i = 0; i < active.length; i++) {
      const p = active[i];
      if (p.life <= 0) { p.data = null; pool.push(p); continue; }

      if (p.delay > 0) {
        p.delay -= dt;
        active[w++] = p;
        continue;
      }

      p.life -= dt;
      if (p.life <= 0) { p.data = null; pool.push(p); continue; }

      if (p.snap > 0) {
        p.snap -= dt;
        const k = 1 - Math.max(p.snap, 0) / p.snapDur;
        const e = easeOutCubic(k);
        p.x = p.stx + (p.tx - p.stx) * e;
        p.y = p.sty + (p.ty - p.sty) * e;
        if (p.snap <= 0) {
          const dx = p.tx - p.stx, dy = p.ty - p.sty;
          p.vx = dx * 1.6;
          p.vy = dy * 1.6;
        }
      } else {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        const dk = dragK[p.drag] || dragK[1];
        p.vx *= dk;
        p.vy *= dk;
      }
      p.rot += p.vrot * dt;

      active[w++] = p;
    }
    active.length = w;
  }

  /* 星座连线 */
  _drawConstellation(s) {
    const ctx = s.ctx;
    const active = s.active;
    const trailBuf = s.trailBuf;
    trailBuf.length = 0;
    const lim = CONFIG.TRAIL.LINK_MAX;
    for (let i = 0; i < active.length && trailBuf.length < lim; i++) {
      const p = active[i];
      if (p.type === T.TRAIL && p.life > 0 && p.delay <= 0) trailBuf.push(p);
    }
    const n = trailBuf.length;
    if (n < 2) return;

    const D = CONFIG.TRAIL.LINK_DIST, D2 = D * D;
    ctx.globalAlpha = CONFIG.TRAIL.LINK_ALPHA;
    ctx.strokeStyle = '#4FE3FF';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = trailBuf[i];
      for (let j = i + 1; j < n; j++) {
        const b = trailBuf[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        if (dx * dx + dy * dy < D2) {
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
        }
      }
    }
    ctx.stroke();
  }

  _drawParticles(s) {
    const ctx = s.ctx;
    const active = s.active;
    for (let i = 0; i < active.length; i++) {
      const p = active[i];
      if (p.life <= 0 || p.delay > 0) continue;
      const t = clamp(p.life / p.maxLife, 0, 1);
      switch (p.type) {
        case T.TRAIL: drawTrail(ctx, p, t); break;
        case T.SHARD: drawShard(ctx, p, t); break;
        case T.GLOW: drawGlowP(ctx, p, t, this._getGlow(s, p.color)); break;
        case T.STAR: drawStar(ctx, p, t); break;
        case T.SEG: drawSeg(ctx, p, t); break;
        case T.POLYRING: drawPolyRing(ctx, p, t); break;
        case T.HEXRING: drawHexRing(ctx, p, t); break;
        case T.NET: drawNet(ctx, p); break;
        default: break;
      }
    }
  }

  /* ============================================================
     多面体绘制
     ============================================================ */
  _drawForge(s) {
    const ctx = s.ctx;
    const forge = s.forge;
    if (forge.stage < 0 || (!forge.on && forge.flash <= 0)) return;
    if (!forge.verts2d.length && !forge.edges2d.length && !forge.faces2d.length) return;

    const pal = FORGE_PALETTE[Math.max(forge.stage, 0)];
    const flashMul = forge.flash > 0 ? 2 : 1;
    const fadeOut = (!forge.on && forge.flash > 0) ? clamp(forge.flash / 0.06, 0, 1) : 1;

    /* 面（已按深度排序） */
    for (let i = 0; i < forge.faces2d.length; i++) {
      const f = forge.faces2d[i];
      if (f.pts.length < 3) continue;
      const depth = 0.5;
      const alpha = (0.04 + 0.10 * f.app) * depth * fadeOut * flashMul;
      ctx.globalAlpha = clamp(alpha, 0, 0.6);
      ctx.fillStyle = f.color;
      ctx.beginPath();
      ctx.moveTo(f.pts[0].x, f.pts[0].y);
      for (let k = 1; k < f.pts.length; k++) ctx.lineTo(f.pts[k].x, f.pts[k].y);
      ctx.closePath();
      ctx.fill();

      ctx.globalAlpha = clamp(0.30 * f.app * fadeOut * flashMul, 0, 1);
      ctx.strokeStyle = f.color;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    /* 棱边 */
    ctx.lineCap = 'round';
    for (let i = 0; i < forge.edges2d.length; i++) {
      const e = forge.edges2d[i];
      const depth = (e.a + e.b) * 0.5;
      const da = clamp((depth - 0.8) / 0.5, 0, 1);
      ctx.globalAlpha = clamp((0.25 + 0.75 * da) * fadeOut * flashMul, 0, 1);
      ctx.strokeStyle = e.color;
      ctx.lineWidth = (1 + 1.5 * da) * e.grow;
      ctx.beginPath();
      ctx.moveTo(e.x1, e.y1);
      ctx.lineTo(e.x2, e.y2);
      ctx.stroke();
    }

    /* 顶点 */
    for (let i = 0; i < forge.verts2d.length; i++) {
      const v = forge.verts2d[i];
      const da = clamp((v.s - 0.8) / 0.5, 0, 1);
      let col = pal[0];
      if (forge.stage === 5 && Math.random() < 0.03) col = '#FF4FD8';

      const sp = this._getGlow(s, col);
      const gr = v.r * (5 + forge.stage * 0.8);
      ctx.globalAlpha = clamp((0.35 + 0.45 * da) * fadeOut * flashMul, 0, 1);
      ctx.drawImage(sp, v.x - gr, v.y - gr, gr * 2, gr * 2);

      ctx.globalAlpha = clamp((0.7 + 0.3 * da) * fadeOut * flashMul, 0, 1);
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.arc(v.x, v.y, v.r * (0.85 + 0.3 * da), 0, TAU);
      ctx.fill();
    }
  }

  /* ============================================================
     渲染循环
     ============================================================ */
  update(dt, s) {
    if (!s) return;

    // —— 拖尾生成：原型写在 mousemove 里，移植后按帧用基类算好的位移/速度处理 ——
    this._emitTrail(s);

    this._updateForge(s, dt);
    this._updateWeave(s, dt);
    this._updateParticles(s, dt);
    this._updateClickTri(s, dt);
  }

  render(s) {
    if (!s) return;
    const ctx = s.ctx;

    // 清屏：原型的 setTransform 由基类在 _measure 里完成，这里只清上一帧内容；
    // 画布保持透明，绝不覆盖宿主页面。
    ctx.clearRect(0, 0, s.W, s.H);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 1;
    ctx.lineCap = 'round';

    this._drawConstellation(s);
    this._drawParticles(s);
    this._drawForge(s);
    this._drawWeave(s);
    this._drawClickTriFx(s);

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}

if (!customElements.get('cursor-geom')) {
  customElements.define('cursor-geom', CursorGeom);
}

export default CursorGeom;
