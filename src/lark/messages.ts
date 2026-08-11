import { randomUUID } from 'node:crypto';
import type { BotAddedEvent, NormalizedMessage } from '@larksuite/channel';
import type { AppContext } from '../app-context.js';
import { ATTACHMENT_MESSAGE_TYPES } from '../config.js';
import type { PiSessions } from '../pi.js';
import type { ChatBinding } from '../types.js';
import { botWelcomeCard, createSessionFormCard, helpCard, sessionPickerCard } from '../cards.js';
import { workspaceForChat } from '../sync/sync-service.js';
import { rememberCardThread } from './topics.js';
import { handleChatGone, sendChat } from './chat-lifecycle.js';
import { runPrompt } from '../agent/prompt.js';

/** 消息入口：私聊自动绑定默认工作区；群聊需 @bot 或 /help */
export async function handleMessage(ctx: AppContext, message: NormalizedMessage): Promise<void> {
  if (!allowed(ctx, message)) return;
  const text = message.content.trim();
  if (message.chatType === 'p2p') await ensureDirectChat(ctx, message.chatId);
  if (text === '/help') return showHelp(ctx, message.chatId, message.messageId, message.threadId);
  if (message.chatType !== 'p2p' && !message.mentionedBot) return;

  // 富媒体分流（此时仅剩：私聊任意消息 / 群聊 @bot 消息）：
  // - 贴纸：静默忽略（表达情绪，不下载不提示）；
  // - 图片 / 文件 / 音视频：不进 agent，回轻提示，用户「引用（回复）」该消息并附文字后处理（见 promptWithReplyContext）。
  const kind = message.rawContentType;
  if (kind === 'sticker') return;
  if (kind && ATTACHMENT_MESSAGE_TYPES.has(kind)) {
    await sendChat(
      ctx,
      message.chatId,
      { markdown: '已收到 ✅ 引用（回复）该文件并附上需求，即可让我处理' },
      { replyTo: message.messageId },
    );
    return;
  }

  const command = text.replace(/^<at>.*?<\/at>\s*/i, '').trim();
  if (command === '/help') return showHelp(ctx, message.chatId, message.messageId, message.threadId);
  if (!command) return; // 纯 @ 无文本 / 空消息不触发 agent
  if (command.startsWith('/')) {
    await sendChat(ctx, message.chatId, { markdown: '飞书仅支持 `/help` 文本命令，其他操作请在操作面板中完成。' }, { replyTo: message.messageId });
    return;
  }
  const binding = ctx.state.get(message.chatId);
  const cwd = workspaceForChat(ctx, message.chatId);
  if (!binding) {
    await sendChat(ctx, message.chatId, { markdown: '该群尚未绑定项目，请使用 `/help` 中的「绑定项目」。' }, { replyTo: message.messageId });
    return;
  }
  // 话题消息优先：使用话题独立 session（懒初始化在 runPrompt 内部完成），不依赖主会话 activeSessionFile
  if (message.threadId) {
    await runPrompt(ctx, message, text);
    return;
  }
  const sessions = await ctx.pi.list(cwd);
  if (!binding.activeSessionFile) return showSessionSetup(ctx, message, sessions, { message, text: command });
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

export async function showHelp(ctx: AppContext, chatId: string, replyTo?: string, threadId?: string): Promise<void> {
  const binding = ctx.state.get(chatId);
  const sent = await sendChat(ctx, chatId, { card: helpCard(workspaceForChat(ctx, chatId), Boolean(binding), Boolean(binding?.activeSessionFile), threadId ? 'topic' : 'group') }, replyTo ? { replyTo } : undefined);
  rememberCardThread(sent.messageId, threadId);
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
  const sent = await sendChat(ctx, message.chatId, { card }, { replyTo: message.messageId });
  rememberCardThread(sent.messageId, undefined); // 选择卡仅出现在普通消息路径（无话题），记录以命中后续卡片操作缓存
}

/**
 * 机器人被加入群聊（im.chat.member.bot.added_v1）：自动绑定默认工作区（后续可通过「修改绑定」更换）
 * 并发送欢迎卡；重复加群（binding 已存在）仅补发欢迎卡、不覆盖已有绑定。
 */
export async function handleBotAdded(ctx: AppContext, event: BotAddedEvent): Promise<void> {
  const chatId = event.chatId;
  if (!ctx.state.get(chatId)) {
    ctx.state.set(chatId, { cwd: ctx.defaultWorkspace, chatType: 'group', updatedAt: new Date().toISOString() });
    await ctx.state.flush();
  }
  try {
    await sendChat(ctx, chatId, { card: botWelcomeCard(workspaceForChat(ctx, chatId)) });
  } catch (error) {
    // 欢迎卡发送失败（含判定群不可达后的清理）不致命，记录日志
    console.warn(`[botAdded] ${chatId}: 欢迎卡发送失败`, error);
  }
}
