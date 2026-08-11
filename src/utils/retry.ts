/**
 * 通用「重试一次」工具：fn 第一次失败且 isRetryable(error) 为 true 时，等待 delayMs 后重试一次；否则立即抛出。
 * 用于卡片更新（updateCardWithRetry）与飞书 API 请求（LarkApi.request）统一重试策略，避免两处实现漂移。
 */
export async function retryOnce<T>(
  fn: () => Promise<T>,
  isRetryable: (error: unknown) => boolean,
  delayMs = 500,
  onRetry?: (error: unknown) => void | Promise<void>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === 0 && isRetryable(error)) {
        await onRetry?.(error);
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw error;
    }
  }
}
