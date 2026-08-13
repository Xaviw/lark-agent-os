/**
 * 内存去重集合（纯函数模块，无副作用依赖）：
 * `add` 记录 id 与过期时间；`has` 命中未过期 id 返回 true（惰性清理过期项）。
 * 用途：卡片事件 event_id 防重推、消息 messageId 防重复处理（补偿 SDK dedup 窗口缩短后的空隙）。
 */
export function createSeenSet(ttlMs: number, maxEntries = 2_000): { has(id: string): boolean; add(id: string): void } {
  const seen = new Map<string, number>();
  return {
    has(id: string): boolean {
      const expiresAt = seen.get(id);
      if (expiresAt === undefined) return false;
      if (expiresAt > Date.now()) return true;
      seen.delete(id);
      return false;
    },
    add(id: string): void {
      seen.set(id, Date.now() + ttlMs);
      if (seen.size <= maxEntries) return;
      // 惰性清理过期项；仍超限则删除最旧（Map 插入序）
      const now = Date.now();
      for (const [key, expiresAt] of seen) {
        if (expiresAt <= now) seen.delete(key);
      }
      while (seen.size > maxEntries) {
        const oldest = seen.keys().next().value;
        if (oldest === undefined) break;
        seen.delete(oldest);
      }
    },
  };
}
