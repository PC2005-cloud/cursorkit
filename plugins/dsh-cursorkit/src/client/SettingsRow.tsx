/**
 * 设置行：在「通用」分区里选一种光标动效。
 *
 * 槽位契约（官方 slot 目录 `settings.general.item` 条目）：
 * 「the section column only stacks rows, so a row draws its own internals,
 * **including its label**: nothing projects a `label` here and the owner passes
 * no props at all」。所以标签、当前值、写入路径全部由本组件自己画，
 * 不依赖 owner 传任何 props。
 *
 * 行结构照抄宿主现成的同类设置行；控件用本插件自己的 `Dropdown`
 * （为什么不是原生 `<select>`、也不是宿主 `Menu`，见该文件的说明），
 * 样式见 `styles.ts`。
 */
import { useSyncExternalStore, type ReactElement } from 'react';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';

import { Dropdown, type DropdownOption } from './Dropdown';
import { EFFECTS, resolveEffect } from './effects';
import { NS } from './locales';
import { getPreferences, subscribePreferences } from './preferences';

/** 本行注册时通过 `inject` 暴露给组件的业务面。 */
export interface CursorkitInjected {
  /** 写入选中的效果 id。 */
  setEffect: (effectId: string) => void;
}

export type SettingsRowProps = PropsRuntime<'settings.general.item'> &
  PropsLocale<typeof NS> &
  InjectFace<CursorkitInjected>;

export function SettingsRow({ t, setEffect }: SettingsRowProps): ReactElement {
  // 偏好是插件自己的外部 store，用 uSES 订阅；react 在浏览器模块表里。
  const preferences = useSyncExternalStore(subscribePreferences, getPreferences, getPreferences);
  const selected = resolveEffect(preferences.effectId);

  // 选项清单：id 稳定，标签按当前语言现算。
  const options: readonly DropdownOption[] = EFFECTS.map((effect) => ({
    id: effect.id,
    label: t(`effect.${effect.id}`),
  }));

  return (
    <div className="ck-row">
      <div className="ck-row-text">
        <div className="ck-title">{t('row.title')}</div>
        <div className="ck-desc">{t('row.description')}</div>
      </div>
      <Dropdown label={t('row.title')} value={selected.id} options={options} onSelect={setEffect} />
    </div>
  );
}
