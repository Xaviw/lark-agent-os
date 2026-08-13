import type { AppContext } from '../app-context.js';
import { updateAnnouncement } from '../announcement.js';
import { sendChat } from './chat-lifecycle.js';

/** 创建项目群：建群 + 绑定 cwd + 欢迎消息 + 首条公告（被「创建项目群」卡片调用） */
export async function createProject(ctx: AppContext, userId: string, name: string, cwd: string): Promise<{ chatId: string }> {
  const created = await ctx.lark.createChat({ name, inviteUserIds: [userId], userIdType: 'open_id' });
  ctx.state.set(created.chatId, { cwd, chatType: 'group', updatedAt: new Date().toISOString() });
  await ctx.state.flush();
  await sendChat(ctx, created.chatId, { markdown: `已创建项目群 **${name}**\n\n工作目录：\`${cwd}\`\n\n请使用 \`/help\` 打开操作面板，再选择「新建会话」或「切换会话」。` });
  await updateAnnouncement(ctx, created.chatId);
  return created;
}
