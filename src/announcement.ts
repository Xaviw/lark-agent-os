import { readFile } from 'node:fs/promises';
import type { AppContext } from './app-context.js';
import { sessionDisplayName } from './cards.js';

/** 群公告：切换/新建/恢复/重命名 session、切换模型、设置 thinkingLevel、服务启动时触发（不含 compact）；私聊不维护 */
export async function updateAnnouncement(ctx: AppContext, chatId: string): Promise<void> {
  const binding = ctx.state.get(chatId);
  if (!binding?.activeSessionFile || binding.chatType === 'p2p') return;
  try {
    await ctx.pi.ensure(binding.cwd, binding.activeSessionFile);
    const metadata = await readSessionMetadata(binding.activeSessionFile);
    const session = (await ctx.pi.list(binding.cwd)).find((item) => item.path === binding.activeSessionFile);
    const sessionName = session ? sessionDisplayName(session) : binding.activeSessionFile.split('/').pop()!;
    const announcement = await ctx.api.announcement(chatId);
    const blocks = await ctx.api.announcementBlocks(chatId);
    const content = `Project: ${metadata.cwd}\nProvider: ${metadata.provider ?? 'unknown'}\nModel: ${metadata.model ?? 'unknown'} · Thinking: ${metadata.thinkingLevel ?? 'unknown'}\nWork Path: ${binding.cwd}\nSession: ${sessionName}`;
    const textBlock = blocks.find((block) => block.block_type === 2 && block.text);
    if (!textBlock) {
      const rootBlock = blocks.find((block) => block.block_type === 1 && block.page);
      if (!rootBlock) { console.warn(`[announcement] no root block in ${chatId}`); return; }
      await ctx.api.createAnnouncementTextBlock(chatId, rootBlock.block_id, announcement.revision_id, content);
      await ctx.api.pinAnnouncement(chatId);
      const updated = await ctx.api.announcement(chatId);
      ctx.state.update(chatId, { announcementRevision: updated.revision_id });
    } else {
      const revision = await ctx.api.updateAnnouncement(chatId, announcement.revision_id, textBlock.block_id, content);
      ctx.state.update(chatId, { announcementRevision: revision });
    }
    await ctx.state.flush();
  } catch (error) { console.warn(`[announcement] ${chatId}:`, error); }
}

async function readSessionMetadata(file: string): Promise<{ cwd: string; provider?: string; model?: string; thinkingLevel?: string }> {
  const lines = (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as any);
  const header = lines.find((entry) => entry.type === 'session');
  const model = [...lines].reverse().find((entry) => entry.type === 'model_change');
  const thinking = [...lines].reverse().find((entry) => entry.type === 'thinking_level_change');
  return { cwd: header?.cwd ?? '', provider: model?.provider, model: model?.modelId, thinkingLevel: thinking?.thinkingLevel };
}
