/**
 * 客户端偏好持久化。
 *
 * DSH 的浏览器侧没有设置/存储服务，官方多个包用 `localStorage` 存客户端
 * 偏好（键名形如 `dsh.keybindings.v1`），这里沿用同一做法。
 *
 * 两处必须容错的场景：
 *   - 没有 `localStorage`（非浏览器环境、被禁用的存储）
 *   - 存的是损坏 JSON，或存了清单里已经不存在的老效果 id
 * 两种情况都回退到默认值，绝不抛出。
 */
import { DEFAULT_EFFECT_ID, findEffect } from './effects';

/** 版本化键名：结构变更时换版本，而不是去兼容旧结构。 */
const STORAGE_KEY = 'dsh.cursorkit.v1';

export interface CursorPreferences {
  /** 选中的效果 id。 */
  readonly effectId: string;
}

const FALLBACK: CursorPreferences = { effectId: DEFAULT_EFFECT_ID };

/** 读取持久化偏好；任何异常路径都返回默认值。 */
function read(): CursorPreferences {
  if (typeof localStorage === 'undefined') return FALLBACK;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return FALLBACK;

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return FALLBACK;

    const { effectId } = parsed as { effectId?: unknown };
    // 老版本写过、但现在清单里已经没有的效果 id 同样视为无效。
    if (typeof effectId !== 'string' || findEffect(effectId) === undefined) return FALLBACK;

    return { effectId };
  } catch {
    return FALLBACK;
  }
}

/**
 * 当前快照。
 *
 * `useSyncExternalStore` 要求 `getSnapshot` 在无变更时返回同一引用，
 * 所以这里保存的是对象本身，只在写入时整体替换。
 */
let snapshot: CursorPreferences = read();

const listeners = new Set<() => void>();

/** 读取当前偏好（`useSyncExternalStore` 的 getSnapshot）。 */
export function getPreferences(): CursorPreferences {
  return snapshot;
}

/** 订阅变更，返回退订函数。 */
export function subscribePreferences(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 写入选中的效果 id；无效 id 与重复写入都会被忽略。 */
export function setEffectId(effectId: string): void {
  if (findEffect(effectId) === undefined) return;
  if (effectId === snapshot.effectId) return;

  snapshot = { effectId };

  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      // 隐私模式或配额耗尽：内存里的选择仍然生效，只是不落盘。
    }
  }

  for (const listener of listeners) listener();
}
