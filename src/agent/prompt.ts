import { randomUUID } from 'node:crypto';
import type { NormalizedMessage } from '@larksuite/channel';
import type { AppContext } from '../app-context.js';
import { REPLY_CONTEXT_MAX_LENGTH } from '../config.js';
import { workspaceForChat } from '../sync/sync-service.js';
import { updateAnnouncement } from '../announcement.js';

export async function useNewSession(ctx: AppContext, chatId: string, cwd: string, name: string): Promise<void> {
  const sessionFile = await ctx.pi.create(cwd, name);
  ctx.state.update(chatId, { activeSessionFile: sessionFile, sessionSync: undefined });
  await ctx.state.flush();
  await ctx.sessionSyncWatcher.reconcile();
  await updateAnnouncement(ctx, chatId);
  await ctx.lark.send(chatId, { markdown: `已新建 session：\`${name}\`` });
}

/** 普通消息进入 Agent 流程：记录飞书来源（inFlightFeishuRun）后提交队列 */
export async function runPrompt(ctx: AppContext, message: NormalizedMessage, text: string): Promise<void> {
  const binding = ctx.state.get(message.chatId);
  if (!binding?.activeSessionFile) return;
  const { prompt, error } = await promptWithReplyContext(ctx, message, text);
  if (error) {
    // 引用消息获取失败：不进入 agent 流程（不建 run、不设 inFlightFeishuRun），直接展示错误原因
    await ctx.lark.send(message.chatId, { markdown: `无法处理引用消息：${error}` }, { replyTo: message.messageId });
    return;
  }
  const runId = randomUUID();
  await ctx.agentRuns.submit(message, workspaceForChat(ctx, message.chatId), binding.activeSessionFile, prompt, runId);
}

export async function promptWithReplyContext(ctx: AppContext, message: NormalizedMessage, text: string): Promise<{ prompt: string; error?: string }> {
  if (!message.replyToMessageId) return { prompt: text };
  try {
    const replied = await ctx.lark.fetchMessage(message.replyToMessageId);
    const content = replied?.content.trim();
    if (!replied || !content) return { prompt: text, error: '引用消息内容为空或不存在。' };
    const excerpt = content.length > REPLY_CONTEXT_MAX_LENGTH
      ? `${Array.from(content).slice(0, REPLY_CONTEXT_MAX_LENGTH).join('')}\n[引用消息已截断]`
      : content;
    const sender = replied.senderName?.trim() || replied.senderId;
    return { prompt: `<reply_context>\n回复消息发送者: ${sender}\n${excerpt}\n</reply_context>\n\n${text}` };
  } catch (error) {
    console.warn(`[reply context] ${message.messageId}:`, error);
    return { prompt: text, error: `无法获取引用消息：${error instanceof Error ? error.message : String(error)}` };
  }
}
