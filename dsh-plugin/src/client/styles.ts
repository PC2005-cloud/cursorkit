/**
 * 样式注入。
 *
 * 本工程没有 CSS-module 构建步骤，因此把样式作为**自己组件生命周期内**的一个
 * `<style>` 节点注入，并在插件卸载时移除（沿用宿主客户端产物的
 * `data-plugin` / `data-plugin-css` 约定）。类名一律带 `ck-` 前缀，不碰宿主类名。
 *
 * 三段样式各有出处：
 *   - 设置行结构 / 间距 / 字号：`dsh-client-locale` 的 `LanguageRow.module.css`
 *     与 `dsh-client-ui-theme` 的 `FontSizeRow.module.css`
 *   - 触发按钮：`LanguageRow.module.css` 的 `.selector` / `.chevron`
 *   - 弹层：`dsh-client-ui-primitives` 的 `Menu.module.css` 的 `.list` / `.portal`
 *     与 `MenuSurface.module.css`（宿主把 primitive 的 CSS 抄进插件是官方
 *     `practices.md:35` 明令要求的做法，因为禁止 import primitives）
 *
 * 颜色只引用宿主主题 token。以下三处宿主原文用的 token 不在允许清单内，做了等价替代：
 *   - `--dsw-alias-bg-module-platform` → `--dsw-alias-bg-layer-2`（触发按钮底色）
 *   - `--dsw-alias-interactive-bg-hover` → `--dsw-alias-bg-layer-1`（按钮 hover）
 *     / `--dsw-alias-bg-layer-2`（菜单行 hover 与焦点填充）
 *   - `--dsw-menu-surface-fill` + `--dsw-elevation-prominent`（半透明材质 + 投影）
 *     → 实心 `--dsw-alias-bg-overlay` + `--dsw-alias-border-l1` 发丝边
 * 圆角与尺寸不是颜色，按既有决策用字面量（`--dsw-radius-*` 也在清单之外）。
 */
export const STYLE_TAG_ID = 'dsh-cursorkit/styles.css';

export const STYLES = [
  // ── 设置行：照抄 LanguageRow / FontSizeRow 的行结构 ──
  '.ck-row{border-bottom:.5px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}',
  '.ck-row-text{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}',
  '.ck-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}',
  '.ck-desc{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:400;line-height:18px}',

  // ── 触发按钮：照抄 LanguageRow.module.css 的 .selector ──
  '.ck-menu-root{position:relative;display:inline-flex}',
  '.ck-trigger{border-radius:12px;background:var(--dsw-alias-bg-layer-2);height:36px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;align-items:center;gap:12px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}',
  '.ck-trigger:hover{background:var(--dsw-alias-bg-layer-1)}',
  '.ck-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
  '.ck-trigger-label{white-space:nowrap}',
  '.ck-trigger svg{flex:none}',

  // ── 弹层：照抄 Menu.module.css 的 .list 与 .portal（body portal + fixed + z-index 1100）──
  '.ck-menu{box-sizing:border-box;padding:4px;display:flex;flex-direction:column;gap:0;border:.5px solid var(--dsw-alias-border-l1);border-radius:16px;background:var(--dsw-alias-bg-overlay);position:fixed;top:auto;left:auto;z-index:1100;min-width:144px;max-width:260px;max-height:calc(100vh - 12px - max(12px, var(--dsh-frame-overlay-top, 12px)));overflow-y:auto}',
  '.ck-menu-item{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:none;border-radius:12px;background:transparent;cursor:pointer;font-family:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);text-align:left}',
  '.ck-menu-item:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
  // 焦点填充即选中指示，浏览器默认环会与之重叠，所以压掉（与宿主 Menu 同处理）。
  '.ck-menu-item:focus-visible:not(:disabled){background:var(--dsw-alias-bg-layer-2);outline:none}',
  '.ck-menu-item-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.ck-menu-item svg{flex:none;color:var(--dsw-alias-brand-primary)}',
].join('');

/**
 * 注入样式并返回清理函数。
 *
 * 先移除同名的历史节点：插件被重新装载时可能残留上一世代的 `<style>`，
 * 留着会让清理函数不再是它的所有者，卸载后样式清不干净。
 */
export function installStyles(): () => void {
  if (typeof document === 'undefined') return () => {};

  document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`)?.remove();

  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-cursorkit';
  tag.dataset.pluginCss = STYLE_TAG_ID;
  tag.textContent = STYLES;
  document.head.appendChild(tag);

  return () => {
    tag.remove();
  };
}
