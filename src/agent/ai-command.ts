import { randomUUID } from 'node:crypto';
import type { NormalizedMessage } from '@larksuite/channel';
import type { AppContext } from '../app-context.js';
import { sendChat } from '../lark/chat-lifecycle.js';
import { resolveShell, startShellCommand } from '../commands/shell.js';

/** AI 智能执行的环境事实（调用方注入，避免模型臆测与知识重复） */
export type AiCommandEnvironment = {
  platform: 'windows' | 'posix';
  /** 实际执行用的 shell 描述（派生自 resolveShell，保证与真实执行一致） */
  shell: string;
};

/**
 * AI 智能执行：把用户的大白话 / 命令翻译成目标平台真实可执行的命令（提示词构造，纯函数）。
 * 环境信息（平台 / shell / cwd）由调用方注入，避免模型臆测当前环境。
 */
export function buildAiCommandPrompt(cwd: string, env: AiCommandEnvironment, input: string): string {
  const platform = env.platform === 'windows' ? 'Windows' : 'macOS / Linux';
  const platformRules = env.platform === 'windows'
    ? '\n- Windows 必须使用 cmd 语法：列目录用 dir（ls 不可用）；跨盘切换目录需 cd /d；&& 可用；grep/find/head/tail 等 POSIX 管道工具不可用（可用 findstr 等替代）'
    : '\n- macOS/Linux 使用 POSIX 语法：~ 表示用户主目录';
  return [
    '你是命令翻译器。用户想执行以下内容（可能是大白话，也可能是命令），请生成用户真正想调用的命令。',
    '',
    '执行环境：',
    `- 平台：${platform}`,
    `- shell：${env.shell}`,
    `- 当前工作目录：${cwd}`,
    '',
    '处理要求：',
    '1. 区分执行环境，输出该平台可执行的合法命令',
    '2. 正确处理符号：全角符号一律转半角（如 ～ → ~、， → ,）；~ 表示用户主目录',
    '3. 输入本身已是命令时保持原样，仅修正明显格式错误（全角符号、参数拼写等）',
    platformRules,
    '4. 拒绝明显危险的操作（格式化磁盘、删除系统目录、无提示清空数据等）——此时 command 输出空字符串并在 reason 说明拒绝原因',
    '5. 不要真正执行命令，只输出翻译结果',
    '',
    '用户输入：',
    input,
    '',
    '输出严格 JSON（不要 markdown 代码块、不要任何额外文字）：',
    '{"command": "要执行的命令", "reason": "一句话说明生成思路"}',
  ].join('\n');
}

export type ParsedAiCommand = { command: string; reason: string };

/**
 * 解析 AI 翻译结果（纯函数，容错）：
 * - 剥 markdown code fence（模型偶尔不守约束）后优先 JSON.parse；
 * - JSON 且 command 为合法非空字符串 → 返回命令 + reason；
 * - JSON 且 command 为空字符串 → 拒绝语义（command: ''，reason 说明）；
 * - 非 JSON 或缺 command 字段 → 视为无效翻译，绝不降级执行自由文本。
 */
export function parseAiCommandOutput(output: string): ParsedAiCommand {
  let text = output.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) text = fence[1].trim();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object') {
      const { command, reason } = parsed as { command?: unknown; reason?: unknown };
      const reasonText = typeof reason === 'string' ? reason.trim() : '';
      if (typeof command === 'string' && command.trim()) return { command: command.trim(), reason: reasonText };
      if (typeof command === 'string' && command.trim() === '') return { command: '', reason: reasonText || '模型拒绝生成命令。' };
    }
  } catch {
    // Only the documented JSON protocol is executable.
  }
  return { command: '', reason: 'AI 返回格式无效，未执行命令。请重新提交。' };
}

/**
 * AI 智能执行编排：
 * 1. 每群固定「智能执行」session（懒创建持久化到 binding；独立于主会话，不参与电脑端同步、不触发公告）；
 *    首次创建时同步主 session 当前模型（保持一致体验；失败则用默认模型）；
 * 2. 翻译任务走 AgentRunManager 每群队列（与主对话互斥、复用停止按钮与 inFlight 防回环标记）；
 * 3. 翻译成功后转交 startShellCommand 执行（复用超时 / 常驻 / 流式卡 / 编码修复）；翻译失败或拒绝不执行。
 */
/** 首次创建「智能执行」session 的 in-flight 去重：并发提交共享同一创建过程，避免重复创建 session 文件 */
const creatingAiSessions = new Map<string, Promise<string>>();

export async function runAiCommand(
  ctx: AppContext,
  chatId: string,
  input: string,
  options: { timeoutSeconds?: number; background?: boolean; replyTo?: string; threadId?: string } = {},
): Promise<void> {
  const binding = ctx.state.get(chatId);
  if (!binding) return;
  const cwd = binding.cwd;
  let sessionFile = binding.aiCommandSessionFile;
  if (!sessionFile) {
    // in-flight 守卫 + 双检：并发提交共享同一创建过程（失败后清理，下次重试）
    let created = creatingAiSessions.get(chatId);
    if (!created) {
      created = (async (): Promise<string> => {
        const file = await ctx.pi.create(cwd, '智能执行');
        ctx.state.update(chatId, { aiCommandSessionFile: file });
        await ctx.state.flush();
        // 同步主 session 当前模型（首次创建时快照；失败则保持默认模型）
        if (binding.activeSessionFile) {
          const model = await ctx.pi.modelOf(cwd, binding.activeSessionFile).catch(() => undefined);
          if (model) await ctx.pi.setModel(cwd, file, model.provider, model.id).catch((error) => console.warn('[ai command model]', error));
        }
        return file;
      })();
      creatingAiSessions.set(chatId, created);
      void created.catch(() => undefined).finally(() => creatingAiSessions.delete(chatId));
    }
    sessionFile = await created;
  }
  // 环境事实派生自 resolveShell：保证提示词中的 shell 描述与真实执行一致（单一事实来源）
  const isWindows = process.platform === 'win32';
  const { shell, args, commandPrefix } = resolveShell();
  const env: AiCommandEnvironment = {
    platform: isWindows ? 'windows' : 'posix',
    shell: isWindows
      ? `${shell} ${args.join(' ')}（执行前自动前置 ${commandPrefix.trim()} 切换 UTF-8 代码页）`
      : `${shell} ${args.join(' ')}`,
  };
  const prompt = buildAiCommandPrompt(cwd, env, input);
  const displayPrompt = `AI 智能执行：${input}`;
  const id = randomUUID();
  const message: NormalizedMessage = {
    // 卡片触发无真实消息：仅当话题内回复时才有真实 messageId；空串占位，submit 侧转 undefined（UUID 不是合法 open_message_id）
    messageId: options.replyTo ?? '',
    chatId,
    chatType: binding.chatType ?? 'group',
    senderId: 'card',
    content: input,
    rawContentType: 'text',
    threadId: options.threadId,
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Date.now(),
  };
  await ctx.agentRuns.submit(message, {
    cwd,
    sessionFile,
    prompt,
    displayPrompt,
    id,
    onResult: (answer) => {
      const parsed = parseAiCommandOutput(answer);
      if (!parsed.command) {
        // AI 拒绝执行：展示原因（用户可见可审计），不进入命令执行
        void sendChat(ctx, chatId, { markdown: `**AI 智能执行未生成命令**\n\n${parsed.reason}` }, options.replyTo ? { replyTo: options.replyTo } : undefined)
          .catch((error) => console.warn('[ai command reject notice]', error));
        return;
      }
      const taskId = randomUUID();
      void startShellCommand(ctx, chatId, cwd, parsed.command, taskId, options.timeoutSeconds, options.background, options.replyTo).catch((error) => {
        console.error('[ai command]', error);
        void sendChat(ctx, chatId, { markdown: `命令启动失败：${error instanceof Error ? error.message : String(error)}` }, options.replyTo ? { replyTo: options.replyTo } : undefined)
          .catch((noticeError) => console.warn('[ai command fail notice]', noticeError));
      });
    },
  });
}
