import { readFile } from 'node:fs/promises';
import type { AppContext } from './app-context.js';
import { sessionDisplayName } from './cards.js';

const announcementQueues = new Map<string, Promise<void>>();

/** 群公告：切换/新建/恢复/重命名 session、切换模型、设置 thinkingLevel、服务启动时触发（不含 compact）；私聊不维护 */
export async function updateAnnouncement(ctx: AppContext, chatId: string): Promise<void> {
  const previous = announcementQueues.get(chatId) ?? Promise.resolve();
  const next = previous.then(
    () => updateAnnouncementOnce(ctx, chatId),
    () => updateAnnouncementOnce(ctx, chatId),
  );
  const tracked = next.catch(() => undefined);
  announcementQueues.set(chatId, tracked);
  void tracked.finally(() => {
    if (announcementQueues.get(chatId) === tracked) announcementQueues.delete(chatId);
  });
  return next;
}

async function updateAnnouncementOnce(ctx: AppContext, chatId: string): Promise<void> {
  const binding = ctx.state.get(chatId);
  if (!binding || binding.chatType === 'p2p') return;
  try {
    const announcement = await ctx.api.announcement(chatId);
    const blocks = await ctx.api.announcementBlocks(chatId);
    const textBlock = blocks.find((block) => block.block_type === 2 && block.text);
    if (!binding.activeSessionFile) {
      // 已绑定但未选 Session（如改绑后）：更新为占位内容，避免公告残留旧项目信息。
      // 从未有过公告的群（如新建项目群、服务启动时未选 session）不创建占位公告——避免未选 session 就置顶打扰。
      if (!textBlock) return;
      await ctx.api.updateAnnouncement(chatId, announcement.revision_id, textBlock.block_id, `Project: ${binding.cwd}\nProvider: unknown\nModel: unknown · Thinking: unknown\nWork Path: ${binding.cwd}\nSession: 未选择`);
      return;
    }
    await ctx.pi.ensure(binding.cwd, binding.activeSessionFile);
    const metadata = await readSessionMetadata(binding.activeSessionFile);
    const session = (await ctx.pi.list(binding.cwd)).find((item) => item.path === binding.activeSessionFile);
    const sessionName = session ? sessionDisplayName(session) : binding.activeSessionFile.split('/').pop()!;
    const content = `Project: ${metadata.cwd}\nProvider: ${metadata.provider ?? 'unknown'}\nModel: ${metadata.model ?? 'unknown'} · Thinking: ${metadata.thinkingLevel ?? 'unknown'}\nWork Path: ${binding.cwd}\nSession: ${sessionName}`;
    if (!textBlock) {
      const rootBlock = blocks.find((block) => block.block_type === 1 && block.page);
      if (!rootBlock) { console.warn(`[announcement] no root block in ${chatId}`); return; }
      await ctx.api.createAnnouncementTextBlock(chatId, rootBlock.block_id, announcement.revision_id, content);
      await ctx.api.pinAnnouncement(chatId);
    } else {
      await ctx.api.updateAnnouncement(chatId, announcement.revision_id, textBlock.block_id, content);
    }
  } catch (error) { console.warn(`[announcement] ${chatId}:`, error); }
}

async function readSessionMetadata(file: string): Promise<{ cwd: string; provider?: string; model?: string; thinkingLevel?: string }> {
  const lines = (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as any);
  const header = lines.find((entry) => entry.type === 'session');
  const model = [...lines].reverse().find((entry) => entry.type === 'model_change');
  const thinking = [...lines].reverse().find((entry) => entry.type === 'thinking_level_change');
  return { cwd: header?.cwd ?? '', provider: model?.provider, model: model?.modelId, thinkingLevel: thinking?.thinkingLevel };
}
