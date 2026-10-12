/**
 * 引入 DSH 客户端侧的类型增强。
 *
 * 这些包通过 `declare module '@deepseek-ai/cordis'` 或
 * `declare module '@deepseek-ai/dsh-client-ui-slots'` 做声明合并，
 * 只有把模块拉进编译期才会生效：
 *
 * - `dsh-client-ui-renderer` 在 `Context` 上挂 `slots`（`SlotRegistry`）
 * - `dsh-client-locale` 在 `Context` 上挂 `locale`（`LocaleRuntime`）
 * - `dsh-client-ui-layout` 把 `shell.overlay` 合并进 `SlotMap`
 * - `dsh-client-ui-settings` 把 `settings.general.item` 合并进 `SlotMap`
 *
 * 全部只在类型层面存在（`import type` 会在构建时被完全擦除）；
 * 运行时由 dsh 安装目录解析，不作为依赖发布。
 */
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import type {} from '@deepseek-ai/dsh-client-ui-settings/client';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  /**
   * 本插件自己的文案命名空间。
   *
   * 效果名用模板字面量而不是逐个列举：效果清单在 `effects.ts` 里是运行期数组，
   * 派生不出字面量联合。键的正确性由调用点 `t(\`effect.${effect.id}\`)`
   * 与 `EFFECTS` 共同保证，不需要在这里再抄一遍 25 个键。
   */
  interface LocaleNamespaceMap {
    cursorkit: 'row.title' | 'row.description' | `effect.${string}`;
  }
}
