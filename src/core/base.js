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

export class CursorEffectElement extends HTMLElement {
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
    this._onResize = this._onResize.bind(this);
    this._tick = this._tick.bind(this);

    // 上一帧结束时的光标位置，供帧级锚点 frameLx/frameLy 使用
    this._prevFrameX = 0;
    this._prevFrameY = 0;
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
    if (typeof this.onPointerDown === 'function') this.onPointerDown(e);
  }

  _onPointerUp(e) {
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

    // 帧末记录事件级锚点：供下一帧计算「最后一段位移」的速度
    inp.lx = inp.x;
    inp.ly = inp.y;
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
