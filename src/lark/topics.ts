import type { NormalizedMessage } from '@larksuite/channel';
import type { AppContext } from '../app-context.js';
import { topicSessionName } from '../utils/format.js';
import { workspaceForChat } from '../sync/sync-service.js';

/**
 * 话题（thread）支持层：话题窗口 = 独立 session（懒初始化，不 fork、不继承主会话历史）。
 * 设计要点：
 * - 话题消息事件带 `threadId`（chat_id 与原会话相同），据此建立 `threadId → sessionFile` 绑定；
 * - 话题 session 不参与电脑端同步（watcher 只监听 activeSessionFile）、不触发公告（公告按 chatId 挂原群）；
 * - 卡片操作事件无 threadId，用 `fetchMessage(messageId)` 反查（带缓存）。
 */

/** 同一 threadId 并发消息只新建一次 session 的 in-flight 守卫 */
const creating = new Map<string, Promise<string>>();
/** 卡片消息 → threadId 反查/发送侧记录缓存（消息 id 不可复用，缓存无过期风险；限长防泄漏） */
const cardThreadCache = new Map<string, string | undefined>();
/** 同一 messageId 并发反查只 fetch 一次的 in-flight 守卫 */
const cardThreadInFlight = new Map<string, Promise<string | undefined>>();

/**
 * 话题会话文件（懒初始化）：已绑定返回现有 session；未绑定则新建 session 并绑定 threadId。
 * 非话题调用方不应使用。
 */
export async function ensureThreadSession(ctx: AppContext, chatId: string, threadId: string, cwd: string): Promise<string> {
  const existing = ctx.state.get(chatId)?.threadSessions?.[threadId]?.sessionFile;
  if (existing) return existing;
  const key = `${chatId}:${threadId}`;
  const inflight = creating.get(key);
  if (inflight) return inflight;
  const created = (async (): Promise<string> => {
    // 等待队列期间可能已被其他消息绑定（双检）
    const again = ctx.state.get(chatId)?.threadSessions?.[threadId]?.sessionFile;
    if (again) return again;
    const sessionFile = await ctx.pi.create(cwd, topicSessionName());
    const threadSessions = {
      ...(ctx.state.get(chatId)?.threadSessions ?? {}),
      [threadId]: { sessionFile, updatedAt: new Date().toISOString() },
    };
    ctx.state.update(chatId, { threadSessions });
    await ctx.state.flush();
    return sessionFile;
  })();
  creating.set(key, created);
  void created.catch(() => undefined).finally(() => creating.delete(key));
  return created;
}

/** 消息所属会话文件：话题消息 → 话题独立 session（懒初始化）；普通消息 → 主会话 activeSessionFile */
export async function sessionFileForMessage(ctx: AppContext, message: NormalizedMessage): Promise<string | undefined> {
  const binding = ctx.state.get(message.chatId);
  if (!binding) return undefined;
  if (message.threadId) return ensureThreadSession(ctx, message.chatId, message.threadId, workspaceForChat(ctx, message.chatId));
  return binding.activeSessionFile;
}

/** 发送卡片时记录其所在话题上下文（发送侧已知，避免卡片操作时反查网络）：普通群记 undefined（命中即免 fetch） */
export function rememberCardThread(messageId: string, threadId: string | undefined): void {
  if (cardThreadCache.has(messageId)) return;
  cardThreadCache.set(messageId, threadId);
  if (cardThreadCache.size > 1000) {
    const oldest = cardThreadCache.keys().next().value;
    if (oldest !== undefined) cardThreadCache.delete(oldest);
  }
}

/**
 * 卡片触发消息是否在话题内：cardAction 事件无 threadId。优先命中发送侧记录；
 * 未记录（如重启后的旧卡）才 fetchMessage 反查（带 in-flight 守卫，失败不缓存、按非话题处理）。
 */
export function cardThreadId(ctx: AppContext, messageId: string): Promise<string | undefined> {
  const cached = cardThreadCache.get(messageId);
  if (cached !== undefined || cardThreadCache.has(messageId)) return Promise.resolve(cached);
  const inflight = cardThreadInFlight.get(messageId);
  if (inflight) return inflight;
  const pending = (async (): Promise<string | undefined> => {
    try {
      const threadId = (await ctx.lark.fetchMessage(messageId))?.threadId ?? undefined;
      cardThreadCache.set(messageId, threadId);
      if (cardThreadCache.size > 1000) {
        const oldest = cardThreadCache.keys().next().value;
        if (oldest !== undefined) cardThreadCache.delete(oldest);
      }
      return threadId;
    } catch {
      // 反查失败不缓存：本次按非话题处理，下次点击重试
      return undefined;
    }
  })();
  cardThreadInFlight.set(messageId, pending);
  void pending.finally(() => cardThreadInFlight.delete(messageId));
  return pending;
}
