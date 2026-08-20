import { randomUUID } from 'node:crypto';
import type { NormalizedMessage } from '@larksuite/channel';
import type { AppContext } from '../app-context.js';

/**
 * 快速提问编排（一次性无上下文 agent 问答，用于项目群任务之外的简单提问）：
 * 1. 每群固定「快速提问」session（懒创建持久化到 `binding.askSessionFile`，读取时兼容旧字段
 *    `aiCommandSessionFile`；独立于主会话，不参与电脑端同步、不触发公告）；
 *    首次创建时同步主 session 当前模型（保持一致体验；失败则用默认模型）；
 * 2. 提问任务走 AgentRunManager 每群队列（与主对话互斥、复用停止按钮与 inFlight 防回环标记）；
 * 3. 一次性、无上下文：用户输入原样作为 prompt，无提示词注入、无结果解析/命令转交，
 *    agent 回复由 agent 卡链（排队 → 运行 → 最终卡）直接呈现。
 */
/** 首次创建「快速提问」session 的 in-flight 去重：并发提交共享同一创建过程，避免重复创建 session 文件 */
const creatingAskSessions = new Map<string, Promise<string>>();

export async function runQuickAsk(
  ctx: AppContext,
  chatId: string,
  prompt: string,
  options: { replyTo?: string; threadId?: string } = {},
): Promise<void> {
  const binding = ctx.state.get(chatId);
  if (!binding) return;
  const cwd = binding.cwd;
  let sessionFile = binding.askSessionFile ?? binding.aiCommandSessionFile;
  if (!sessionFile) {
    // in-flight 守卫 + 双检：并发提交共享同一创建过程（失败后清理，下次重试）
    let created = creatingAskSessions.get(chatId);
    if (!created) {
      created = (async (): Promise<string> => {
        const file = await ctx.pi.create(cwd, '快速提问');
        // 新字段写入 askSessionFile，旧字段一并清掉（读取兼容只在历史数据上生效一次）
        ctx.state.update(chatId, { askSessionFile: file, aiCommandSessionFile: undefined });
        await ctx.state.flush();
        // 同步主 session 当前模型（首次创建时快照；失败则保持默认模型）
        if (binding.activeSessionFile) {
          const model = await ctx.pi.modelOf(cwd, binding.activeSessionFile).catch(() => undefined);
          if (model) await ctx.pi.setModel(cwd, file, model.provider, model.id).catch((error) => console.warn('[quick ask model]', error));
        }
        return file;
      })();
      creatingAskSessions.set(chatId, created);
      void created.catch(() => undefined).finally(() => creatingAskSessions.delete(chatId));
    }
    sessionFile = await created;
  }
  const id = randomUUID();
  const message: NormalizedMessage = {
    // 卡片触发无真实消息：仅当话题内回复时才有真实 messageId；空串占位，submit 侧转 undefined（UUID 不是合法 open_message_id）
    messageId: options.replyTo ?? '',
    chatId,
    chatType: binding.chatType ?? 'group',
    senderId: 'card',
    content: prompt,
    rawContentType: 'text',
    threadId: options.threadId,
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
  await ctx.agentRuns.submit(message, { cwd, sessionFile, prompt, displayPrompt: prompt, id });
}
