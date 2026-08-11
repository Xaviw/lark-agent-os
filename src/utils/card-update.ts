import type { LarkChannel } from '@larksuite/channel';
import type { CardUpdater } from '../types.js';
import { retryOnce } from './retry.js';

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
  let finishTail: Promise<void> = Promise.resolve();
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

  /**
   * 最终更新：置 finished 后该卡必然发送。
   * 契约：finish 可被多次调用（如停止流程先 finish 过渡卡「正在停止」，abort 完成后 execute 再 finish 最终卡），
   * 后续 finish 会覆盖先前的卡片——属预期行为（最终态覆盖过渡态），依赖 finishTail 链保证顺序。
   */
  const finish = (card: object): Promise<void> => {
    finished = true;
    pendingCard = undefined;
    const previous = updatePromise ?? Promise.resolve();
    const next = finishTail
      .catch((error) => console.warn(`[${label}] previous finish failed`, error))
      .then(() => previous.catch((error) => console.warn(`[${label}] previous update failed`, error)))
      .then(() => updateCardWithRetry(lark, messageId, card, label));
    finishTail = next;
    return next;
  };

  return { update, finish };
}

export async function updateCardWithRetry(lark: LarkChannel, messageId: string, card: object, label: string): Promise<void> {
  try {
    // 卡片更新对所有错误都重试一次（网络抖动/限流均属可重试，与 lark-api 的业务错误码判定不同）
    await retryOnce(
      () => lark.updateCard(messageId, card),
      () => true,
      500,
      (error) => console.debug(`[${label}] card update retry:`, error),
    );
  } catch (error) {
    console.warn(`[${label}] card update failed`, error);
    throw error;
  }
}
