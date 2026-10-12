/**
 * 效果清单。
 *
 * `title` 是中文展示名，**全部取自仓库里的真实文案**，来源为
 * `index.html` 第 813–839 行的 `META` 表，并由 `src/effects/*.js`
 * 每个文件第 2 行的头部注释逐条印证（例如 `ball.js` 写「鼠标光标彩球动效」，
 * 与 `META` 的「彩球」一致）。没有一处是自行编造的。
 *
 * 英文名不在仓库里，见 `locales.ts` 的说明。
 *
 * 增加一个效果需要三处改动：这里补一条、`index.ts` 顶部补一行副作用
 * import（模块顶层执行 `customElements.define`，不静态引入就不会注册）、
 * `locales.ts` 的英文名字典补一条。
 */
export interface CursorEffect {
  /** 稳定标识，用于偏好持久化与日志。 */
  readonly id: string;
  /** 效果注册的自定义元素标签名。 */
  readonly tag: string;
  /** 中文展示名（取自仓库文案）。 */
  readonly title: string;
}

/**
 * 默认效果。
 *
 * 单独取出常量而不是用 `EFFECTS[0]`：`noUncheckedIndexedAccess` 下下标
 * 访问的类型是 `CursorEffect | undefined`，而回退路径需要一个确定值。
 */
export const DEFAULT_EFFECT: CursorEffect = {
  id: 'snow',
  tag: 'cursor-snow',
  title: '雪花',
};

/** 全部效果，顺序与仓库 `src/effects/index.js` 的 `EFFECTS` 清单一致。 */
export const EFFECTS: readonly CursorEffect[] = [
  DEFAULT_EFFECT,
  { id: 'ice', tag: 'cursor-ice', title: '冰晶' },
  { id: 'pixel', tag: 'cursor-pixel', title: '像素' },
  { id: 'sun', tag: 'cursor-sun', title: '太阳' },
  { id: 'silk', tag: 'cursor-silk', title: '丝绸' },
  { id: 'refract', tag: 'cursor-refract', title: '光折射' },
  { id: 'orb', tag: 'cursor-orb', title: '光球' },
  { id: 'geom', tag: 'cursor-geom', title: '几何体' },
  { id: 'ball', tag: 'cursor-ball', title: '彩球' },
  { id: 'planet', tag: 'cursor-planet', title: '星球' },
  { id: 'mist', tag: 'cursor-mist', title: '云雾' },
  { id: 'code', tag: 'cursor-code', title: '代码' },
  { id: 'rainbow', tag: 'cursor-rainbow', title: '彩虹' },
  { id: 'moon', tag: 'cursor-moon', title: '月亮' },
  { id: 'bubble', tag: 'cursor-bubble', title: '气泡' },
  { id: 'ink', tag: 'cursor-ink', title: '水墨' },
  { id: 'doodle', tag: 'cursor-doodle', title: '涂鸦' },
  { id: 'firefang', tag: 'cursor-firefang', title: '火牙' },
  { id: 'hole', tag: 'cursor-hole', title: '黑洞' },
  { id: 'lightning', tag: 'cursor-lightning', title: '闪电' },
  { id: 'kaleido', tag: 'cursor-kaleido', title: '万花筒' },
  { id: 'cell', tag: 'cursor-cell', title: '细胞' },
  { id: 'fish', tag: 'cursor-fish', title: '鱼群' },
  { id: 'firework', tag: 'cursor-firework', title: '烟火' },
  { id: 'radar', tag: 'cursor-radar', title: '雷达' },
];

/** 默认效果 id。 */
export const DEFAULT_EFFECT_ID = DEFAULT_EFFECT.id;

/** 按 id 查找效果；未收录时返回 `undefined`。 */
export function findEffect(id: string): CursorEffect | undefined {
  return EFFECTS.find((effect) => effect.id === id);
}

/** 按 id 查找效果，找不到时回退到默认效果。 */
export function resolveEffect(id: string): CursorEffect {
  return findEffect(id) ?? DEFAULT_EFFECT;
}
