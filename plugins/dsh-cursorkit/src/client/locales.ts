/**
 * 本地化字典。
 *
 * 中文文案取自仓库真实文案；效果名直接复用 `effects.ts` 的 `title`，
 * 不再手抄一遍，避免两处不一致。
 *
 * 英文名：**仓库里不存在任何英文对照表**（已确认 `index.html`、`show.html`、
 * `README.md`、`extension/` 下都只有中文名）。因此这里用的是效果自身的规范
 * 标识（`src/effects/index.js` 的键）首字母大写，属于机械派生而非翻译臆造 ——
 * 这也是为什么 `refract` / `geom` / `kaleido` / `firefang` 保持原始标识形态，
 * 没有写成 Refraction / Geometry / Kaleidoscope / Fire Fang 这类我编的词。
 */
import type { BuiltInLocaleId } from '@deepseek-ai/dsh-client-locale';

import { EFFECTS } from './effects';

/** 本地化命名空间。 */
export const NS = 'cursorkit';

const EN_EFFECT_NAMES: Record<string, string> = {
  snow: 'Snow',
  ice: 'Ice',
  pixel: 'Pixel',
  sun: 'Sun',
  silk: 'Silk',
  refract: 'Refract',
  orb: 'Orb',
  geom: 'Geom',
  ball: 'Ball',
  planet: 'Planet',
  mist: 'Mist',
  code: 'Code',
  rainbow: 'Rainbow',
  moon: 'Moon',
  bubble: 'Bubble',
  ink: 'Ink',
  doodle: 'Doodle',
  firefang: 'Firefang',
  hole: 'Hole',
  lightning: 'Lightning',
  kaleido: 'Kaleido',
  cell: 'Cell',
  fish: 'Fish',
  firework: 'Firework',
  radar: 'Radar',
};

/**
 * 字典类型。
 *
 * 固定的键必须写成字面量：槽位注册时 `LocaleDictOf<NS>` 会核对
 * `row.title` / `row.description` 必须存在，光有字符串索引签名不够。
 * 效果名那部分是运行期拼出来的，靠交叉的索引签名接住。
 */
type CursorkitDict = {
  'row.title': string;
  'row.description': string;
} & Record<string, string>;

const zh: CursorkitDict = {
  'row.title': '光标动效',
  'row.description': '选择铺在整个 Harness 界面上的鼠标光标动效。',
};

const en: CursorkitDict = {
  'row.title': 'Cursor effect',
  'row.description': 'Choose the cursor effect drawn across the whole Harness interface.',
};

for (const effect of EFFECTS) {
  zh[`effect.${effect.id}`] = effect.title;
  // 英文名字典缺项时退回效果标识本身，至少不会显示成裸键名。
  en[`effect.${effect.id}`] = EN_EFFECT_NAMES[effect.id] ?? effect.id;
}

export const dictionaries: Record<BuiltInLocaleId, CursorkitDict> = { zh, en };
