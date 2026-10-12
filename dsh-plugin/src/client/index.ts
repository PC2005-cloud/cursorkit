import type { Context } from '@deepseek-ai/cordis';

// 25 个效果模块的副作用引入：每个模块在顶层执行 `customElements.define`，
// 不静态引入就不会注册，`document.createElement(tag)` 只会得到未知元素。
// 清单与顺序见 `effects.ts`。
import 'cursorkit-effects/effects/snow.js';
import 'cursorkit-effects/effects/ice.js';
import 'cursorkit-effects/effects/pixel.js';
import 'cursorkit-effects/effects/sun.js';
import 'cursorkit-effects/effects/silk.js';
import 'cursorkit-effects/effects/refract.js';
import 'cursorkit-effects/effects/orb.js';
import 'cursorkit-effects/effects/geom.js';
import 'cursorkit-effects/effects/ball.js';
import 'cursorkit-effects/effects/planet.js';
import 'cursorkit-effects/effects/mist.js';
import 'cursorkit-effects/effects/code.js';
import 'cursorkit-effects/effects/rainbow.js';
import 'cursorkit-effects/effects/moon.js';
import 'cursorkit-effects/effects/bubble.js';
import 'cursorkit-effects/effects/ink.js';
import 'cursorkit-effects/effects/doodle.js';
import 'cursorkit-effects/effects/firefang.js';
import 'cursorkit-effects/effects/hole.js';
import 'cursorkit-effects/effects/lightning.js';
import 'cursorkit-effects/effects/kaleido.js';
import 'cursorkit-effects/effects/cell.js';
import 'cursorkit-effects/effects/fish.js';
import 'cursorkit-effects/effects/firework.js';
import 'cursorkit-effects/effects/radar.js';

import { CursorLayer } from './CursorLayer';
import { NS, dictionaries } from './locales';
import { setEffectId } from './preferences';
import { SettingsRow } from './SettingsRow';
import { installStyles } from './styles';

/** 这个客户端插件用到 slots 与 locale 两个服务。 */
export const inject = ['slots', 'locale'];

/**
 * 装配插件。
 *
 * 两处注册：
 *   - `shell.overlay` —— 全视口光标层。选它是因为它是 list 槽位，新 id 会
 *     **并列添加**而不是替换既有条目（`replaceRisk: none`），且该层本身
 *     穿透点击，与光标层的语义一致。
 *   - `settings.general.item` —— 「通用」分区里的一行偏好。该槽位不投影
 *     `label`、owner 也不传任何 props，所以行内的标题、当前值与写入路径
 *     全部由 `SettingsRow` 自己负责。
 *
 * 两个资源（本地化字典、样式）都用 `ctx.effect` 注册，随插件卸载一并回收。
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'cursorkit: locale dictionaries');
  ctx.effect(() => installStyles(), 'cursorkit: styles');

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'cursorkit.layer', order: 900 },
      CursorLayer,
    ),
  );

  ctx.slots.inject('settings.general.item', () =>
    ctx.slots.register(
      {
        name: 'settings.general.item',
        id: 'cursorkit',
        order: 90,
        locale: NS,
        inject: () => ({ setEffect: setEffectId }),
      },
      SettingsRow,
    ),
  );
}
