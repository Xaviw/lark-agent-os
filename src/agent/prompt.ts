import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { NormalizedMessage } from '@larksuite/channel';
import type { AppContext } from '../app-context.js';
import { ATTACHMENT_MESSAGE_TYPES, MEDIA_IMAGE_INJECT_LIMIT, REPLY_CONTEXT_MAX_LENGTH } from '../config.js';
import { resolveResource, type MediaResourceItem } from '../media/cache.js';
import { workspaceForChat } from '../sync/sync-service.js';
import { sessionFileForMessage } from '../lark/topics.js';
import { updateAnnouncement } from '../announcement.js';
import { sendChat } from '../lark/chat-lifecycle.js';
import { escapeMarkdown } from '../utils/format.js';
import type { PreparedPrompt, PromptImage } from '../types.js';

export async function useNewSession(ctx: AppContext, chatId: string, cwd: string, name: string): Promise<void> {
  const sessionFile = await ctx.pi.create(cwd, name);
  ctx.state.update(chatId, { activeSessionFile: sessionFile, sessionSync: undefined });
  await ctx.state.flush();
  await ctx.sessionSyncWatcher.reconcile();
  await updateAnnouncement(ctx, chatId);
  await sendChat(ctx, chatId, { markdown: `已新建 session：\`${name}\`` });
}

/** 快段产物：不含附件段的 prompt 骨架 + 待下载资源列表 */
export type QuotedContextSkeleton = {
  ok: true;
  /** 已注入引用文本的 prompt 骨架（附件段落待慢段补齐） */
  promptSkeleton: string;
  /** 引用消息携带的资源（需后台下载）；空则无需 prepare */
  pendingResources: MediaResourceItem[];
};

export type QuotedContextResult = QuotedContextSkeleton | { ok: false; error: string };

/**
 * 普通消息进入 Agent 流程：**立即**提交队列并发卡（附件在后台准备，见 prepareQuotedPrompt），
 * 避免「先等文件下载完成再显示卡片」的空白等待。
 */
export async function runPrompt(ctx: AppContext, message: NormalizedMessage, text: string): Promise<void> {
  const binding = ctx.state.get(message.chatId);
  // 话题消息使用话题独立 session（懒初始化）；普通消息使用主会话 activeSessionFile
  const sessionFile = await sessionFileForMessage(ctx, message);
  if (!binding || !sessionFile) return;
  // 换机/路径失效防护：cwd 或 session 文件在当前环境不存在时（如从其他机器迁移 state 后旧路径失效），
  // 直接进入 Agent 会让 pi SDK 在旧路径下 mkdir 重建目录树并把新对话写入错误位置；改为提示用户重新绑定。
  if (!(await workspacePathsExist(binding.cwd, sessionFile))) {
    await sendChat(ctx, message.chatId, { markdown: '项目路径在当前环境下不存在，请重新绑定项目或创建项目群。' }, { replyTo: message.messageId });
    return;
  }
  // 快段：模型视觉能力查询与引用上下文组装并行（均不下载附件）
  const [canViewImages, quoted] = await Promise.all([
    ctx.pi.supportsImages(binding.cwd, sessionFile),
    buildQuotedContext(ctx, message, text),
  ]);
  if (!quoted.ok) {
    // 引用消息获取失败：不进入 agent 流程（不建 run、不设 inFlightFeishuRun），直接展示错误原因
    await sendChat(ctx, message.chatId, { markdown: `无法处理引用消息：${quoted.error}` }, { replyTo: message.messageId });
    return;
  }
  const runId = randomUUID();
  await ctx.agentRuns.submit(message, {
    cwd: workspaceForChat(ctx, message.chatId),
    sessionFile,
    prompt: quoted.promptSkeleton,
    id: runId,
    prepare: quoted.pendingResources.length > 0
      ? () => prepareQuotedPrompt(ctx, quoted.promptSkeleton, quoted.pendingResources, canViewImages)
      : undefined,
  });
}

/**
 * 快段（无下载）：fetch 被引用消息并注入文本引用段；附件资源仅登记不下载。
 * fetch 失败 → error（不入 agent）；引用文本/资源为空 → 原样 prompt。
 */
export async function buildQuotedContext(ctx: AppContext, message: NormalizedMessage, text: string): Promise<QuotedContextResult> {
  if (!message.replyToMessageId) return { ok: true, promptSkeleton: text, pendingResources: [] };
  let replied: NormalizedMessage | undefined;
  try {
    replied = await ctx.lark.fetchMessage(message.replyToMessageId);
  } catch (error) {
    console.warn(`[reply context] ${message.messageId}:`, error);
    // 1069307 = 无访问权限（与云文档评论同码）；其余失败不向用户透传内部错误
    const userVisible = feishuErrorCode(error) === 1069307
      ? '无法读取被引用的消息：没有访问权限。'
      : '无法读取被引用的消息。';
    return { ok: false, error: userVisible };
  }
  if (!replied) return { ok: false, error: '引用消息不存在或内容为空。' };

  const parts: string[] = [];
  const content = replied.content.trim();
  // 纯附件类消息的 content 是 normalize 占位（如 ![image](key)），不注入；text/post 等真实文本照旧注入
  if (content && !ATTACHMENT_MESSAGE_TYPES.has(replied.rawContentType)) {
    const excerpt = content.length > REPLY_CONTEXT_MAX_LENGTH
      ? `${Array.from(content).slice(0, REPLY_CONTEXT_MAX_LENGTH).join('')}\n[引用消息已截断]`
      : content;
    const sender = replied.senderName?.trim() || replied.senderId;
    parts.push(`回复消息发送者: ${sender}\n${excerpt}`);
  }
  const promptSkeleton = parts.length > 0
    ? `<quoted_context>\n${parts.join('\n')}\n</quoted_context>\n\n${text}`
    : text;
  const pendingResources: MediaResourceItem[] = replied.resources.map((resource) => ({
    messageId: replied.messageId,
    resource,
  }));
  return { ok: true, promptSkeleton, pendingResources };
}

/**
 * 慢段（后台执行，提交后立即启动）：下载被引用资源 → 组装附件段落与 images → 最终 prompt。
 * 任一附件失败 → error（本轮不进 agent，run 以失败卡结束）。
 */
export async function prepareQuotedPrompt(
  ctx: AppContext,
  promptSkeleton: string,
  pendingResources: MediaResourceItem[],
  canViewImages: boolean,
): Promise<PreparedPrompt> {
  const parts: string[] = [];
  const images: PromptImage[] = [];
  for (const item of pendingResources) {
    const result = await resolveResource(ctx.lark, item);
    if (!result.ok) {
      console.warn('[quoted prepare] attachment failed', { fileKey: item.resource.fileKey, reason: result.userVisible });
      const name = item.resource.fileName?.trim();
      return { prompt: promptSkeleton, error: `附件${name ? ` ${escapeMarkdown(name)}` : ''}处理失败：${result.userVisible}` };
    }
    const { file } = result;
    const label = file.originalName ? `${file.originalName}（${file.hash.slice(0, 8)}）` : file.hash.slice(0, 8);
    if (file.mime.startsWith('image/') && file.size <= MEDIA_IMAGE_INJECT_LIMIT && canViewImages) {
      try {
        const data = await readFile(file.absPath).then((buffer) => buffer.toString('base64'));
        images.push({ data, mimeType: file.mime });
        // 同时注入本地路径：images 仅在本次 run 内存中（排队重启后 reconcile 恢复的 run 无 images），
        // 模型凭路径仍可自行读取，避免「已提供图片却看不到」的误导
        parts.push(`附件: ${label} · 图片已作为图片附件提供（模型可直接查看）· 本地路径: ${file.absPath}`);
        continue;
      } catch (error) {
        console.warn(`[quoted image] ${file.absPath}:`, error);
        // 读文件失败：降级为路径注入
      }
    }
    parts.push(`附件: ${label} · ${file.size} 字节 · ${file.mime} · 本地路径: ${file.absPath}`);
  }
  const attachmentBlock = parts.length > 0 ? `<quoted_context>\n${parts.join('\n')}\n</quoted_context>\n\n` : '';
  return {
    prompt: `${attachmentBlock}${promptSkeleton}`,
    ...(images.length > 0 ? { images } : {}),
  };
}

/** 换机/路径失效校验：cwd 目录与 session 文件任一在当前环境不存在即视为失效 */
async function workspacePathsExist(cwd: string, sessionFile: string): Promise<boolean> {
  try {
    await stat(cwd);
    await stat(sessionFile);
    return true;
  } catch {
    return false;
  }
}

/** 从 SDK 抛错中提取飞书错误码（axios 风格 response.data.code） */
function feishuErrorCode(error: unknown): number | undefined {
  const response = (error as { response?: { data?: { code?: number } } })?.response;
  return response?.data?.code;
}
