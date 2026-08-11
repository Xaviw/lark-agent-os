import type { SendInput, SendOptions, SendResult } from '@larksuite/channel';
import type { AppContext } from '../app-context.js';

/**
 * 判断错误是否表示「群不可达」（机器人被移出群 / 群已解散），纯函数。
 * 依据（飞书官方错误码 + @larksuite/channel 的 classifyError 归一化）：
 * - `10030` bot not in chat：机器人不在会话（被移出群）；
 * - `232009` group has been dissolved：群已被解散；
 * - `code === 'target_revoked'`（230017 / 230020 / HTTP 404）：发送目标被撤销。
 *   仅在 `strictTarget`（发送不指向消息、无 replyTo）时视为群级——带 replyTo 的失败
 *   可能是回复目标消息被删除，不得误伤清理；消息级错误（如 10020 message id not exist、
 *   230001/230002 参数错误）不会命中特征。
 */
export function isChatUnreachable(error: unknown, strictTarget = false): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code;
  if (strictTarget && code === 'target_revoked') return true;
  const cause = (error as { cause?: unknown }).cause;
  const message = `${error.message} ${cause instanceof Error ? cause.message : ''}`.toLowerCase();
  // 群级特征收紧：不匹配「群成员不存在」等非群级措辞（锚定「群/群组」紧跟状态词）
  return /(?:10030|bot not in chat|232009|dissolved|已解散|机器人不在(?:会话|群)|群(?:组)?(?:已不存在|不存在|已删除))/.test(message);
}

/**
 * 群消息发送 + 群失效兜底：发送失败且判定群不可达时自动清理该群全部本地状态（幂等）；
 * 失败仍向上抛，由调用方兜底日志（不吞错）。
 */
export async function sendChat(ctx: AppContext, chatId: string, input: SendInput, opts?: SendOptions): Promise<SendResult> {
  try {
    return await ctx.lark.send(chatId, input, opts);
  } catch (error) {
    // 无 replyTo 的发送没有消息目标，target_revoked 只可能是群级撤销 → 可安全清理
    try {
      await handleChatGone(ctx, chatId, error, !opts?.replyTo);
    } catch (cleanupError) {
      // 清理失败不得吞掉原始发送错误：隔离并记录，原错误继续上抛（错误链保持真实）
      console.warn(`[chat lifecycle] ${chatId}: 群失效清理失败`, cleanupError);
    }
    throw error;
  }
}

/** 发送/更新失败时判定群失效：是则触发清理；否则仅返回（失败由调用方兜底） */
export async function handleChatGone(ctx: AppContext, chatId: string, error: unknown, strictTarget = false): Promise<void> {
  if (!isChatUnreachable(error, strictTarget)) return;
  const detail = error instanceof Error ? error.message.slice(0, 160) : String(error);
  await cleanupChat(ctx, chatId, `群不可达（${detail}）`);
}

/**
 * 清理失效群的全部本地状态（幂等）：
 * 取消该群 Agent run（queued → cancelled + inFlight 释放，running → abort）→ 终止前台命令 →
 * 清 pending（含话题前缀 key）→ 停同步调度 → 删除 binding → 触发 watcher reconcile 释放目录监听。
 * 后台任务不按群索引（BackgroundTask 无 chatId 字段），全局保留——其 cwd 可能仍有效，且不受群生命周期影响。
 */
export async function cleanupChat(ctx: AppContext, chatId: string, reason: string): Promise<void> {
  if (!ctx.state.get(chatId)) return;
  console.warn(`[chat lifecycle] 清理失效群 ${chatId}：${reason}`);
  ctx.agentRuns.cancelChat(chatId);
  for (const [id, task] of ctx.commandTasks) {
    if (task.chatId === chatId) {
      task.terminate();
      ctx.commandTasks.delete(id);
    }
  }
  for (const key of [...ctx.pending.keys()]) {
    if (key === chatId || key.startsWith(`${chatId}:`)) ctx.pending.delete(key);
  }
  ctx.sessionSyncWatcher.forget(chatId);
  ctx.state.delete(chatId);
  await ctx.state.flush();
  // 释放该群可能独占的目录 watcher（其他群共享的目录保留）
  void ctx.sessionSyncWatcher.reconcile().catch((error) => console.warn('[chat lifecycle reconcile]', error));
}
