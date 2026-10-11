/**
 * 光标动效组件的基类。
 *
 * 设计前提：这是一个「光标层」组件，不是背景组件。
 *   - canvas 固定铺满视口，覆盖在宿主页面之上（position: fixed; inset: 0）；
 *   - canvas 自身 pointer-events: none，宿主页面的点击、选中、悬停完全不受影响；
 *   - 样式放在 Shadow DOM 中，既不外泄也不被宿主项目的 CSS 污染；
 *   - 监听器全部是只读的，不调用 preventDefault / stopPropagation；
 *   - 卸载时注销全部监听、取消 rAF，不留残留。
 *
 * 子类只需实现动效算法本身：
 *   setup(ctx)              初始化，返回可选的状态对象
 *   update(dt, state)       每帧更新
 *   render(state)           每帧绘制
 *   onResize(w, h)          可选，尺寸变化时回调
 *   onPointerDown(e)        可选，需要按键交互时实现
 *   onPointerUp(e)          可选
 *   onPointerLeave()        可选，光标移出窗口时回调
 *   onVisibilityChange(hidden) 可选，标签页显隐切换时回调
 *   dispose()               可选，卸载前清理
 *
 * 子类可通过类字段声明输入事件族：
 *   inputFamily = 'mouse'   监听 mousemove / mousedown / mouseup（原型中多数如此）
 *   默认 'pointer'          监听 pointermove / pointerdown / pointerup
 * 两种族的坐标与 button 语义一致，动效侧无需区分。
 */

const BASE_CSS = `
  :host {
    position: fixed;
    inset: 0;
    /* 光标层需要盖在宿主内容之上；宿主可通过 --cursor-effect-z 覆盖 */
    z-index: var(--cursor-effect-z, 2147483000);
    pointer-events: none;
    display: block;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    pointer-events: none;
    /* 背景保持透明：作为组件引入时不携带原型的深色底 */
    background: transparent;
  }
`;

/* ============================================================
   主题光标：绘制资源与全局「隐藏原生光标」样式
   ============================================================ */

/**
 * 标准鼠标箭头轮廓，热点在 (0, 0) 即左上尖端。
 * 保持箭头形态是刻意的 —— 换成雪花、火焰等异形会让用户找不到鼠标位置。
 */
const CURSOR_ARROW = [
  [0, 0], [0, 16.5], [4.2, 12.6], [6.9, 18.9], [9.6, 17.7], [6.9, 11.6], [12.2, 11.6]
];
const CURSOR_SCALE = 1.15;

/** 装饰粒子池容量（每个实例一份，与动效自己的粒子池无关） */
const CURSOR_MAXP = 900;

/**
 * 把两个颜色按 t 混合，用于悬停时描边色的平滑过渡。
 * 支持 #rgb / #rrggbb / rgb() 三种写法；解析失败时返回第二个颜色。
 */
function mixHexColor(a, b, t) {
  const pa = parseColor(a), pb = parseColor(b);
  if (!pa) return b;
  if (!pb) return a;
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return 'rgb(' + r + ',' + g + ',' + bl + ')';
}

function parseColor(c) {
  if (typeof c !== 'string') return null;
  const s = c.trim();
  if (s.charCodeAt(0) === 35) {                       // #rgb / #rrggbb
    const h = s.slice(1);
    if (h.length === 3) {
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
    }
    if (h.length === 6) {
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    return null;
  }
  const m = s.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (m) return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
  return null;
}

/* 覆盖层粒子的类型标记。
   0..3 是光标装饰（寒气/火星/电弧/墨点），4/5 是滚轮粒子（向上/向下）。 */
const WHEEL_KIND_UP = 4;
const WHEEL_KIND_DOWN = 5;

/* 滚轮势能的消耗参数 */
const WHEEL_DRAIN = 2.5;     // 每帧基础消耗量：越大效果消耗越快
const WHEEL_DECAY = 0.92;    // 每帧自然衰减系数：避免势能长时间残留
const WHEEL_MAX_PER_FRAME = 80;   // 单帧最多生成多少粒子（防极端滚动瞬间刷屏）

/**
 * 隐藏原生光标的全局样式。
 *
 * 必须用通配符覆盖所有元素：只写在 html/body 上靠继承不够 ——
 * 表单控件（input / select / textarea）在浏览器默认样式里自带 cursor: auto，
 * 不继承父级，鼠标移上去会同时露出原生图标。
 *
 * 这条样式作用于宿主页面（组件在 Shadow DOM 内管不到），所以由组件注入。
 * 多个实例共用一份，用引用计数决定何时移除。
 */
const HIDE_CURSOR_STYLE_ID = 'cursorkit-hide-cursor';
let hideCursorRefs = 0;

function acquireHideCursorStyle() {
  hideCursorRefs++;
  if (hideCursorRefs > 1) return;
  if (document.getElementById(HIDE_CURSOR_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = HIDE_CURSOR_STYLE_ID;
  style.textContent =
    'html, body, body *,' +
    'html::before, html::after, body::before, body::after,' +
    'body *::before, body *::after { cursor: none !important; }';
  (document.head || document.documentElement).appendChild(style);
}

function releaseHideCursorStyle() {
  hideCursorRefs = Math.max(0, hideCursorRefs - 1);
  if (hideCursorRefs > 0) return;
  const style = document.getElementById(HIDE_CURSOR_STYLE_ID);
  if (style && style.parentNode) style.parentNode.removeChild(style);
}

export class CursorEffectElement extends HTMLElement {
  /**
   * 监听这两个属性，使 <cursor-snow no-cursor> / no-wheel 实时生效，
   * 不需要重新挂载组件。
   */
  static get observedAttributes() {
    return ['no-cursor', 'no-wheel'];
  }

  /**
   * 声明要监听的事件族。
   *   'mouse'   —— mousemove / mousedown / mouseup（原型中多数如此）
   *   'pointer' —— pointermove / pointerdown / pointerup（默认）
   */
  // inputFamily = 'mouse';

  /**
   * 主题光标外观。子类覆写以给出自己的配色。
   * 返回 null 表示不使用主题光标。
   *
   * @returns {null | {
   *   edge?: string,          // 箭头描边色
   *   fill?: string,          // 箭头内部填充
   *   glow?: string,          // 外发光色
   *   deco?: null | {         // 围绕光标的装饰（寒气 / 火星 / 电弧 …）
   *     color: [number, number, number],   // RGB
   *     style: 'cold' | 'spark' | 'arc' | 'ink',
   *     rate?: number,        // 基础生成速率（个/秒）
   *     speedGain?: number    // 移动越快追加的速率
   *   }
   * }}
   */
  cursorTheme() {
    return null;
  }

  /**
   * 滚轮动效外观。子类覆写以给出自己的配色与**运动方式**。
   * 返回 null 表示不响应滚轮。
   *
   * 设计意图：25 套主题应该各有各的机制，不是只换颜色 ——
   * 火焰上飘、冰晶下坠、闪电折线、气泡上浮、墨点扩散、像素方块……
   * 靠下面这些参数组合出差异。
   *
   * @returns {null | {
   *   color?:  [number, number, number],   // 主色 RGB
   *   color2?: [number, number, number],   // 辅色（做层次）
   *
   *   // —— 形态 ——
   *   style?: 'puff'     柔和圆形辉光（火焰、云雾、光球…）
   *         | 'shard'    细长碎片，沿运动方向拉长（冰晶、几何体…）
   *         | 'spray'    亮芯 + 短拖尾（火星、火花、粒子…）
   *         | 'drop'     带高光的圆点（水滴、气泡、细胞…）
   *         | 'spark'    小十字星芒（星光、闪光…）
   *         | 'arc'      短促折线（闪电、电弧…）
   *         | 'ink'      柔和晕染的暗色团（水墨、烟雾…）
   *         | 'block'    方块（像素、代码…）
   *         | 'flake'    六角雪花（雪花、冰晶…）
   *   sizeMin?: number, sizeMax?: number,
   *   lifeMin?: number, lifeMax?: number,
   *
   *   // —— 运动 ——
   *   upSpeed?: number,      // 向上滚的基准初速（px/s，正值向上）
   *   downSpeed?: number,    // 向下滚的基准初速（正值向下）
   *   spread?: number,       // 横向散布（px/s）
   *   gravity?: number,      // 纵向加速度（px/s²，正值向下拉；负值上飘）
   *   drag?: number,         // 阻尼强度（每秒，越大越粘滞）
   *   turbulence?: number,   // 横向扰动强度（px/s²，做出飘忽感）
   *   spin?: number,         // 自转速度（rad/s，正值逆时针）
   *   grow?: number,         // 每秒尺寸增长（px/s，火焰散开、墨点扩散）
   *
   *   // —— 生成 ——
   *   jitter?: number,       // 生成点随机偏移（px）
   *   arcChance?: number,    // 0~1，多大比例的粒子走"折线"而不是直线（电弧感）
   *   ringChance?: number    // 0~1，多大比例在光标处生成一圈扩散的环
   * }}
   */
  wheelTheme() {
    return null;
  }

  constructor() {
    super();

    this._canvas = null;
    this._ctx = null;
    this._raf = 0;
    this._last = 0;
    this._running = false;
    this._connected = false;

    /** 子类在 setup() 中的返回值，原样传给 update / render */
    this.state = undefined;

    /* ---------- 主题光标 ---------- */
    // 默认开启；置 false 或加 no-cursor 属性可动态关闭。
    // 这里直接读一次属性：构造期 attributeChangedCallback 可能尚未触发。
    this._cursorEnabled = !(typeof this.hasAttribute === 'function' && this.hasAttribute('no-cursor'));
    this._cursorDown = false;
    /**
     * 是否已收到真实的鼠标位置。
     * 必须与 input.inside 分开：setup() 会把光标初值对齐到视口中心（为了让首帧
     * 位移计算正确），那是占位坐标、不是鼠标真实位置 —— 若直接拿它画箭头，
     * 页面刚加载、鼠标还没动时，箭头就会凭空出现在屏幕正中。
     */
    this._cursorVisible = false;

    /**
     * 悬停状态：鼠标当前悬停在什么类型的元素上。
     *
     * 不去为每个状态准备一张独立图形 —— 那样 25 套动效会膨胀成几百个图标。
     * 这里只记录「宿主元素原本期望什么光标」（pointer / text / move / …），
     * 绘制时对**已经在画的那个主题光标**做一层状态修饰（缩放、发光、描边），
     * 所以各动效零改动、零新增素材。
     *
     * 判断方式：读该元素计算样式里的 cursor 值 —— 按钮本来就是 pointer、
     * 输入框是 text、可拖拽元素是 move，因此能自动适配宿主页面，无需逐个标注。
     */
    this._hoverKind = '';
    this._hoverScale = 1;
    this._hoverGlow = 1;
    this._hoverEdge = null;
    // 平滑过渡用的当前值（避免状态切换时突然跳变）
    this._hoverScaleNow = 1;
    this._hoverGlowNow = 1;
    this._hoverEdgeNow = null;

    /* ---------- 滚轮动效 ---------- */
    // 默认开启；置 false 或加 no-wheel 属性可动态关闭
    this._wheelEnabled = !(typeof this.hasAttribute === 'function' && this.hasAttribute('no-wheel'));
    /**
     * 滚轮「势能」累计值，带符号：
     *   向上滚 → 增大（正）；向下滚 → 减小（负）。
     * 上下交替会自然抵消；即使停止滚动，这个值也会持续消耗、产出效果，
     * 直到被消耗完或自然衰减掉。方向由符号决定，强度由绝对值决定。
     */
    this._wheelAcc = 0;

    // 装饰粒子池（每个实例独立，与动效自己的粒子池互不影响）
    this._curPool = null;
    this._curAcc = 0;
    this._curSpeed = 0;

    /**
     * 光标位置与移动速度（CSS 像素），供动效读取。
     *
     * 两套锚点，语义不同，按原型口径选用：
     *   lx / ly        —— 事件级锚点：上一次移动事件的位置。
     *                     本帧只发生过一次移动时，它等于帧首位置；
     *                     一帧内多次移动时，它等于本帧倒数第二个事件的位置。
     *                     适用于原型在「移动事件里」推进锚点、并按「最后一段位移」
     *                     计算瞬时速度的动效。
     *   frameLx/frameLy —— 帧级锚点：本帧开始时的位置。
     *                     x - frameLx 即「整帧位移」，与原型在 update/emitTrail
     *                     里推进锚点（mouse.px = mouse.x）的语义一致。
     *                     适用于按帧生成拖尾、需要整帧位移的动效。
     */
    this.input = {
      x: 0,
      y: 0,
      lx: 0,
      ly: 0,
      frameLx: 0,
      frameLy: 0,
      vx: 0,
      vy: 0,
      speed: 0,
      inside: true
    };

    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onPointerCancel = this._onPointerCancel.bind(this);
    this._onBlur = this._onBlur.bind(this);
    this._onPointerLeave = this._onPointerLeave.bind(this);
    this._onPointerEnter = this._onPointerEnter.bind(this);
    this._onVisibilityChange = this._onVisibilityChange.bind(this);
    this._onContextMenu = this._onContextMenu.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onPointerOver = this._onPointerOver.bind(this);
    this._onResize = this._onResize.bind(this);
    this._tick = this._tick.bind(this);

    // 上一帧结束时的光标位置，供帧级锚点 frameLx/frameLy 使用
    this._prevFrameX = 0;
    this._prevFrameY = 0;
  }

  /* ---------- 主题光标开关（运行时动态生效） ---------- */

  /** 主题光标是否启用。赋值即可实时开关，无需重新挂载。 */
  get cursorEnabled() {
    return this._cursorEnabled;
  }

  set cursorEnabled(on) {
    const next = !!on;
    if (next === this._cursorEnabled) return;
    this._cursorEnabled = next;

    if (next) {
      if (this._connected) acquireHideCursorStyle();
      // 重新开启时清掉可能残留的装饰，避免跨开关状态串色
      this._resetCursorDeco();
    } else {
      if (this._connected) releaseHideCursorStyle();
      this._resetCursorDeco();
    }
  }

  /** 滚轮动效是否启用。赋值即可实时开关，无需重新挂载。 */
  get wheelEnabled() {
    return this._wheelEnabled;
  }

  set wheelEnabled(on) {
    const next = !!on;
    if (next === this._wheelEnabled) return;
    this._wheelEnabled = next;
    // 关闭时把已积累的势能清掉，避免重新开启后突然喷出一大片
    if (!next) this._wheelAcc = 0;
  }

  /** 属性 <cursor-xxx no-cursor> / <cursor-xxx no-wheel> 与开关联动 */
  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;
    if (name === 'no-cursor') this.cursorEnabled = (newValue === null);
    else if (name === 'no-wheel') this.wheelEnabled = (newValue === null);
  }

  _resetCursorDeco() {
    this._curAcc = 0;
    if (!this._curPool) return;
    for (let i = 0; i < this._curPool.length; i++) this._curPool[i].on = false;
  }

  connectedCallback() {
    // 防重复挂载：同一实例被移动位置时会再次触发 connectedCallback
    if (this._connected) return;
    this._connected = true;

    // Shadow DOM 隔离样式：:host 规则必须真正注入，
    // 否则宿主元素会保持 display:inline、零尺寸，canvas 无法铺满视口。
    const root = this.shadowRoot || this.attachShadow({ mode: 'open' });

    if (!root.querySelector('style')) {
      const style = document.createElement('style');
      style.textContent = BASE_CSS;
      root.appendChild(style);
    }

    this._canvas = document.createElement('canvas');
    this._canvas.setAttribute('aria-hidden', 'true');
    root.appendChild(this._canvas);

    this._ctx = this._canvas.getContext('2d');
    this._measure();

    if (typeof this.setup === 'function') {
      this.state = this.setup({
        canvas: this._canvas,
        ctx: this._ctx,
        width: this.width,
        height: this.height,
        input: this.input
      });
    }

    // setup() 可能把光标初值对齐到视口中心；帧级锚点基准必须跟着它走，
    // 否则首帧会从 (0,0) 算出一段虚假的大位移，凭空拉出一条长拖尾。
    this._prevFrameX = this.input.x;
    this._prevFrameY = this.input.y;
    this.input.frameLx = this.input.x;
    this.input.frameLy = this.input.y;

    // 主题光标：装饰粒子池按实例创建；启用时注入「隐藏原生光标」的全局样式
    this._curPool = new Array(CURSOR_MAXP);
    for (let i = 0; i < CURSOR_MAXP; i++) {
      this._curPool[i] = { on: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 1, rot: 0, rotV: 0, kind: 0 };
    }
    this._curCursor = 0;
    if (this._cursorEnabled) acquireHideCursorStyle();

    // 监听 window：光标可以移动到页面任何位置，动效需要全程跟随。
    // 事件族由 inputFamily 决定（原型中多数用 mouse*，少数用 pointer*）。
    const fam = this.inputFamily === 'mouse' ? 'mouse' : 'pointer';
    this._fam = fam;

    window.addEventListener(fam + 'move', this._onPointerMove, { passive: true });
    window.addEventListener(fam + 'down', this._onPointerDown);
    window.addEventListener(fam + 'up', this._onPointerUp);
    // 触摸/笔被系统中断时不会再收到 up，必须靠 cancel 收尾，否则蓄力态会残留
    window.addEventListener('pointercancel', this._onPointerCancel);
    window.addEventListener('blur', this._onBlur);
    window.addEventListener('resize', this._onResize);

    // 监听 document：光标移出窗口、标签页显隐切换（对应原型的 mouseleave / visibilitychange）
    document.addEventListener(fam + 'leave', this._onPointerLeave);
    document.addEventListener(fam + 'enter', this._onPointerEnter);
    document.addEventListener('visibilitychange', this._onVisibilityChange);

    // 屏蔽原生右键菜单：组件是全屏 pointer-events:none 的光标层，
    // 自身收不到任何鼠标事件，因此只能在 window 上拦截（会作用于整个页面）。
    // 原型的 contextmenu preventDefault 行为与此一致。
    window.addEventListener('contextmenu', this._onContextMenu);

    // 滚轮：passive 表示绝不拦截页面滚动，只做旁路观测。
    // 与点击、移动一样挂在 window 上，页面任何位置滚动都会响应。
    window.addEventListener('wheel', this._onWheel, { passive: true });

    // 悬停：pointerover 只在「移到新元素上」时触发（不是每次移动），
    // 所以可以放心在里面读计算样式，不会造成每帧重排。
    document.addEventListener('pointerover', this._onPointerOver, { passive: true });

    this._start();
  }

  disconnectedCallback() {
    this._connected = false;
    this._stop();

    const fam = this._fam || 'pointer';

    window.removeEventListener(fam + 'move', this._onPointerMove);
    window.removeEventListener(fam + 'down', this._onPointerDown);
    window.removeEventListener(fam + 'up', this._onPointerUp);
    window.removeEventListener('pointercancel', this._onPointerCancel);
    window.removeEventListener('blur', this._onBlur);
    window.removeEventListener('resize', this._onResize);

    document.removeEventListener(fam + 'leave', this._onPointerLeave);
    document.removeEventListener(fam + 'enter', this._onPointerEnter);
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    window.removeEventListener('contextmenu', this._onContextMenu);
    window.removeEventListener('wheel', this._onWheel);
    document.removeEventListener('pointerover', this._onPointerOver);

    // 主题光标：卸载时释放全局样式引用（引用归零才真正移除）
    if (this._cursorEnabled) releaseHideCursorStyle();
    this._resetCursorDeco();

    if (typeof this.dispose === 'function') this.dispose();

    // 释放画布引用，避免同一实例再次挂载时拿到失效上下文
    if (this._canvas && this._canvas.parentNode) {
      this._canvas.parentNode.removeChild(this._canvas);
    }
    this._canvas = null;
    this._ctx = null;
  }

  /* ---------- 尺寸 ---------- */

  /**
   * 按容器尺寸与设备像素比重设画布缓冲。
   * 设备像素比不为 1 时缩放上下文，使动效统一使用 CSS 像素坐标，
   * 避免在高分屏上出现模糊或尺寸翻倍。
   * 与原型一致，DPR 封顶在 2：3x 屏上再翻倍只会徒增填充率，画质收益极小。
   */
  _measure() {
    if (!this._canvas) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.clientWidth || window.innerWidth || 1;
    const h = this.clientHeight || window.innerHeight || 1;

    this.width = w;
    this.height = h;
    this.dpr = dpr;

    this._canvas.width = Math.max(1, Math.floor(w * dpr));
    this._canvas.height = Math.max(1, Math.floor(h * dpr));

    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _onResize() {
    if (!this._canvas) return;

    const prevW = this.width;
    const prevH = this.height;
    this._measure();

    if (typeof this.onResize === 'function') {
      this.onResize(this.width, this.height, prevW, prevH);
    }
  }

  /* ---------- 输入 ---------- */

  _onPointerMove(e) {
    const inp = this.input;

    // 收到真实鼠标位置，允许绘制主题光标
    this._cursorVisible = true;

    // 光标进入页面时，先把上一帧位置对齐，避免从 (0,0) 拉出一条长拖尾
    if (!inp.inside) {
      inp.x = inp.lx = e.clientX;
      inp.y = inp.ly = e.clientY;
      inp.vx = inp.vy = inp.speed = 0;
      // 必须在此置位：否则每次移动都会被判为「刚进入」，
      // lx/ly 恒等于当前位置，速度永远为 0，拖尾不会生成。
      inp.inside = true;
      return;
    }

    inp.lx = inp.x;
    inp.ly = inp.y;
    inp.x = e.clientX;
    inp.y = e.clientY;
  }

  _onPointerDown(e) {
    this._cursorDown = true;
    if (typeof this.onPointerDown === 'function') this.onPointerDown(e);
  }

  _onPointerUp(e) {
    this._cursorDown = false;
    if (typeof this.onPointerUp === 'function') this.onPointerUp(e);
  }

  /**
   * 触摸/笔被系统中断时不会再收到 up，必须靠 cancel 收尾。
   * 默认走与失焦相同的收尾路径（取消蓄力），动效可覆写 onPointerCancel。
   */
  _onPointerCancel(e) {
    if (typeof this.onPointerCancel === 'function') this.onPointerCancel(e);
    else if (typeof this.onBlur === 'function') this.onBlur();
  }

  _onBlur() {
    // 失焦时按键状态会丢失，交由动效自行收尾
    if (typeof this.onBlur === 'function') this.onBlur();
  }

  _onPointerLeave() {
    // 光标移出窗口：标记离开并通知动效（原型在此取消蓄力）
    this.input.inside = false;
    this._cursorVisible = false;
    // 悬停状态一并清掉，移回来时重新判定
    this._applyHover('');
    if (typeof this.onPointerLeave === 'function') this.onPointerLeave();
  }

  _onPointerEnter() {
    // 重新进入时保持上一帧位置，由 _onPointerMove 的 inside 分支完成对齐
    this.input.inside = true;
  }

  _onVisibilityChange() {
    // 标签页隐藏时 rAF 本身会停摆，这里只需让动效收尾按键状态
    if (typeof this.onVisibilityChange === 'function') {
      this.onVisibilityChange(document.hidden);
    }
    // 恢复可见时重置计时基准，避免累计出一个巨大的 dt
    if (!document.hidden) this._last = performance.now();
  }

  /**
   * 屏蔽原生右键菜单，让右键长按蓄力不被打断。
   *
   * 保留一个逃生出口：按住 Shift / Ctrl / Cmd 右键时放行原生菜单，
   * 否则使用者将完全无法唤出浏览器菜单。这是通行做法。
   */
  _onContextMenu(e) {
    if (e.shiftKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
  }

  /**
   * 滚轮：把滚动量累加进带符号的「势能」。
   *
   * 这里只做累加，不直接产生效果 —— 效果由每帧按消耗率从势能里支取，
   * 所以快速滚动会变成一次持续喷发，慢慢滚则是细水长流；
   * 上下交替滚动会自然抵消（符号相反）。
   *
   * 注意 deltaY 的符号：向上滚为负，所以取反后「向上 = 正」。
   * 监听器是 passive 的，绝不 preventDefault，页面滚动完全不受影响。
   */
  _onWheel(e) {
    if (!this._wheelEnabled) return;
    if (typeof this.wheelTheme !== 'function' || !this.wheelTheme()) return;

    // 不同设备/浏览器给的单位不同：0=像素，1=行，2=页。
    // 换算成像素再累加，避免触控板与滚轮鼠标的量级差出几十倍。
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;         // 行 → 约 16px
    else if (e.deltaMode === 2) dy *= 100;   // 页 → 约 100px

    // 上限防止一次超大滚动（或程序化滚动）把势能顶到离谱的值
    const MAX = 2000;
    this._wheelAcc = Math.max(-MAX, Math.min(MAX, this._wheelAcc - dy));
  }

  /**
   * 悬停检测：鼠标移到新元素上时，判断它期望什么光标，
   * 据此给主题光标套一层状态修饰。
   *
   * 优先读计算样式的 cursor 值；但它通常被组件自己注入的全局
   * `cursor: none !important` 覆盖，所以再补一层按标签与属性的语义判断 ——
   * 按钮、链接、输入框、可拖拽元素这些在宿主页面里本来就有约定。
   *
   * pointerover 只在跨越元素边界时触发，不是每次移动都触发，
   * 因此这里的 getComputedStyle 不会造成每帧重排。
   */
  _onPointerOver(e) {
    if (!this._cursorEnabled) return;

    let el = e.target;
    if (!el || el.nodeType !== 1) return;
    // 组件自己的宿主元素不算（虽然它是 pointer-events:none，正常不会被命中）
    if (el === this) return;

    let kind = '';
    // 向上找最近的、有交互语义的祖先
    for (let depth = 0; el && el.nodeType === 1 && depth < 6; depth++) {
      const cs = getComputedStyle(el);
      if (cs.pointerEvents === 'none') break;

      const c = cs.cursor;
      if (c && c !== 'none' && c !== 'auto' && c !== 'default' && c !== 'inherit') {
        if (c === 'pointer') kind = 'pointer';
        else if (c === 'text') kind = 'text';
        else if (c === 'move' || c === 'grab' || c === 'grabbing') kind = 'move';
        else if (c === 'crosshair') kind = 'crosshair';
        else if (c === 'help') kind = 'help';
        else kind = 'pointer';
        break;
      }

      // 语义兜底：宿主页面可能把 cursor 写在更外层，或用了别的写法
      const tag = el.tagName;
      if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY' ||
          el.hasAttribute('role') && el.getAttribute('role') === 'button') { kind = 'pointer'; break; }
      if (tag === 'INPUT') {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (t === 'text' || t === 'search' || t === 'email' || t === 'tel' ||
            t === 'url' || t === 'password' || t === 'number') { kind = 'text'; break; }
        kind = 'pointer'; break;
      }
      if (tag === 'TEXTAREA' || el.isContentEditable) { kind = 'text'; break; }
      if (tag === 'SELECT') { kind = 'pointer'; break; }
      if (tag === 'LABEL') { kind = 'pointer'; break; }
      if (el.hasAttribute('draggable') && el.getAttribute('draggable') !== 'false') { kind = 'move'; break; }

      el = el.parentElement;
    }

    this._applyHover(kind);
  }

  /** 按悬停类型设定目标修饰值（实际绘制时会平滑过渡过去） */
  _applyHover(kind) {
    if (kind === this._hoverKind) return;
    this._hoverKind = kind;

    const MAP = {
      pointer:   { scale: 1.16, glow: 1.9,  edge: '#ffffff' },
      text:      { scale: 0.88, glow: 0.7,  edge: '#9fd8ff' },
      move:      { scale: 1.08, glow: 1.4,  edge: '#ffd166' },
      crosshair: { scale: 1.02, glow: 1.5,  edge: '#8ff0ff' },
      help:      { scale: 1.12, glow: 1.6,  edge: '#c9a6ff' }
    };
    const p = MAP[kind];
    if (p) {
      this._hoverScale = p.scale;
      this._hoverGlow = p.glow;
      this._hoverEdge = p.edge;
    } else {
      this._hoverScale = 1;
      this._hoverGlow = 1;
      this._hoverEdge = null;
    }
  }

  /* ---------- 循环 ---------- */

  _start() {
    if (this._running) return;
    this._running = true;
    this._last = performance.now();
    this._raf = requestAnimationFrame(this._tick);
  }

  _stop() {
    this._running = false;
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
    }
  }

  _tick(now) {
    if (!this._running) return;
    this._raf = requestAnimationFrame(this._tick);

    // 标签页隐藏期间不做任何更新，省电并避免状态漂移
    if (document.hidden) {
      this._last = now;
      return;
    }

    // 切标签页回来时 now - last 会非常大，限制在 1/20 秒以内防止物理爆炸
    const dt = Math.min((now - this._last) / 1000, 0.05) || 0.016;
    this._last = now;

    // 帧级锚点 = 上一帧结束时的光标位置，用于计算「整帧位移」：x - frameLx。
    // 必须在 update 之前赋值（此时 inp.x 已被本帧移动事件更新为本帧末位置）。
    //
    // 注意两点，写错会让依赖它的拖尾生成完全失效或位移偏大：
    //   1. 不能写成 inp.frameLx = inp.x —— 差值恒为 0，拖尾全堆在一点；
    //   2. 不能用 inp.lx 代替 —— lx 是「本帧倒数第二个事件」的位置（事件级锚点），
    //      会多算帧间那一段位移。
    const inp = this.input;
    inp.frameLx = this._prevFrameX;
    inp.frameLy = this._prevFrameY;
    this._prevFrameX = inp.x;
    this._prevFrameY = inp.y;

    this._updateInput(dt);

    // 先更新，再绘制
    if (typeof this.update === 'function') this.update(dt, this.state);
    if (typeof this.render === 'function') this.render(this.state);

    // 主题光标与滚轮动效画在最后 —— 必须盖在动效之上，
    // 否则会被拖尾、粒子埋掉。两者共用一个粒子池与一次遍历。
    this._renderOverlay(dt);

    // 帧末记录事件级锚点：供下一帧计算「最后一段位移」的速度
    inp.lx = inp.x;
    inp.ly = inp.y;
  }

  /* ============================================================
     主题光标：自绘箭头 + 围绕装饰
     ============================================================ */

  /**
   * 每帧绘制「覆盖层」：主题光标 + 滚轮动效。
   * 两者都关掉、或都无主题时直接返回，动效本身照常运行。
   */
  _renderOverlay(dt) {
    if (!this._ctx) return;

    const cursorTheme = (this._cursorEnabled && typeof this.cursorTheme === 'function')
      ? this.cursorTheme() : null;
    const wheelTheme = (this._wheelEnabled && typeof this.wheelTheme === 'function')
      ? this.wheelTheme() : null;

    if (!cursorTheme && !wheelTheme) return;

    const ctx = this._ctx;
    const inp = this.input;

    // 光标速度：按帧位移平滑，仅用于控制装饰密度
    const dx = inp.x - inp.lx;
    const dy = inp.y - inp.ly;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const iv = dt > 0 ? dist / dt : 0;
    const sm = 1 - Math.exp(-25 * dt);
    this._curSpeed += (iv - this._curSpeed) * sm;

    if (cursorTheme && this._cursorVisible && inp.inside) this._emitCursorDeco(dt, cursorTheme);
    if (wheelTheme) this._emitWheel(dt, wheelTheme);
    this._updateOverlayParticles(dt);

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;

    // 粒子先画（在箭头下层）
    for (let i = 0; i < CURSOR_MAXP; i++) {
      const p = this._curPool[i];
      if (!p.on) continue;
      // 滚轮粒子单独绘制，语义与光标装饰不同
      if (p.kind === WHEEL_KIND_UP || p.kind === WHEEL_KIND_DOWN) {
        if (wheelTheme) this._drawWheelParticle(ctx, p, wheelTheme);
      } else if (cursorTheme) {
        this._drawCursorDeco(ctx, p, cursorTheme);
      }
    }

    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;

    if (cursorTheme && this._cursorVisible && inp.inside) {
      this._drawCursorArrow(ctx, inp.x, inp.y, cursorTheme, dt);
    }
  }

  /** 绘制箭头本体：保持标准轮廓，只让描边、填充、发光跟随主题与悬停状态 */
  _drawCursorArrow(ctx, x, y, theme, dt) {
    // 悬停修饰平滑过渡：避免在元素边界来回移动时缩放与颜色突变
    const sm = 1 - Math.exp(-16 * (dt || 0.016));
    this._hoverScaleNow += (this._hoverScale - this._hoverScaleNow) * sm;
    this._hoverGlowNow  += (this._hoverGlow  - this._hoverGlowNow)  * sm;

    const baseEdge = theme.edge || '#ffffff';
    // 描边色朝悬停色靠拢
    if (this._hoverEdge) {
      const want = mixHexColor(baseEdge, this._hoverEdge, 0.55);
      this._hoverEdgeNow = this._hoverEdgeNow
        ? mixHexColor(this._hoverEdgeNow, want, sm)
        : want;
    } else if (this._hoverEdgeNow) {
      this._hoverEdgeNow = mixHexColor(this._hoverEdgeNow, baseEdge, sm);
    }

    const edge = this._hoverEdgeNow || baseEdge;
    const k = CURSOR_SCALE * this._hoverScaleNow * (this._cursorDown ? 0.92 : 1);
    const fill = theme.fill || 'rgba(10,14,22,.85)';
    const glow = theme.glow || baseEdge;

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(k, k);

    ctx.beginPath();
    for (let i = 0; i < CURSOR_ARROW.length; i++) {
      const px = CURSOR_ARROW[i][0];
      const py = CURSOR_ARROW[i][1];
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath();

    // 外发光 + 填充（发光强度随悬停状态变化）
    ctx.globalCompositeOperation = 'lighter';
    ctx.shadowColor = glow;
    ctx.shadowBlur = 12 * this._hoverGlowNow;
    ctx.fillStyle = fill;
    ctx.fill();

    // 主题色描边
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowBlur = 6 * this._hoverGlowNow;
    ctx.strokeStyle = edge;
    ctx.lineWidth = 1.6 * (1 + (this._hoverScaleNow - 1) * 0.3);
    ctx.lineJoin = 'round';
    ctx.stroke();

    // 内侧再描一层浅色，让箭头更实、更有立体感
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,.5)';
    ctx.lineWidth = 0.6;
    ctx.stroke();

    ctx.restore();
  }

  /** 生成装饰粒子：速率随移动速度提升，静止时仍有少量 */
  _emitCursorDeco(dt, theme) {
    const deco = theme.deco;
    if (!deco || !deco.color) return;

    const rate = (deco.rate || 14) + Math.min(this._curSpeed * (deco.speedGain || 0.22), 90);
    this._curAcc += rate * dt;
    let n = this._curAcc | 0;
    this._curAcc -= n;
    if (n > 24) n = 24;

    const inp = this.input;

    for (let i = 0; i < n; i++) {
      const p = this._nextCursorParticle();
      p.on = true;
      p.life = 0;

      if (deco.style === 'cold') {
        // 寒气：在光标下方缓缓飘落
        p.kind = 0;
        p.x = inp.x + (Math.random() - 0.5) * 34;
        p.y = inp.y + (Math.random() - 0.2) * 22;
        p.vx = (Math.random() - 0.5) * 16;
        p.vy = 10 + Math.random() * 26;
        p.size = 1 + Math.random() * 2.4;
        p.maxLife = 0.5 + Math.random() * 0.7;
        p.rotV = 0;
      } else if (deco.style === 'spark') {
        // 火星：向上飘散
        p.kind = 1;
        p.x = inp.x + (Math.random() - 0.5) * 26;
        p.y = inp.y + (Math.random() - 0.5) * 20;
        p.vx = (Math.random() - 0.5) * 46;
        p.vy = -(30 + Math.random() * 70);
        p.size = 0.9 + Math.random() * 1.8;
        p.maxLife = 0.35 + Math.random() * 0.5;
        p.rotV = 0;
      } else if (deco.style === 'arc') {
        // 电弧：短促折线，瞬间消失
        p.kind = 2;
        p.x = inp.x + (Math.random() - 0.5) * 20;
        p.y = inp.y + (Math.random() - 0.5) * 20;
        p.vx = (Math.random() - 0.5) * 10;
        p.vy = (Math.random() - 0.5) * 10;
        p.size = 5 + Math.random() * 9;
        p.maxLife = 0.10 + Math.random() * 0.12;
        p.rot = Math.random() * Math.PI * 2;
        p.rotV = 0;
      } else {
        // 墨点：缓慢扩散下沉
        p.kind = 3;
        p.x = inp.x + (Math.random() - 0.5) * 24;
        p.y = inp.y + (Math.random() - 0.5) * 20;
        p.vx = (Math.random() - 0.5) * 14;
        p.vy = 6 + Math.random() * 20;
        p.size = 2 + Math.random() * 5;
        p.maxLife = 0.6 + Math.random() * 0.8;
        p.rot = Math.random() * Math.PI * 2;
        p.rotV = (Math.random() - 0.5) * 1.2;
      }
    }
  }

  /**
   * 滚轮动效：从「势能」里按消耗率支取，逐帧生成粒子。
   *
   * 势能是带符号的累计值（向上为正）。这里每帧：
   *   1. 自然衰减一点（避免长期残留）；
   *   2. 按绝对值决定消耗速率 —— 滚得越猛，消耗越快、喷发越强；
   *   3. 按符号决定方向，按消耗量决定粒子数；
   *   4. 每发一个粒子就从势能里扣掉一个单位。
   *
   * 效果总量因此正比于累计值：滚到 1000 会陆续发出约 1000/WHEEL_DRAIN 个粒子，
   * 而不是一瞬间全放出来。
   */
  _emitWheel(dt, theme) {
    let acc = this._wheelAcc;

    // 自然衰减
    acc *= WHEEL_DECAY;

    const mag = Math.abs(acc);
    if (mag < 0.5) { this._wheelAcc = 0; return; }

    // 消耗速率随势能增强，但有上限；每帧至少消耗一点，保证最终会耗尽
    const rate = Math.min(mag * 0.18, 60) + WHEEL_DRAIN;
    const consume = rate * dt;

    let n = Math.floor(consume / WHEEL_DRAIN);
    if (n < 1) n = 1;
    if (n > WHEEL_MAX_PER_FRAME) n = WHEEL_MAX_PER_FRAME;

    const spent = n * WHEEL_DRAIN;
    const up = acc > 0;
    acc -= up ? spent : -spent;
    // 消耗可能跨过零点（反向），钳住避免符号乱跳
    if (up && acc < 0) acc = 0;
    if (!up && acc > 0) acc = 0;
    this._wheelAcc = acc;

    const inp = this.input;
    const jitter = theme.jitter == null ? 8 : theme.jitter;
    const sizeMin = theme.sizeMin == null ? 2 : theme.sizeMin;
    const sizeMax = theme.sizeMax == null ? 5 : theme.sizeMax;
    const lifeMin = theme.lifeMin == null ? 0.35 : theme.lifeMin;
    const lifeMax = theme.lifeMax == null ? 0.8 : theme.lifeMax;
    const upSpeed = theme.upSpeed == null ? 220 : theme.upSpeed;
    const downSpeed = theme.downSpeed == null ? 220 : theme.downSpeed;
    const spread = theme.spread == null ? 90 : theme.spread;
    const gravity = theme.gravity == null ? 0 : theme.gravity;
    const drag = theme.drag == null ? 0 : theme.drag;
    const turb = theme.turbulence == null ? 0 : theme.turbulence;
    const spin = theme.spin == null ? 0 : theme.spin;
    const grow = theme.grow == null ? 0 : theme.grow;
    const arcChance = theme.arcChance == null ? 0 : theme.arcChance;

    for (let i = 0; i < n; i++) {
      const p = this._nextCursorParticle();
      p.on = true;
      p.life = 0;
      p.kind = up ? WHEEL_KIND_UP : WHEEL_KIND_DOWN;
      p.x = inp.x + (Math.random() - 0.5) * jitter * 2;
      p.y = inp.y + (Math.random() - 0.5) * jitter * 2;
      p.vx = (Math.random() - 0.5) * spread;
      // 向上滚 → 粒子向上（屏幕坐标 y 减小）
      const base = up ? -upSpeed : downSpeed;
      p.vy = base * (0.55 + Math.random() * 0.9);
      p.size = sizeMin + Math.random() * (sizeMax - sizeMin);
      p.maxLife = lifeMin + Math.random() * (lifeMax - lifeMin);
      p.rot = Math.random() * Math.PI * 2;
      p.rotV = (Math.random() - 0.5) * 2 * spin;

      // 逐粒子的运动参数（存在粒子上，绘制与更新时读取）
      p.wGrav = gravity;
      p.wDrag = drag;
      p.wTurb = turb;
      p.wGrow = grow;
      // 一部分粒子走折线，做出电弧感
      p.wArc = Math.random() < arcChance;
      // 双色随机取用，做层次（不用 rotV 判断，避免与自转耦合）
      p.wAlt = Math.random() < 0.45;
    }
  }

  /** 绘制滚轮粒子。flame 走柔和的圆形辉光，其余走亮芯 + 拖尾。 */
  _drawWheelParticle(ctx, p, theme) {
    const c1 = theme.color || [255, 170, 80];
    const c2 = theme.color2 || c1;
    // 双色交替取用，做出层次
    const c = p.wAlt ? c2 : c1;

    const k = p.life / p.maxLife;
    const a = 1 - k;
    const style = theme.style || 'puff';
    const rgba = (al) => 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + al.toFixed(3) + ')';

    if (style === 'puff') {
      // 柔和圆形辉光，中心偏白：火焰、云雾、光球
      ctx.globalCompositeOperation = 'lighter';
      const r = p.size * (1 + k * 0.7);
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      g.addColorStop(0, 'rgba(255,255,255,' + (a * 0.5).toFixed(3) + ')');
      g.addColorStop(0.35, rgba(a * 0.6));
      g.addColorStop(1, rgba(0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, 6.2832);
      ctx.fill();

    } else if (style === 'spray') {
      // 亮芯 + 短拖尾：火星、火花
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = rgba(a * 0.75);
      ctx.lineWidth = p.size * 0.8;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.vx * 0.02, p.y - p.vy * 0.02);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,' + (a * 0.85).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * 0.55, 0, 6.2832);
      ctx.fill();

    } else if (style === 'shard') {
      // 细长碎片，沿运动方向拉长并自转：冰晶、几何体
      ctx.globalCompositeOperation = 'lighter';
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = rgba(a * 0.85);
      const L = p.size * 2.6, W = p.size * 0.55;
      ctx.beginPath();
      ctx.moveTo(0, -L);
      ctx.lineTo(W, 0);
      ctx.lineTo(0, L);
      ctx.lineTo(-W, 0);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,' + (a * 0.45).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(0, 0, W * 0.7, 0, 6.2832);
      ctx.fill();
      ctx.restore();

    } else if (style === 'drop') {
      // 带高光的圆点：水滴、气泡、细胞
      ctx.globalCompositeOperation = 'lighter';
      const r = p.size * 0.9;
      const g = ctx.createRadialGradient(p.x - r * 0.3, p.y - r * 0.3, 0, p.x, p.y, r);
      g.addColorStop(0, 'rgba(255,255,255,' + (a * 0.9).toFixed(3) + ')');
      g.addColorStop(0.5, rgba(a * 0.7));
      g.addColorStop(1, rgba(a * 0.25));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, 6.2832);
      ctx.fill();

    } else if (style === 'spark') {
      // 十字星芒：星光、闪光
      ctx.globalCompositeOperation = 'lighter';
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.strokeStyle = rgba(a * 0.9);
      ctx.lineWidth = p.size * 0.35;
      ctx.lineCap = 'round';
      const L = p.size * 1.9;
      ctx.beginPath();
      ctx.moveTo(-L, 0); ctx.lineTo(L, 0);
      ctx.moveTo(0, -L); ctx.lineTo(0, L);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,' + (a * 0.9).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(0, 0, p.size * 0.45, 0, 6.2832);
      ctx.fill();
      ctx.restore();

    } else if (style === 'arc') {
      // 短促折线：闪电、电弧
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = rgba(a * 0.95);
      ctx.lineWidth = Math.max(1, p.size * 0.3);
      ctx.lineCap = 'round';
      const ca = Math.cos(p.rot), sa = Math.sin(p.rot);
      const L = p.size * 3.2;
      const steps = 4;
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const f = i / steps;
        // 折线在运动方向上延伸，横向随机抖动
        const off = (Math.random() - 0.5) * p.size * 0.7;
        const px = p.x - ca * L * f - sa * off;
        const py = p.y - sa * L * f + ca * off;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();

    } else if (style === 'block') {
      // 方块：像素、代码
      ctx.globalCompositeOperation = 'lighter';
      const s = p.size * 0.9;
      ctx.fillStyle = rgba(a * 0.9);
      ctx.fillRect(p.x - s, p.y - s, s * 2, s * 2);
      ctx.fillStyle = 'rgba(255,255,255,' + (a * 0.35).toFixed(3) + ')';
      ctx.fillRect(p.x - s, p.y - s, s, s);

    } else if (style === 'flake') {
      // 六角雪花：雪花、冰晶
      ctx.globalCompositeOperation = 'lighter';
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.strokeStyle = rgba(a * 0.9);
      ctx.lineWidth = Math.max(0.8, p.size * 0.22);
      ctx.lineCap = 'round';
      const L = p.size * 1.5;
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * 6.2832;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(ca * L, sa * L);
        // 分叉
        ctx.moveTo(ca * L * 0.62, sa * L * 0.62);
        ctx.lineTo(ca * L * 0.62 - sa * L * 0.22, sa * L * 0.62 + ca * L * 0.22);
        ctx.moveTo(ca * L * 0.62, sa * L * 0.62);
        ctx.lineTo(ca * L * 0.62 + sa * L * 0.22, sa * L * 0.62 - ca * L * 0.22);
        ctx.stroke();
      }
      ctx.restore();

    } else {
      // ink：柔和晕染的暗色团
      ctx.globalCompositeOperation = 'source-over';
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 2);
      g.addColorStop(0, rgba(a * 0.45));
      g.addColorStop(0.6, rgba(a * 0.2));
      g.addColorStop(1, rgba(0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * 2, 0, 6.2832);
      ctx.fill();
    }
  }

  _nextCursorParticle() {
    const pool = this._curPool;
    for (let i = 0; i < 64; i++) {
      const p = pool[this._curCursor];
      this._curCursor = (this._curCursor + 1) % CURSOR_MAXP;
      if (!p.on) return p;
    }
    const p = pool[this._curCursor];
    this._curCursor = (this._curCursor + 1) % CURSOR_MAXP;
    return p;
  }

  /** 推进覆盖层粒子（光标装饰 + 滚轮粒子共用一次遍历） */
  _updateOverlayParticles(dt) {
    const pool = this._curPool;
    for (let i = 0; i < CURSOR_MAXP; i++) {
      const p = pool[i];
      if (!p.on) continue;
      p.life += dt;
      if (p.life >= p.maxLife) { p.on = false; continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.rotV * dt;

      if (p.kind === 1) p.vy -= 24 * dt;                  // 火星继续上飘
      if (p.kind === 3) { p.vx *= 0.985; p.vy *= 0.99; }  // 墨点减速
      if (p.kind === WHEEL_KIND_UP || p.kind === WHEEL_KIND_DOWN) {
        // 滚轮粒子：按各自的参数推进，让 25 套主题运动方式不同
        if (p.wDrag) {
          const d = Math.exp(-p.wDrag * dt);
          p.vx *= d; p.vy *= d;
        }
        if (p.wGrav) p.vy += p.wGrav * dt;
        if (p.wTurb) p.vx += (Math.random() - 0.5) * p.wTurb * dt * 8;
        if (p.wGrow) p.size += p.wGrow * dt;
        // 默认给一点纵向延续，避免粒子刚出就停住
        if (!p.wGrav) p.vy += (p.kind === WHEEL_KIND_UP ? -120 : 120) * dt;
      }
    }
  }

  _drawCursorDeco(ctx, p, theme) {
    const c = theme.deco && theme.deco.color;
    if (!c) return;

    const k = p.life / p.maxLife;
    const a = 1 - k;

    if (p.kind === 0) {
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size * 3);
      g.addColorStop(0, 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (a * 0.75).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * 3, 0, 6.2832);
      ctx.fill();
    } else if (p.kind === 1) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (a * 0.7).toFixed(3) + ')';
      ctx.lineWidth = p.size * 0.9;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.vx * 0.02, p.y - p.vy * 0.02 - p.size * 0.4);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,' + (a * 0.9).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * 0.7, 0, 6.2832);
      ctx.fill();
    } else if (p.kind === 2) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (a * 0.95).toFixed(3) + ')';
      ctx.lineWidth = 1.3;
      ctx.lineCap = 'round';
      const ca = Math.cos(p.rot), sa = Math.sin(p.rot);
      ctx.beginPath();
      for (let i = 0; i <= 3; i++) {
        const f = i / 3;
        const off = (Math.random() - 0.5) * p.size * 0.5;
        const px = p.x + ca * p.size * f - sa * off;
        const py = p.y + sa * p.size * f + ca * off;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    } else {
      ctx.globalCompositeOperation = 'source-over';
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size);
      g.addColorStop(0, 'rgba(10,14,22,' + (a * 0.55).toFixed(3) + ')');
      g.addColorStop(0.7, 'rgba(30,40,58,' + (a * 0.30).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(30,40,58,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, 6.2832);
      ctx.fill();
    }
  }

  /**
   * 刷新光标速度。
   * 与原型的 update() 开头逐行对齐，包含两项保护：
   *   - 帧位移超过 300px 视为位置跳变（切换窗口、显示器变更），速度归零防爆量；
   *   - 速度封顶 6000，避免极端情况下生成速率失控。
   */
  _updateInput(dt) {
    const inp = this.input;
    const dx = inp.x - inp.lx;
    const dy = inp.y - inp.ly;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > 300) {
      inp.vx = 0;
      inp.vy = 0;
      inp.speed = 0;
      return;
    }

    if (dt > 0) {
      const ivx = dx / dt;
      const ivy = dy / dt;
      const sm = 1 - Math.exp(-25 * dt);
      inp.vx += (ivx - inp.vx) * sm;
      inp.vy += (ivy - inp.vy) * sm;

      let speed = Math.sqrt(inp.vx * inp.vx + inp.vy * inp.vy);
      if (speed > 6000) speed = 6000;
      inp.speed = speed;
    }
  }
}
