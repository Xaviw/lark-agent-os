import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { CardActionEvent, CardActionResponse, NormalizedMessage, SendInput } from '@larksuite/channel';
import type { AppContext } from '../app-context.js';
import { CARD_EVENT_SEEN_TTL_MS, COMMAND_CARD_OUTPUT_LIMIT, PENDING_PROMPT_MAX_MS } from '../config.js';
import { createSeenSet } from '../utils/seen.js';
import { takePendingPrompt } from '../utils/pending-prompt.js';
import type { PiThinkingLevel } from '../pi.js';
import { bgTaskListCard, bindProjectFormCard, commandFinalCard, commandFormCard, createProjectFormCard, createSessionFormCard, modelPickerCard, renameSessionFormCard, sessionDisplayName, sessionPickerCard, syncFormCard, thinkingLevelPickerCard } from '../cards.js';
import { commandOutputMarkdown, defaultProjectName, resolveWorkspacePath } from '../utils/format.js';
import { parseSyncCount, syncComputerSessions, workspaceForChat } from '../sync/sync-service.js';
import { startShellCommand } from '../commands/shell.js';
import { runAiCommand } from '../agent/ai-command.js';
import { updateAnnouncement } from '../announcement.js';
import { runPrompt, useNewSession } from '../agent/prompt.js';
import { createProject } from './projects.js';
import { cardThreadId, ensureThreadSession, rememberCardThread } from './topics.js';
import { showHelp } from './messages.js';
import { sendChat } from './chat-lifecycle.js';

/** 话题内不可用的卡片操作（会话管理 / 项目绑定 / 同步属群级操作，help 已去入口，此处防旧卡/直连触发） */
const TOPIC_BLOCKED_CMDS = new Set([
  'session.new.form', 'session.resume.form', 'session.create.submit', 'session.use',
  'project.bind.form', 'project.bind.submit', 'session.sync.form', 'session.sync.submit',
]);

/** 卡片事件防重推（event_id 去重，内存态，重启即清） */
const seenCardEvents = createSeenSet(CARD_EVENT_SEEN_TTL_MS);

/** 卡片动作分发：全部 cmd 分支 + 表单解析工具 */
export async function handleCardAction(ctx: AppContext, event: CardActionEvent): Promise<CardActionResponse> {
  // 防重推：长连接事件无 X-Refresh-Token header，用事件唯一 ID（event_id）去重——
  // 平台重推携带相同 event_id（SDK 12h dedup 缩短为秒级后由本层兜底 30 分钟窗口）；合法再次点击是新 event_id，不受影响。
  const raw = (event.raw ?? {}) as Record<string, unknown>;
  const eventId = typeof raw.event_id === 'string' ? raw.event_id : undefined;
  if (eventId && seenCardEvents.has(eventId)) {
    console.debug(`[cardAction] 拦截重推事件 ${eventId}`);
    return toast('warning', '该操作已处理，请查看最新消息。');
  }
  if (eventId) seenCardEvents.add(eventId);
  const value = event.action.value as Record<string, unknown> | undefined;
  if (!value || typeof value !== 'object') return toast('warning', '无效的卡片操作。');
  const cmd = value.cmd;
  // 惰性话题感知：仅在需要话题语义的路径反查。发送侧已记录卡片 messageId → threadId（rememberCardThread），
  // 普通群卡片链（help → 表单 → 提交）直接命中缓存，零网络开销；仅重启后的旧卡回退 fetchMessage 反查。
  let threadId: string | undefined;
  let threadResolved = false;
  const resolveThread = async (): Promise<string | undefined> => {
    if (!threadResolved) { threadId = await cardThreadId(ctx, event.messageId); threadResolved = true; }
    return threadId;
  };
  // 话题内响应回复到触发卡（保持在话题窗口内）；发送后记录新卡上下文，供后续操作直接命中缓存
  const send = async (input: SendInput): Promise<void> => {
    const sent = await sendChat(ctx, event.chatId, input, (await resolveThread()) ? { replyTo: event.messageId } : undefined);
    rememberCardThread(sent.messageId, threadId);
  };
  if (typeof cmd === 'string' && TOPIC_BLOCKED_CMDS.has(cmd) && (await resolveThread())) return toast('warning', '话题内不支持该操作，请回到群聊使用。');
  // 欢迎卡「打开操作面板」按钮入口（复用 /help 路径；话题内也可打开裁剪版面板）
  if (cmd === 'help') {
    const tid = await resolveThread();
    await showHelp(ctx, event.chatId, event.messageId, tid);
    return toast('success', '已打开操作面板。');
  }
  if (cmd === 'command.form') {
    if (!ctx.state.get(event.chatId)) return toast('error', '该群尚未绑定项目。');
    await send({ card: commandFormCard(workspaceForChat(ctx, event.chatId), process.platform === 'win32') });
    return toast('success', '已打开命令执行表单。');
  }
  if (cmd === 'command.submit') {
    const binding = ctx.state.get(event.chatId);
    if (!binding) return toast('error', '该群尚未绑定项目。');
    const form = cardFormValue(event);
    const command = form.command;
    const aiCommand = form.aiCommand?.trim();
    if (!command && !aiCommand) return toast('error', '请填写命令或 AI 智能执行内容。');
    const isBackground = cardFormFlag(event, 'isBackground');
    // 常驻任务模式忽略超时：跳过格式校验（“忽略超时秒数”语义）
    const timeoutSeconds = isBackground ? undefined : parseCommandTimeout(form.timeoutSeconds);
    if (timeoutSeconds === null) return toast('error', '超时必须是 1 到 86400 之间的整数秒。');
    if (aiCommand) {
      // AI 智能执行优先于命令框（都填时走 AI）；回复到触发表单卡（保持话题窗口）
      const tid = await resolveThread();
      void runAiCommand(ctx, event.chatId, aiCommand, { timeoutSeconds, background: isBackground, replyTo: tid ? event.messageId : undefined, threadId: tid }).catch((error) => {
        console.error('[ai command]', error);
        void send({ markdown: `AI 智能执行启动失败：${error instanceof Error ? error.message : String(error)}` }).catch((noticeError) => console.warn('[ai command fail notice]', noticeError));
      });
      return toast('success', '已提交 AI 智能执行。');
    }
    const taskId = randomUUID();
    // 话题上下文：命令卡回复到触发表单卡（保持在话题窗口内）
    void startShellCommand(ctx, event.chatId, workspaceForChat(ctx, event.chatId), command, taskId, isBackground ? undefined : timeoutSeconds, isBackground, (await resolveThread()) ? event.messageId : undefined).catch((error) => {
      console.error('[command]', error);
      // 启动前失败（starting 卡发送失败等）用户无感知，补发失败消息（spawn 失败本身已有失败卡）
      void send({ markdown: `命令启动失败：${error instanceof Error ? error.message : String(error)}` }).catch((noticeError) => console.warn('[command fail notice]', noticeError));
    });
    return toast('success', isBackground ? '后台任务已启动。' : '命令已开始执行。');
  }
  if (cmd === 'agent.stop' && typeof value.taskId === 'string') {
    if (!ctx.agentRuns.stop(event.chatId, value.taskId)) return toast('warning', '该 Agent 已结束。');
    return toast('success', '正在停止 Agent。');
  }
  if (cmd === 'command.stop' && typeof value.taskId === 'string') {
    const task = ctx.commandTasks.get(value.taskId);
    if (!task || task.chatId !== event.chatId) return toast('warning', '该命令已经结束。');
    task.stopped = true;
    task.terminate();
    if (task.updater) void task.updater.finish(commandFinalCard('正在停止命令', `${commandOutputMarkdown(task.command, task.stdout, task.stderr, COMMAND_CARD_OUTPUT_LIMIT)}\n\n正在停止命令。`))
      .catch((error) => console.warn('[command stop status]', error));
    return toast('success', '正在停止命令。');
  }
  if (cmd === 'project.create.form') {
    const baseCwd = workspaceForChat(ctx, event.chatId);
    await send({ card: createProjectFormCard(baseCwd) });
    return toast('success', '已打开创建项目群表单。');
  }
  if (cmd === 'project.create.submit') {
    const form = cardFormValue(event);
    const cwdInput = form.cwd;
    if (!cwdInput) return toast('error', '请填写工作路径。');
    const baseCwd = workspaceForChat(ctx, event.chatId);
    let cwd: string;
    try {
      cwd = resolveWorkspacePath(cwdInput, baseCwd);
    } catch (error) {
      return toast('error', error instanceof Error ? error.message : '工作路径无效。');
    }
    const name = form.name || defaultProjectName(cwd);
    const created = await createProject(ctx, event.operator.openId, name, cwd);
    await send({ markdown: `已创建项目群 **${name}**。` });
    return toast('success', `已创建项目群（${created.chatId.slice(-8)}）。`);
  }
  if (cmd === 'project.bind.form') {
    if (ctx.state.get(event.chatId)?.chatType === 'p2p') return toast('warning', '私聊固定使用默认工作区，不支持绑定项目。');
    const baseCwd = workspaceForChat(ctx, event.chatId);
    await send({ card: bindProjectFormCard(baseCwd, Boolean(ctx.state.get(event.chatId))) });
    return toast('success', '已打开绑定项目表单。');
  }
  if (cmd === 'project.bind.submit') {
    if (ctx.state.get(event.chatId)?.chatType === 'p2p') return toast('warning', '私聊固定使用默认工作区，不支持绑定项目。');
    const form = cardFormValue(event);
    const cwdInput = form.cwd;
    if (!cwdInput) return toast('error', '请填写工作路径。');
    const baseCwd = workspaceForChat(ctx, event.chatId);
    let cwd: string;
    try {
      cwd = resolveWorkspacePath(cwdInput, baseCwd);
    } catch (error) {
      return toast('error', error instanceof Error ? error.message : '工作路径无效。');
    }
    const bound = Boolean(ctx.state.get(event.chatId));
    // 绑定/改绑后清空活动 session 与同步状态，下一条普通消息自动走 new / resume 选择卡（与切换 session 同策略）
    ctx.state.update(event.chatId, {
      cwd,
      chatType: 'group',
      activeSessionFile: undefined,
      sessionSync: undefined,
      feishuOriginEntryIds: undefined,
      inFlightFeishuRun: undefined,
    });
    await ctx.state.flush();
    await ctx.sessionSyncWatcher.reconcile();
    if (!(await resolveThread())) void updateAnnouncement(ctx, event.chatId);
    return toast('success', bound ? '已修改项目绑定。' : '已绑定项目。');
  }
  if (cmd === 'bgTask.form') {
    await send({ card: bgTaskListCard([...ctx.backgroundTasks.values()].map((task) => ({ id: task.id, command: task.command, startedAt: task.startedAt }))) });
    return toast('success', '已打开后台任务列表。');
  }
  if (cmd === 'bgTask.stop' && typeof value.taskId === 'string') {
    const task = ctx.backgroundTasks.get(value.taskId);
    if (!task) return toast('warning', '该后台任务已结束。');
    task.terminate();
    ctx.backgroundTasks.delete(value.taskId);
    await send({ card: bgTaskListCard([...ctx.backgroundTasks.values()].map((task) => ({ id: task.id, command: task.command, startedAt: task.startedAt }))) });
    return toast('success', '后台任务已停止。');
  }
  const binding = ctx.state.get(event.chatId);
  if (!binding) return toast('error', '该群尚未绑定项目。');
  const cwd = workspaceForChat(ctx, event.chatId);
  // 话题上下文：会话 = 话题独立 session（懒初始化，先于任何会话操作完成绑定）；普通群 = 主会话 activeSessionFile
  const tid = await resolveThread();
  const activeSessionFile = tid ? await ensureThreadSession(ctx, event.chatId, tid, cwd) : binding.activeSessionFile;
  const requireActiveSession = (): string | undefined => activeSessionFile;

  if (cmd === 'session.new.form') {
    await send({ card: createSessionFormCard('新建 Session') });
    return toast('success', '请填写 Session 名称。');
  }
  if (cmd === 'session.resume.form') {
    const sessions = await ctx.pi.list(cwd);
    if (sessions.length === 0) return toast('warning', '当前路径没有可恢复的 Session，请使用 new。');
    await send({ card: sessionPickerCard(cwd, sessions) });
    return toast('success', '请选择要恢复的 Session。');
  }
  if (cmd === 'model.form') {
    if (!requireActiveSession()) return toast('warning', '请先使用 new 或 resume 选择 Session。');
    const models = await ctx.pi.models();
    if (models.length === 0) return toast('error', '没有可用的 provider/model。');
    await send({ card: modelPickerCard(models) });
    return toast('success', '请选择 provider/model。');
  }
  if (cmd === 'thinkingLevel.form') {
    const sessionFile = requireActiveSession();
    if (!sessionFile) return toast('warning', '请先使用 new 或 resume 选择 Session。');
    const thinkingLevels = await ctx.pi.thinkingLevels(cwd, sessionFile);
    if (thinkingLevels.length === 0) return toast('warning', '当前 model 不支持思考强度设置。');
    await send({ card: thinkingLevelPickerCard(thinkingLevels) });
    return toast('success', '请选择思考强度。');
  }
  if (cmd === 'session.sync.form') {
    if (!requireActiveSession()) return toast('warning', '请先使用 new 或 resume 选择 Session。');
    await send({ card: syncFormCard() });
    return toast('success', '请填写同步条数。');
  }
  if (cmd === 'session.sync.submit') {
    const sessionFile = requireActiveSession();
    if (!sessionFile) return toast('warning', '请先使用 new 或 resume 选择 Session。');
    if (!(await sessionFileExists(sessionFile))) return toast('warning', '该 Session 已不存在，请重新选择 Session。');
    const count = parseSyncCount(cardFormValue(event).count);
    if (count === null) return toast('error', '同步条数必须是正整数。');
    const result = await syncComputerSessions(ctx, event.chatId, 'manual', count);
    if (result.retry) return toast('warning', 'Session 正在写入，请稍后重试。');
    if (result.busy) return toast('warning', 'Agent 正在处理消息，请稍后再同步。');
    if (result.progressReset) return toast('warning', 'Session 文件已更新（可能已压缩），同步进度已重置。请再次同步；结果可能包含已发送的历史轮次。');
    if (result.sent === 0) await send({ markdown: '无待同步消息。' });
    return toast('success', result.sent ? `已同步 ${result.sent} 轮对话${result.truncated ? '（内容已截断）' : ''}。` : '无待同步消息。');
  }
  if (cmd === 'session.rename.form') {
    if (!requireActiveSession()) return toast('warning', '请先使用 new 或 resume 选择 Session。');
    await send({ card: renameSessionFormCard() });
    return toast('success', '请填写 Session 名称。');
  }
  if (cmd === 'session.compact') {
    const sessionFile = requireActiveSession();
    if (!sessionFile) return toast('warning', '请先使用 new 或 resume 选择 Session。');
    void ctx.pi.compact(cwd, sessionFile).catch((error) => {
      console.error('[compact]', error);
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 200);
      void send({ markdown: `Session 压缩失败：${reason}` }).catch((noticeError) => console.warn('[compact fail notice]', noticeError));
    });
    return toast('success', '正在压缩 Session 上下文。');
  }
  if (cmd === 'model.select' && typeof value.provider === 'string' && typeof value.modelId === 'string') {
    const sessionFile = requireActiveSession();
    if (!sessionFile) return toast('warning', '请先使用 new 或 resume 选择 Session。');
    if (!(await sessionFileExists(sessionFile))) return toast('warning', '该 Session 已不存在，请重新选择 Session。');
    const selected = await ctx.pi.setModel(cwd, sessionFile, value.provider, value.modelId);
    if (!tid) void updateAnnouncement(ctx, event.chatId);
    return toast('success', `已切换到 ${selected.provider}/${selected.name}。`);
  }
  if (cmd === 'thinkingLevel.select' && typeof value.thinkingLevel === 'string') {
    const sessionFile = requireActiveSession();
    if (!sessionFile) return toast('warning', '请先使用 new 或 resume 选择 Session。');
    if (!(await sessionFileExists(sessionFile))) return toast('warning', '该 Session 已不存在，请重新选择 Session。');
    await ctx.pi.setThinkingLevel(cwd, sessionFile, value.thinkingLevel as PiThinkingLevel);
    if (!tid) void updateAnnouncement(ctx, event.chatId);
    return toast('success', `已设置思考强度：${value.thinkingLevel}。`);
  }
  if (cmd === 'session.rename.submit') {
    const sessionFile = requireActiveSession();
    if (!sessionFile) return toast('warning', '请先使用 new 或 resume 选择 Session。');
    if (!(await sessionFileExists(sessionFile))) return toast('warning', '该 Session 已不存在，请重新选择 Session。');
    const name = cardFormValue(event).name.replace(/[\r\n]+/g, ' ').trim();
    if (!name) return toast('error', '请填写 Session 名称。');
    await ctx.pi.rename(cwd, sessionFile, name);
    if (!tid) void updateAnnouncement(ctx, event.chatId);
    return toast('success', `已命名为 ${name}。`);
  }
  let selected: string;
  if (cmd === 'session.create.submit') {
    const name = cardFormValue(event).name.replace(/[\r\n]+/g, ' ').trim();
    if (!name) return toast('error', '请填写 Session 名称。');
    await useNewSession(ctx, event.chatId, cwd, name);
    selected = name;
  } else if (cmd === 'session.use' && typeof value.sessionFile === 'string') {
    const sessions = await ctx.pi.list(cwd);
    const selectedSession = sessions.find((session) => session.path === value.sessionFile);
    if (!selectedSession) return toast('error', '该 Session 不属于当前项目或已不存在。');
    ctx.state.update(event.chatId, { activeSessionFile: value.sessionFile, sessionSync: undefined });
    await ctx.state.flush();
    await ctx.sessionSyncWatcher.reconcile();
    selected = sessionDisplayName(selectedSession);
  } else return toast('warning', '不支持的卡片操作。');
  if (!tid) void updateAnnouncement(ctx, event.chatId);
  // 挂起消息一次性续跑（消费即删；超过 PENDING_PROMPT_MAX_MS 不再续跑）——历史卡重复点击只切换、不重复发送
  const pendingPrompt = takePendingPrompt(ctx.pending, event.chatId, PENDING_PROMPT_MAX_MS);
  if (pendingPrompt.kind === 'ok') {
    void runPrompt(ctx, pendingPrompt.message, pendingPrompt.text).catch((error) => {
      console.error('[card prompt]', error);
      // runPrompt 内已提示的路径为 return 不 throw，此处兜底未覆盖异常，避免「提示正在处理但实际未处理」的静默失败
      void send({ markdown: `消息处理失败：${error instanceof Error ? error.message : String(error)}` }).catch((noticeError) => console.warn('[card prompt fail notice]', noticeError));
    });
    return toast('success', `已切换到 ${selected}，正在处理消息。`);
  }
  if (pendingPrompt.kind === 'expired') return toast('warning', `已切换到 ${selected}。之前挂起的消息已超过 ${PENDING_PROMPT_MAX_MS / 60_000} 分钟未处理，请重新发送。`);
  return toast('success', `已切换到 ${selected}。`);
}

function parseCommandTimeout(value: string | undefined): number | undefined | null {
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) return null;
  const seconds = Number.parseInt(value, 10);
  return seconds >= 1 && seconds <= 86_400 ? seconds : null;
}

/** 会话文件是否存在（历史卡操作时当前 session 可能已被删除 / 换机路径失效） */
async function sessionFileExists(sessionFile: string): Promise<boolean> {
  try {
    await stat(sessionFile);
    return true;
  } catch {
    return false;
  }
}

function toast(type: 'success' | 'info' | 'warning' | 'error', content: string): CardActionResponse {
  return { toast: { type, content } };
}

function cardFormValue(event: CardActionEvent): Record<string, string> {
  return Object.fromEntries(Object.entries(rawFormValue(event)).flatMap(([key, item]) =>
    typeof item === 'string' ? [[key, item.trim()]] : [],
  ));
}

/** 提取卡片表单原始 form_value（string / boolean 等） */
function rawFormValue(event: CardActionEvent): Record<string, unknown> {
  const raw = event.raw as { action?: { form_value?: Record<string, unknown> } } | undefined;
  return event.action.formValue ?? raw?.action?.form_value ?? {};
}

/** 读取卡片表单中的布尔字段（如 checker 常驻任务勾选） */
function cardFormFlag(event: CardActionEvent, key: string): boolean {
  return rawFormValue(event)[key] === true;
}
