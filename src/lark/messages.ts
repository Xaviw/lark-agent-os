import { randomUUID } from 'node:crypto';
import type { NormalizedMessage } from '@larksuite/channel';
import type { AppContext } from '../app-context.js';
import type { PiSessions } from '../pi.js';
import type { ChatBinding } from '../types.js';
import { createSessionFormCard, helpCard, sessionPickerCard } from '../cards.js';
import { workspaceForChat } from '../sync/sync-service.js';
import { runPrompt } from '../agent/prompt.js';

/** 消息入口：私聊自动绑定默认工作区；群聊需 @bot 或 /help */
export async function handleMessage(ctx: AppContext, message: NormalizedMessage): Promise<void> {
  if (!allowed(ctx, message)) return;
  const text = message.content.trim();
  if (message.chatType === 'p2p') await ensureDirectChat(ctx, message.chatId);
  if (text === '/help') return showHelp(ctx, message.chatId, message.messageId);
  if (message.chatType !== 'p2p' && !message.mentionedBot) return;

  const command = text.replace(/^<at>.*?<\/at>\s*/i, '').trim();
  if (command === '/help') return showHelp(ctx, message.chatId, message.messageId);
  if (!command) return; // 纯 @ 无文本 / 空消息不触发 agent
  if (command.startsWith('/')) {
    await ctx.lark.send(message.chatId, { markdown: '飞书仅支持 `/help` 文本命令，其他操作请在操作面板中完成。' }, { replyTo: message.messageId });
    return;
  }
  const binding = ctx.state.get(message.chatId);
  const cwd = workspaceForChat(ctx, message.chatId);
  const sessions = await ctx.pi.list(cwd);
  if (!binding) {
    await ctx.lark.send(message.chatId, { markdown: '该群尚未绑定项目，请使用 `/help` 中的「绑定项目」。' }, { replyTo: message.messageId });
    return;
  }
  if (!binding.activeSessionFile) return showSessionSetup(ctx, message, sessions, { message, text: command });
  const active = ctx.state.get(message.chatId)?.activeSessionFile;
  if (!active) return;
  await runPrompt(ctx, message, text);
}

function allowed(ctx: AppContext, message: NormalizedMessage): boolean {
  return message.senderId !== ctx.lark.botIdentity?.openId;
}

async function ensureDirectChat(ctx: AppContext, chatId: string): Promise<ChatBinding> {
  const existing = ctx.state.get(chatId);
  if (existing) {
    if (existing.chatType !== 'p2p' || existing.cwd !== ctx.defaultWorkspace) {
      const binding = ctx.state.update(chatId, { chatType: 'p2p', cwd: ctx.defaultWorkspace });
      await ctx.state.flush();
      return binding!;
    }
    return existing;
  }
  return bindDirectChat(ctx, chatId);
}

async function bindDirectChat(ctx: AppContext, chatId: string): Promise<ChatBinding> {
  const binding: ChatBinding = {
    cwd: ctx.defaultWorkspace,
    chatType: 'p2p',
    updatedAt: new Date().toISOString(),
  };
  ctx.state.set(chatId, binding);
  await ctx.state.flush();
  return binding;
}

async function showHelp(ctx: AppContext, chatId: string, replyTo?: string): Promise<void> {
  const binding = ctx.state.get(chatId);
  await ctx.lark.send(chatId, { card: helpCard(workspaceForChat(ctx, chatId), Boolean(binding), Boolean(binding?.activeSessionFile)) }, replyTo ? { replyTo } : undefined);
}

async function showSessionSetup(
  ctx: AppContext,
  message: NormalizedMessage,
  sessions: Awaited<ReturnType<PiSessions['list']>>,
  prompt?: { message: NormalizedMessage; text: string },
): Promise<void> {
  const nonce = randomUUID();
  ctx.pending.set(message.chatId, { nonce, prompt });
  const card = sessions.length === 0
    ? createSessionFormCard(nonce, '新建 Session')
    : sessionPickerCard(workspaceForChat(ctx, message.chatId), sessions, nonce);
  await ctx.lark.send(message.chatId, { card }, { replyTo: message.messageId });
}
