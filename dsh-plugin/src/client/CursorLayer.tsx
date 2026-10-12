import {
  useEffect,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type ReactElement,
} from 'react';

import { resolveEffect } from './effects';
import { getPreferences, subscribePreferences } from './preferences';

/**
 * 图层宿主样式。
 *
 * 宿主同时充当 popover，这是为了进入浏览器的 **top layer**。
 *
 * 原因：`shell.overlay` 被包在 `data-shell-overlay` 容器里，而该容器是
 * `position: absolute; z-index: 20` —— 它自成层叠上下文。宿主作为它的
 * 后代，z-index 调到多大都只会整体停在 20 这一层，而 DSH 的 dialog 与
 * 弹出菜单用的是 1000 / 1001 / 1100，必然盖住光标。进入 top layer 才能
 * 凌驾于所有 z-index 之上。
 *
 * popover 带 UA 默认样式（border / padding / margin / background / overflow /
 * fit-content 尺寸），这里逐项覆盖掉。
 */
const LAYER_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  width: '100%',
  height: '100%',
  maxWidth: 'none',
  maxHeight: 'none',
  margin: 0,
  padding: 0,
  border: 'none',
  background: 'transparent',
  overflow: 'visible',
  pointerEvents: 'none',
};

/**
 * 把当前选中的 CursorKit 效果挂进框架级浮层。
 *
 * 命令式创建自定义元素而不是写成 JSX：挂载与卸载完全由这里掌控，
 * 移除节点即触发 `disconnectedCallback`，效果内部会自行回收
 * window / document 上的监听与全局 `cursor: none` 样式引用。
 * 换效果就是移除旧节点、挂载新节点，没有别的状态要同步。
 *
 * 拆成两个 effect 的原因：顶层提升与「选了哪个效果」无关，只应发生一次；
 * 自定义元素则必须随选择变化重建。合成一个会让切换效果时重复走一遍
 * showPopover / hidePopover，白白闪一下。
 */
export function CursorLayer(): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const preferences = useSyncExternalStore(subscribePreferences, getPreferences, getPreferences);
  const effect = resolveEffect(preferences.effectId);

  // 顶层提升：只在挂载时做一次。
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    // 只在 API 真的存在时才加 popover 属性。
    // UA 样式会把「有 popover 属性但未打开」的元素设为 display: none，
    // 若加了属性却没能打开，图层会彻底不可见 —— 比被遮罩更糟。
    if (typeof host.showPopover !== 'function') return;

    // manual：不进 light-dismiss 组，不响应 Esc，也不因点击外部而关闭。
    host.setAttribute('popover', 'manual');
    try {
      host.showPopover();
    } catch {
      // 已处于打开状态时重复调用会抛错，忽略。
    }

    return () => {
      if (!host.matches(':popover-open')) return;
      try {
        host.hidePopover();
      } catch {
        // 已经关闭，忽略。
      }
    };
  }, []);

  // 效果挂载：依赖选中项，换效果即换节点。
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const node = document.createElement(effect.tag);
    host.appendChild(node);

    return () => {
      node.remove();
    };
  }, [effect]);

  return <div ref={hostRef} style={LAYER_STYLE} data-cursorkit={effect.id} />;
}
