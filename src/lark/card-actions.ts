import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { CardActionEvent, CardActionResponse, NormalizedMessage, SendInput } from '@larksuite/channel';
import type { AppContext } from '../app-context.js';
import { CARD_EVENT_SEEN_TTL_MS, COMMAND_CARD_OUTPUT_LIMIT, PENDING_PROMPT_MAX_MS } from '../config.js';
import { createSeenSet } from '../utils/seen.js';
import { createCardUpdater } from '../utils/card-update.js';
import { takePendingPrompt } from '../utils/pending-prompt.js';
import type { CardUpdater } from '../types.js';
import type { PiThinkingLevel } from '../pi.js';
import { askFormCard, bgTaskListCard, bindProjectFormCard, commandFinalCard, commandFormCard, compactFailureCard, compactStartingCard, compactSuccessCard, createProjectFormCard, createSessionFormCard, modelPickerCard, renameSessionFormCard, sessionDisplayName, sessionPickerCard, syncFormCard, thinkingLevelPickerCard } from '../cards.js';
import { commandOutputMarkdown, defaultProjectName, escapeMarkdown, formatCompactResult, resolveWorkspacePath } from '../utils/format.js';
import { assertWorkspaceDirectory } from '../utils/workspace.js';
import { parseSyncCount, syncComputerSessions, workspaceForChat } from '../sync/sync-service.js';
import { startShellCommand } from '../commands/shell.js';
import { runQuickAsk } from '../agent/ask.js';
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
/** 会话创建 in-flight 守卫（按 chatId）：fire-and-forget 后每群同时只允许一个创建流程，防并发重复创建 */
const creatingSessions = new Set<string>();
/** 手动同步 in-flight 守卫（按 chatId）：同步后台化后并发提交会读到同一未推进进度、重复发送相同轮次 */
const syncingChats = new Set<string>();
/** 项目群创建 in-flight 守卫（按 chatId）：后台化后建群窗口拉长，防连点重复建群 */
const creatingGroups = new Set<string>();
/** 压缩 in-flight 守卫（按 chatId）：fire-and-forget 后连点会重复弹卡 + 重复压缩（第二次报 Already compacted），防并发重复压缩 */
const compactingChats = new Set<string>();

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
    void showHelp(ctx, event.chatId, event.messageId, tid).catch((error) => {
      console.error('[help]', error);
      void send({ markdown: `操作面板打开失败：${userFacingError(error)}` }).catch(() => undefined);
    });
    return toast('success', '已打开操作面板。');
  }
  if (cmd === 'command.form') {
    if (!ctx.state.get(event.chatId)) return toast('error', '该群尚未绑定项目。');
    fireSendCard(send, commandFormCard(workspaceForChat(ctx, event.chatId), process.platform === 'win32'), '命令表单');
    return toast('success', '已打开命令执行表单。');
  }
  if (cmd === 'quickAsk.form') {
    if (!ctx.state.get(event.chatId)) return toast('error', '该群尚未绑定项目。');
    fireSendCard(send, askFormCard(workspaceForChat(ctx, event.chatId)), '快速提问表单');
    return toast('success', '已打开快速提问表单。');
  }
  if (cmd === 'command.submit') {
    const binding = ctx.state.get(event.chatId);
    if (!binding) return toast('error', '该群尚未绑定项目。');
    const form = cardFormValue(event);
    const command = form.command;
    if (!command) return toast('error', '请填写命令。');
    const isBackground = cardFormFlag(event, 'isBackground');
    // 常驻任务模式忽略超时：跳过格式校验（“忽略超时秒数”语义）
    const timeoutSeconds = isBackground ? undefined : parseCommandTimeout(form.timeoutSeconds);
    if (timeoutSeconds === null) return toast('error', '超时必须是 1 到 86400 之间的整数秒。');
    const taskId = randomUUID();
    // 话题上下文：命令卡回复到触发表单卡（保持在话题窗口内）
    void startShellCommand(ctx, event.chatId, workspaceForChat(ctx, event.chatId), command, taskId, isBackground ? undefined : timeoutSeconds, isBackground, (await resolveThread()) ? event.messageId : undefined).catch((error) => {
      console.error('[command]', error);
      // 启动前失败（starting 卡发送失败等）用户无感知，补发失败消息（spawn 失败本身已有失败卡）
      void send({ markdown: `命令启动失败：${error instanceof Error ? error.message : String(error)}` }).catch((noticeError) => console.warn('[command fail notice]', noticeError));
    });
    return toast('success', isBackground ? '后台任务已启动。' : '命令已开始执行。');
  }
  if (cmd === 'quickAsk.submit') {
    const binding = ctx.state.get(event.chatId);
    if (!binding) return toast('error', '该群尚未绑定项目。');
    const prompt = cardFormValue(event).prompt;
    if (!prompt) return toast('error', '请填写问题内容。');
    // 话题上下文：提问任务卡回复到触发表单卡（保持在话题窗口内）
    const tid = await resolveThread();
    void runQuickAsk(ctx, event.chatId, prompt, { replyTo: tid ? event.messageId : undefined, threadId: tid }).catch((error) => {
      console.error('[quick ask]', error);
      void send({ markdown: `快速提问启动失败：${error instanceof Error ? error.message : String(error)}` }).catch((noticeError) => console.warn('[quick ask fail notice]', noticeError));
    });
    return toast('success', '已提交快速提问。');
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
    fireSendCard(send, createProjectFormCard(baseCwd), '创建项目群表单');
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
      await assertWorkspaceDirectory(cwd);
    } catch (error) {
      return toast('error', error instanceof Error ? error.message : '工作路径无效。');
    }
    const name = form.name || defaultProjectName(cwd);
    // 防并发重复建群：后台化后建群窗口拉长（createChat 一般 1-3s，后台执行期间再点会重复建群）
    if (creatingGroups.has(event.chatId)) return toast('warning', '项目群正在创建中，请稍候。');
    creatingGroups.add(event.chatId);
    // 建群是重量级链路（建群 + 拉人、欢迎消息、群公告 Docx API 链），可能超过飞书 3s 事件响应窗口——
    // SDK 等 handler 返回才发 ack，超时即触发平台重推 + 客户端「目标回调服务未响应」；
    // 与 session.create.submit 同策略：先回 toast、后台异步执行（成功由新群欢迎消息 + 本群确认消息呈现，失败补发错误消息）。
    const task = (async () => {
      try {
        const created = await createProject(ctx, event.operator.openId, name, cwd);
        console.debug(`[project create] ${created.chatId} 已创建项目群：${name}`);
        await send({ markdown: `已创建项目群 **${name}**（${created.chatId.slice(-8)}）。` });
      } catch (error) {
        console.error('[project create]', error);
        void send({ markdown: `创建项目群失败：${userFacingError(error)}` }).catch((noticeError) => console.warn('[project create fail notice]', noticeError));
      } finally {
        creatingGroups.delete(event.chatId);
      }
    })();
    ctx.pendingBackground.add(task);
    void task.finally(() => { ctx.pendingBackground.delete(task); });
    return toast('success', '正在创建项目群…');
  }
  if (cmd === 'project.bind.form') {
    if (ctx.state.get(event.chatId)?.chatType === 'p2p') return toast('warning', '私聊固定使用默认工作区，不支持绑定项目。');
    const baseCwd = workspaceForChat(ctx, event.chatId);
    fireSendCard(send, bindProjectFormCard(baseCwd, Boolean(ctx.state.get(event.chatId))), '绑定项目表单');
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
      await assertWorkspaceDirectory(cwd);
    } catch (error) {
      return toast('error', error instanceof Error ? error.message : '工作路径无效。');
    }
    const bound = Boolean(ctx.state.get(event.chatId));
    // 绑定/改绑后清空活动 session 与同步状态，下一条普通消息自动走「新建会话」/「切换会话」选择卡（与切换 session 同策略）
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
    fireSendCard(send, bgTaskListCard([...ctx.backgroundTasks.values()].map((task) => ({ id: task.id, command: task.command, startedAt: task.startedAt }))), '后台任务列表');
    return toast('success', '已打开后台任务列表。');
  }
  if (cmd === 'bgTask.stop' && typeof value.taskId === 'string') {
    const task = ctx.backgroundTasks.get(value.taskId);
    if (!task) return toast('warning', '该后台任务已结束。');
    task.terminate();
    ctx.backgroundTasks.delete(value.taskId);
    fireSendCard(send, bgTaskListCard([...ctx.backgroundTasks.values()].map((task) => ({ id: task.id, command: task.command, startedAt: task.startedAt }))), '后台任务列表刷新');
    return toast('success', '后台任务已停止。');
  }
  const binding = ctx.state.get(event.chatId);
  if (!binding) return toast('error', '该群尚未绑定项目。');
  const cwd = workspaceForChat(ctx, event.chatId);
  // 话题上下文：会话 = 话题独立 session（懒初始化，先于任何会话操作完成绑定）；普通群 = 主会话 activeSessionFile
  const tid = await resolveThread();
  const activeSessionFile = tid ? await ensureThreadSession(ctx, event.chatId, tid, cwd) : binding.activeSessionFile;
  const requireActiveSession = (): string | undefined => activeSessionFile;
  const selectSessionHint = '请先使用「新建会话」或「切换会话」。';

  if (cmd === 'session.new.form') {
    fireSendCard(send, createSessionFormCard(), '新建会话表单');
    return toast('success', '请填写会话名称。');
  }
  if (cmd === 'session.resume.form') {
    const sessions = await ctx.pi.list(cwd);
    if (sessions.length === 0) return toast('warning', '当前工作路径没有可切换的历史会话，请使用「新建会话」。');
    fireSendCard(send, sessionPickerCard(cwd, sessions), '会话选择器');
    return toast('success', '请选择要切换的历史会话。');
  }
  if (cmd === 'model.form') {
    if (!requireActiveSession()) return toast('warning', selectSessionHint);
    const models = await ctx.pi.models();
    if (models.length === 0) return toast('error', '没有可用的 provider/model。');
    fireSendCard(send, modelPickerCard(models), '模型选择器');
    return toast('success', '请选择 provider/model。');
  }
  if (cmd === 'thinkingLevel.form') {
    const sessionFile = requireActiveSession();
    if (!sessionFile) return toast('warning', selectSessionHint);
    const thinkingLevels = await ctx.pi.thinkingLevels(cwd, sessionFile);
    if (thinkingLevels.length === 0) return toast('warning', '当前 model 不支持思考强度设置。');
    fireSendCard(send, thinkingLevelPickerCard(thinkingLevels), '思考强度选择器');
    return toast('success', '请选择思考强度。');
  }
  if (cmd === 'session.sync.form') {
    if (!requireActiveSession()) return toast('warning', selectSessionHint);
    fireSendCard(send, syncFormCard(), '同步设置表单');
    return toast('success', '请填写同步条数。');
  }
  if (cmd === 'session.sync.submit') {
    const sessionFile = requireActiveSession();
    if (!sessionFile) return toast('warning', selectSessionHint);
    if (!(await sessionFileExists(sessionFile))) return toast('warning', '该会话已不存在，请使用「切换会话」重新选择。');
    const count = parseSyncCount(cardFormValue(event).count);
    if (count === null) return toast('error', '同步条数必须是正整数。');
    // 防并发重复同步：后台化后两个同步提交同时读到同一未推进进度，会重复发送相同轮次（进度由最后一条推进，完成前不变）
    if (syncingChats.has(event.chatId)) return toast('warning', '同步正在进行中，请稍候。');
    syncingChats.add(event.chatId);
    // 同步是重量级链路（读/解析 session JSONL、statusAt 快照初始化模型运行时、28KB 富文本发送、state 落盘），
    // 可能超过飞书 3s 事件响应窗口——SDK 等 handler 返回才发 ack，超时即触发平台重推 + 客户端「目标回调服务未响应」；
    // 与 session.create.submit 同策略：先回 toast、后台异步执行，结果以消息呈现，不再阻塞 ack。
    const task = (async () => {
      try {
        const result = await syncComputerSessions(ctx, event.chatId, 'manual', count);
        const message = result.retry ? '会话正在写入，请稍后重试。'
          : result.busy ? 'Agent 正在处理消息，请稍后再同步。'
          : result.progressReset ? '会话文件已更新（可能已压缩），同步进度已重置。请再次同步；结果可能包含已发送的历史轮次。'
          : result.sent > 0 ? `已同步 ${result.sent} 轮对话${result.truncated ? '（内容已截断）' : ''}。`
          : '无待同步消息。';
        await send({ markdown: message });
      } catch (error) {
        console.error('[session sync]', error);
        void send({ markdown: `同步失败：${userFacingError(error)}` }).catch((noticeError) => console.warn('[session sync fail notice]', noticeError));
      } finally {
        syncingChats.delete(event.chatId);
      }
    })();
    ctx.pendingBackground.add(task);
    void task.finally(() => { ctx.pendingBackground.delete(task); });
    return toast('success', '正在同步消息，请稍候。');
  }
  if (cmd === 'session.rename.form') {
    if (!requireActiveSession()) return toast('warning', selectSessionHint);
    fireSendCard(send, renameSessionFormCard(), '会话重命名表单');
    return toast('success', '请填写会话名称。');
  }
  if (cmd === 'session.compact') {
    const sessionFile = requireActiveSession();
    if (!sessionFile) return toast('warning', selectSessionHint);
    if (compactingChats.has(event.chatId)) return toast('warning', '正在压缩会话，请稍候。');
    compactingChats.add(event.chatId);
    // 压缩状态卡链路（fire-and-forget，防 3s ack 超时）：立即弹「正在压缩」卡，压缩完成后更新为成功/失败最终卡；
    // 压缩会排队等待 session 锁（多群共享 / agent 处理中），等待期间起始卡保持「正在压缩」状态
    void (async () => {
      let updater: CardUpdater | undefined;
      try {
        const sent = await sendChat(ctx, event.chatId, { card: compactStartingCard() }, (await resolveThread()) ? { replyTo: event.messageId } : undefined);
        updater = createCardUpdater(ctx, event.chatId, sent.messageId, 'compact status');
        const result = await ctx.pi.compact(cwd, sessionFile);
        await updater.finish(compactSuccessCard(formatCompactResult(result.tokensBefore, result.estimatedTokensAfter), result.status))
          .catch((updateError) => console.warn('[compact success status]', updateError));
      } catch (error) {
        console.error('[compact]', error);
        const reason = escapeMarkdown(userFacingError(error)).slice(0, 200);
        if (updater) {
          // 起始卡已发出：更新为失败卡（压缩失败也可能是「Already compacted」等，均视为未生效）
          void updater.finish(compactFailureCard(reason)).catch((updateError) => console.warn('[compact fail status]', updateError));
        } else {
          // 起始卡都未发出（群失效 / 网络异常）：退化为直接发失败消息，保证用户有反馈
          void send({ markdown: `会话压缩失败：${reason}` }).catch((noticeError) => console.warn('[compact fail notice]', noticeError));
        }
      } finally {
        compactingChats.delete(event.chatId);
      }
    })();
    return toast('success', '正在压缩会话上下文。');
  }
  if (cmd === 'model.select' && typeof value.provider === 'string' && typeof value.modelId === 'string') {
    const sessionFile = requireActiveSession();
    if (!sessionFile) return toast('warning', selectSessionHint);
    if (!(await sessionFileExists(sessionFile))) return toast('warning', '该会话已不存在，请使用「切换会话」重新选择。');
    const selected = await ctx.pi.setModel(cwd, sessionFile, value.provider, value.modelId);
    if (!tid) void updateAnnouncement(ctx, event.chatId);
    return toast('success', `已切换到 ${selected.provider}/${selected.name}。`);
  }
  if (cmd === 'thinkingLevel.select' && typeof value.thinkingLevel === 'string') {
    const sessionFile = requireActiveSession();
    if (!sessionFile) return toast('warning', selectSessionHint);
    if (!(await sessionFileExists(sessionFile))) return toast('warning', '该会话已不存在，请使用「切换会话」重新选择。');
    await ctx.pi.setThinkingLevel(cwd, sessionFile, value.thinkingLevel as PiThinkingLevel);
    if (!tid) void updateAnnouncement(ctx, event.chatId);
    return toast('success', `已设置思考强度：${value.thinkingLevel}。`);
  }
  if (cmd === 'session.rename.submit') {
    const sessionFile = requireActiveSession();
    if (!sessionFile) return toast('warning', selectSessionHint);
    if (!(await sessionFileExists(sessionFile))) return toast('warning', '该会话已不存在，请使用「切换会话」重新选择。');
    const name = cardFormValue(event).name.replace(/[\r\n]+/g, ' ').trim();
    if (!name) return toast('error', '请填写会话名称。');
    await ctx.pi.rename(cwd, sessionFile, name);
    if (!tid) void updateAnnouncement(ctx, event.chatId);
    return toast('success', `已命名为 ${name}。`);
  }
  if (cmd === 'session.create.submit') {
    const name = cardFormValue(event).name.replace(/[\r\n]+/g, ' ').trim();
    if (!name) return toast('error', '请填写会话名称。');
    // 防并发重复创建：创建流程进行中再次点击直接提示（fire-and-forget 后完成信号由「已新建会话」消息承担）
    if (creatingSessions.has(event.chatId)) return toast('warning', '正在创建会话，请稍候。');
    creatingSessions.add(event.chatId);
    // 会话创建是重量级链路（pi 首次初始化 + 公告 Docx API 链 + 发消息），可能超过飞书 3s 事件响应窗口——
    // SDK 等 handler 返回才发 ack，超时即触发平台重推 + 客户端「目标回调服务未响应」；
    // 改为先回 toast、后台异步执行（失败补发消息，不再阻塞 ack）。
    void (async () => {
      console.debug(`[session create] ${event.chatId} 开始创建会话：${name}`);
      try {
        await useNewSession(ctx, event.chatId, cwd, name);
      } catch (error) {
        console.error('[session create]', error);
        void send({ markdown: `会话创建失败：${userFacingError(error)}` }).catch((noticeError) => console.warn('[session create fail notice]', noticeError));
        return;
      } finally {
        creatingSessions.delete(event.chatId);
      }
      // 挂起消息一次性续跑（消费即删；超过 PENDING_PROMPT_MAX_MS 不再续跑）——toast 已回，续跑结果由处理中卡片呈现
      const pendingPrompt = takePendingPrompt(ctx.pending, event.chatId, PENDING_PROMPT_MAX_MS);
      if (pendingPrompt.kind === 'ok') {
        void runPrompt(ctx, pendingPrompt.message, pendingPrompt.text).catch((error) => {
          console.error('[card prompt]', error);
          // runPrompt 内已提示的路径为 return 不 throw，此处兜底未覆盖异常，避免「提示正在处理但实际未处理」的静默失败
          void send({ markdown: `消息处理失败：${error instanceof Error ? error.message : String(error)}` }).catch((noticeError) => console.warn('[card prompt fail notice]', noticeError));
        });
      }
    })();
    return toast('success', `已创建会话：${name}，正在初始化。`);
  }
  if (cmd === 'session.use' && typeof value.sessionFile === 'string') {
    const sessions = await ctx.pi.list(cwd);
    const selectedSession = sessions.find((session) => session.path === value.sessionFile);
    if (!selectedSession) return toast('error', '该会话不属于当前项目或已不存在。');
    ctx.state.update(event.chatId, { activeSessionFile: value.sessionFile, sessionSync: undefined });
    await ctx.state.flush();
    await ctx.sessionSyncWatcher.reconcile();
    const selected = sessionDisplayName(selectedSession);
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
  return toast('warning', '不支持的卡片操作。');
}

/**
 * 后台发送卡片：卡片回调需 3s 内 ack（SDK 等 handler 返回才发 ack），网络慢时同步 await 发送会触发
 * 平台重推与客户端「目标回调服务未响应」；先回 toast、后台异步发送（失败补发消息），卡片显示由发送完成自然呈现。
 */
function fireSendCard(send: (input: SendInput) => Promise<void>, card: object, failLabel: string): void {
  void send({ card }).catch((error) => {
    console.error(`[card send] ${failLabel}`, error);
    void send({ markdown: `${failLabel}打开失败：${userFacingError(error)}` }).catch((noticeError) => console.warn('[card send fail notice]', noticeError));
  });
}

/** 用户可见错误文本：剥离内部 API 路径等细节（完整 error 已由日志保留） */
function userFacingError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Feishu API \/open-apis\/[^:\n]+: /, '飞书 API 错误：');
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
