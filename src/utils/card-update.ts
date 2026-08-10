import type { LarkChannel } from '@larksuite/channel';
import type { CardUpdater } from '../types.js';

/** 事件驱动节流：intervalMs 内至多立即触发一次，其余排队到间隔末尾；cancel 取消挂起触发 */
export function createThrottledUpdate(fn: () => void, intervalMs: number): { trigger: () => void; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  let lastAt = 0;
  const trigger = (): void => {
    const delay = intervalMs - (Date.now() - lastAt);
    if (delay <= 0) {
      if (timer) { clearTimeout(timer); timer = undefined; }
      lastAt = Date.now();
      fn();
    } else if (!timer) {
      timer = setTimeout(() => { timer = undefined; lastAt = Date.now(); fn(); }, delay);
    }
  };
  const cancel = (): void => { if (timer) { clearTimeout(timer); timer = undefined; } };
  return { trigger, cancel };
}

export function createCardUpdater(lark: LarkChannel, messageId: string, label: string): CardUpdater {
  let pendingCard: object | undefined;
  let updatePromise: Promise<void> | undefined;
  let finished = false;

  const startUpdate = (): Promise<void> => {
    if (updatePromise) return updatePromise;
    updatePromise = (async () => {
      while (!finished && pendingCard) {
        const card = pendingCard;
        pendingCard = undefined;
        await updateCardWithRetry(lark, messageId, card, label);
      }
    })().finally(() => {
      updatePromise = undefined;
    });
    return updatePromise;
  };

  const update = (card: object): Promise<void> => {
    if (finished) return Promise.resolve();
    pendingCard = card;
    return startUpdate();
  };

  const finish = (card: object): Promise<void> => {
    finished = true;
    pendingCard = undefined;
    const previous = updatePromise ?? Promise.resolve();
    return previous
      .catch((error) => console.warn(`[${label}] previous update failed`, error))
      .then(() => updateCardWithRetry(lark, messageId, card, label));
  };

  return { update, finish };
}

export async function updateCardWithRetry(lark: LarkChannel, messageId: string, card: object, label: string): Promise<void> {
  let error: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await lark.updateCard(messageId, card);
      return;
    } catch (caught) {
      error = caught;
      if (attempt === 0) await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
  }
  console.warn(`[${label}] card update failed`, error);
  throw error;
}
