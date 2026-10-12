/**
 * 自定义下拉。
 *
 * 为什么不用原生 `<select>`：原生下拉的弹出面板由浏览器绘制，样式完全不可控，
 * 与宿主控件的外观对不上。
 *
 * 为什么不用宿主现成的 `Menu`：官方规范（`practices.md:35`）明令禁止
 * `import '@deepseek-ai/dsh-client-ui-primitives'` —— 那会成为运行时依赖，
 * 而这些包「change without notice」，且浏览器模块表里本来也没有它们。
 * 规范给出的替代方案是**把 primitive 的标记/CSS/行为抄进插件**。本文件就是
 * 那个替代品：行为逐条对应 `dsh-client-ui-primitives/lib/index.js` 的 `Menu`
 * （3927–4273 行），CSS 对应 `lib/Menu.module.css` 与 `lib/MenuSurface.module.css`。
 *
 * ── 弹层策略（照抄，未偏离）────────────────────────────────────────────
 * `Menu.module.css:37-46` 的 `.portal` 写明了做法与理由：
 *
 *   「Portal mode: fixed in the viewport, coordinates supplied inline from the
 *     anchor rect (side/align resolved in JS, the in-place offset rules above
 *     don't apply). Portaled lists must layer above modal overlays (z 1000) —
 *     an anchor inside a dialog still expects its menu on top.」
 *
 * 即 `createPortal` 到 `document.body` + `position: fixed` + `z-index: 1100`
 * + 用 `getBoundingClientRect()` 在 JS 里算坐标。设置行恰好同时踩中两个坑：
 * 它在 `position: fixed; z-index: 1000` 的设置 dialog 里，外层还是可滚动容器。
 * body portal 一次性解决「被 overflow 裁剪」与「被 dialog 盖住」。
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';

export interface DropdownOption {
  readonly id: string;
  readonly label: string;
}

export interface DropdownProps {
  /** 弹层的无障碍名称（触发按钮沿用其可见文本，与宿主 `LanguageRow` 一致）。 */
  readonly label: string;
  /** 当前选中项的 id。 */
  readonly value: string;
  readonly options: readonly DropdownOption[];
  readonly onSelect: (id: string) => void;
}

interface FixedPos {
  readonly left: number;
  readonly top: number;
}

/** 弹层与视口边缘至少保留的间距，与宿主 `Menu` 的 `MARGIN` 一致。 */
const MARGIN = 12;

/** 弹层与触发按钮之间的间距，与宿主 `Menu` 的 `+ 4` 一致。 */
const GAP = 4;

/** 未定位时的测量样式：隐藏但仍参与布局，`offsetWidth/Height` 才是真实值。 */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 };

/**
 * 视口上边距。
 *
 * 桌面端窗口顶部有一条预留条（`--dsh-frame-top-clearance`），弹层不能压进去；
 * 全屏时只保留 20px 间隔。照抄宿主 `Menu` 的同名函数
 * （`primitives/lib/index.js:3550`）。
 */
function overlayTopMargin(min: number): number {
  const root = document.documentElement;
  const clearance = Number.parseFloat(
    getComputedStyle(root).getPropertyValue('--dsh-frame-top-clearance'),
  );
  if (Number.isNaN(clearance)) return min;
  return Math.max(min, (root.hasAttribute('data-fullscreen') ? 0 : clearance) + 20);
}

/** 视为「用户开始了键盘导航」的按键；命中即撤销无环聚焦的状态。 */
const NAVIGATION_KEYS = new Set([
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'Enter',
  ' ',
  'Escape',
]);

/**
 * 把焦点交给元素但不显示焦点环。
 *
 * 照抄宿主（`primitives/lib/index.js:3648`）的机制：给元素打上
 * `data-dsh-automatic-focus`，主题里的**全局**规则
 * （`dsh-client-ui-theme/lib/client.js:1142`）
 * `[data-dsh-automatic-focus]:focus, [...]:focus:focus-visible { outline:none }`
 * 会压掉 outline；一旦失焦或用户重新用键盘导航就摘掉标记，恢复正常焦点样式。
 */
function focusWithoutRing(element: HTMLElement): void {
  function release(): void {
    element.removeAttribute('data-dsh-automatic-focus');
    element.removeEventListener('blur', release);
    element.removeEventListener('keydown', navigate, true);
  }
  function navigate(event: KeyboardEvent): void {
    if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
    if (NAVIGATION_KEYS.has(event.key)) release();
  }
  element.setAttribute('data-dsh-automatic-focus', '');
  element.addEventListener('blur', release);
  element.addEventListener('keydown', navigate, true);
  element.focus();
  if (!element.matches(':focus')) release();
}

/** 宿主 `IconChevronDownOutlineRegular` 的路径（`primitives/lib/index.js:482-495`）。 */
function ChevronIcon(): ReactElement {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      strokeWidth={1}
    >
      <path
        d="M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6"
        stroke="currentColor"
      />
    </svg>
  );
}

/** 宿主 `IconCheckOutlineRegular` 的路径（`primitives/lib/index.js:416-434`）。 */
function CheckIcon(): ReactElement {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      strokeWidth={1}
    >
      <path
        d="M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4"
        stroke="currentColor"
      />
    </svg>
  );
}

/**
 * 锚定式下拉：触发按钮渲染在原位，弹层 portal 到 `document.body`。
 *
 * 交互与宿主 `Menu` 对齐：方向键取模环绕、Home/End 到首尾、Tab 结算焦点所在
 * 的行（焦点在触发按钮上时则进入列表）、Esc 关闭并把焦点还给触发按钮、点击外部
 * 关闭、选中后焦点回到触发按钮。
 */
export function Dropdown({ label, value, options, onSelect }: DropdownProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [fixedPos, setFixedPos] = useState<FixedPos | null>(null);

  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** 方向键走位最后落点的下标；焦点离开行之后作为重新进入列表的起点。 */
  const walkIndex = useRef<number | null>(null);
  const listId = useId();

  // 回调放进 ref：它每次渲染都是新函数，直接进 effect 依赖会让监听反复重装。
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;

  /** 结算一次选择：写值、关闭，然后把焦点还给触发按钮。 */
  const settle = (id: string): void => {
    selectRef.current(id);
    setOpen(false);
    // 行会随弹层一起卸载，焦点此时落到 body —— 不还回去的话，下一个 Tab 会从
    // 页面顶部重新开始。等 React 提交完再判断，照抄宿主 `Menu.refocusAfterSelection`。
    queueMicrotask(() => {
      const active = document.activeElement;
      if (active !== null && active !== document.body) return;
      const trigger = triggerRef.current;
      if (trigger !== null) focusWithoutRing(trigger);
    });
  };

  // 定位：读触发按钮的 rect，算出坐标并钳制进视口。
  useLayoutEffect(() => {
    if (!open) {
      setFixedPos(null);
      return;
    }

    const place = (): void => {
      const anchor = triggerRef.current;
      const list = listRef.current;
      if (anchor === null || list === null) return;

      const rect = anchor.getBoundingClientRect();
      const width = list.offsetWidth;
      const height = list.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // 与触发按钮右端对齐、落在其下方（对应宿主的 align="end", side="bottom"）。
      let x = rect.right - width;
      const y0 = rect.bottom + GAP;
      if (width > 0) x = Math.min(Math.max(x, MARGIN), vw - width - MARGIN);
      const y = height > 0 ? Math.min(Math.max(y0, overlayTopMargin(MARGIN)), vh - height - MARGIN) : y0;

      setFixedPos((current) =>
        current !== null && current.left === x && current.top === y ? current : { left: x, top: y },
      );
    };

    place();
    // 首帧还不知道弹层高度，先测量再定位；持续跟踪是为了布局变化时不被甩开。
    let frame = requestAnimationFrame(function track(): void {
      place();
      frame = requestAnimationFrame(track);
    });
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  // 打开时把当前选中项滚入视野：弹层有 max-height，选中项可能在滚动区之外。
  // 直接改 scrollTop 而不是用 scrollIntoView，避免连带滚动宿主页面。
  useLayoutEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (list === null) return;
    const current = list.querySelector<HTMLElement>('[aria-checked="true"]');
    if (current === null) return;
    const top = current.offsetTop;
    const bottom = top + current.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, [open]);

  useEffect(() => {
    if (!open) {
      walkIndex.current = null;
      return;
    }

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target) === true) return;
      // 弹层被 portal 到 body，所以不在 rootRef 里，必须单独判。
      if (listRef.current?.contains(target) === true) return;
      setOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.defaultPrevented) return;
      if (event.ctrlKey || event.altKey || event.metaKey) return;

      const focused = document.activeElement;
      const insideList = focused !== null && listRef.current?.contains(focused) === true;
      const inTrigger = focused !== null && rootRef.current?.contains(focused) === true;
      // 只有键盘还在触发按钮或列表上时才接管按键，页面别处的 Tab 归浏览器。
      const anchored = inTrigger || insideList;

      if (event.key === 'Escape' && !event.shiftKey) {
        event.preventDefault();
        if (event.repeat) return;
        setOpen(false);
        if (anchored) {
          const trigger = triggerRef.current;
          if (trigger !== null) focusWithoutRing(trigger);
        }
        return;
      }

      if (event.key === 'Tab') {
        const list = listRef.current;
        if (list === null || !anchored) return;
        if (event.shiftKey) {
          event.preventDefault();
          setOpen(false);
          // 这条路径是显式的键盘导航，保留焦点环（对应宿主 refocusAnchor(true)）。
          triggerRef.current?.focus();
          return;
        }
        if (insideList) {
          // 焦点在某一行上：Tab 结算这一行。
          if (focused instanceof HTMLElement && focused.getAttribute('role') === 'menuitemradio') {
            event.preventDefault();
            focused.click();
          }
          return;
        }
        // 焦点在触发按钮上：Tab 进入列表第一行。
        const first = list.querySelector<HTMLElement>('button:not(:disabled)');
        if (first === null) return;
        event.preventDefault();
        first.focus();
        walkIndex.current = 0;
        return;
      }

      if (
        event.key !== 'ArrowDown' &&
        event.key !== 'ArrowUp' &&
        event.key !== 'Home' &&
        event.key !== 'End'
      ) {
        return;
      }

      const list = listRef.current;
      if (list === null || !anchored) return;
      const rows = Array.from(list.querySelectorAll<HTMLElement>('button:not(:disabled)'));
      if (rows.length === 0) return;

      const index = focused instanceof HTMLElement ? rows.indexOf(focused) : -1;
      const from = index >= 0 ? index : walkIndex.current;

      let next: number;
      if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = rows.length - 1;
      else if (from === null) next = event.key === 'ArrowDown' ? 0 : rows.length - 1;
      else next = (from + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;

      event.preventDefault();
      walkIndex.current = next;
      rows[next]?.focus();
    };

    const onWindowBlur = (): void => {
      // 焦点进了 iframe：宿主不会再把按键转回来，直接关。
      if (document.activeElement instanceof HTMLIFrameElement) setOpen(false);
    };

    // Escape 注册在捕获阶段，才能抢在设置 dialog 自己的 Escape 处理之前。
    const onEscapeCapture = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onKeyDown(event);
    };
    const onOtherKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') onKeyDown(event);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onEscapeCapture, true);
    document.addEventListener('keydown', onOtherKey);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onEscapeCapture, true);
      document.removeEventListener('keydown', onOtherKey);
      window.removeEventListener('blur', onWindowBlur);
    };
  }, [open]);

  const selectedLabel = options.find((option) => option.id === value)?.label ?? '';

  return (
    <span ref={rootRef} className="ck-menu-root">
      <button
        ref={triggerRef}
        type="button"
        className="ck-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        <span className="ck-trigger-label">{selectedLabel}</span>
        <ChevronIcon />
      </button>
      {open &&
        createPortal(
          <div
            ref={listRef}
            id={listId}
            role="menu"
            aria-label={label}
            className="ck-menu"
            style={fixedPos ?? MEASURE_STYLE}
          >
            {options.map((option) => {
              const isSelected = option.id === value;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isSelected}
                  className="ck-menu-item"
                  onClick={() => {
                    settle(option.id);
                  }}
                >
                  <span className="ck-menu-item-label">{option.label}</span>
                  {isSelected && <CheckIcon />}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </span>
  );
}
