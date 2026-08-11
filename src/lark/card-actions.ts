import { randomUUID } from 'node:crypto';
import type { CardActionEvent, CardActionResponse } from '@larksuite/channel';
import type { AppContext } from '../app-context.js';
import { COMMAND_CARD_OUTPUT_LIMIT } from '../config.js';
import type { PiThinkingLevel } from '../pi.js';
import { bgTaskListCard, bindProjectFormCard, commandFinalCard, commandFormCard, createProjectFormCard, createSessionFormCard, modelPickerCard, renameSessionFormCard, sessionDisplayName, sessionPickerCard, syncFormCard, thinkingLevelPickerCard } from '../cards.js';
import { commandOutputMarkdown, defaultProjectName, resolveWorkspacePath } from '../utils/format.js';
import { parseSyncCount, syncComputerSessions, workspaceForChat } from '../sync/sync-service.js';
import { startShellCommand } from '../commands/shell.js';
import { updateAnnouncement } from '../announcement.js';
import { runPrompt, useNewSession } from '../agent/prompt.js';
import { createProject } from './projects.js';

/** 卡片动作分发：全部 cmd 分支 + 表单解析工具 */
export async function handleCardAction(ctx: AppContext, event: CardActionEvent): Promise<CardActionResponse> {
  const value = event.action.value as Record<string, unknown> | undefined;
  if (!value || typeof value !== 'object') return toast('warning', '无效的卡片操作。');
  const cmd = value.cmd;
  if (cmd === 'command.form') {
    if (!ctx.state.get(event.chatId)) return toast('error', '该群尚未绑定项目。');
    await ctx.lark.send(event.chatId, { card: commandFormCard(workspaceForChat(ctx, event.chatId)) });
    return toast('success', '已打开命令执行表单。');
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
    void startShellCommand(ctx, event.chatId, workspaceForChat(ctx, event.chatId), command, taskId, isBackground ? undefined : timeoutSeconds, isBackground).catch((error) =>
      console.error('[command]', error),
    );
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
    await ctx.lark.send(event.chatId, { card: createProjectFormCard(baseCwd) });
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
    await ctx.lark.send(event.chatId, { markdown: `已创建项目群 **${name}**。` });
    return toast('success', `已创建项目群（${created.chatId.slice(-8)}）。`);
  }
  if (cmd === 'project.bind.form') {
    if (ctx.state.get(event.chatId)?.chatType === 'p2p') return toast('warning', '私聊固定使用默认工作区，不支持绑定项目。');
    const baseCwd = workspaceForChat(ctx, event.chatId);
    await ctx.lark.send(event.chatId, { card: bindProjectFormCard(baseCwd, Boolean(ctx.state.get(event.chatId))) });
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
    void updateAnnouncement(ctx, event.chatId);
    return toast('success', bound ? '已修改项目绑定。' : '已绑定项目。');
  }
  if (cmd === 'bgTask.form') {
    await ctx.lark.send(event.chatId, { card: bgTaskListCard([...ctx.backgroundTasks.values()].map((task) => ({ id: task.id, command: task.command, startedAt: task.startedAt }))) });
    return toast('success', '已打开后台任务列表。');
  }
  if (cmd === 'bgTask.stop' && typeof value.taskId === 'string') {
    const task = ctx.backgroundTasks.get(value.taskId);
    if (!task) return toast('warning', '该后台任务已结束。');
    task.terminate();
    ctx.backgroundTasks.delete(value.taskId);
    await ctx.lark.send(event.chatId, { card: bgTaskListCard([...ctx.backgroundTasks.values()].map((task) => ({ id: task.id, command: task.command, startedAt: task.startedAt }))) });
    return toast('success', '后台任务已停止。');
  }
  const binding = ctx.state.get(event.chatId);
  if (!binding) return toast('error', '该群尚未绑定项目。');
  const cwd = workspaceForChat(ctx, event.chatId);
  const activeSessionFile = binding.activeSessionFile;
  const requireActiveSession = (): string | undefined => activeSessionFile;
  const createPending = (): string => {
    const nonce = randomUUID();
    ctx.pending.set(event.chatId, { nonce });
    return nonce;
  };
  const current = ctx.pending.get(event.chatId);
  if (typeof value.nonce === 'string' && current && value.nonce !== current.nonce) return toast('warning', '该操作卡片已过期，请重新打开 /help。');

  if (cmd === 'session.new.form') {
    const nonce = createPending();
    await ctx.lark.send(event.chatId, { card: createSessionFormCard(nonce, '新建 Session') });
    return toast('success', '请填写 Session 名称。');
  }
  if (cmd === 'session.resume.form') {
    const sessions = await ctx.pi.list(cwd);
    if (sessions.length === 0) return toast('warning', '当前路径没有可恢复的 Session，请使用 new。');
    const nonce = createPending();
    await ctx.lark.send(event.chatId, { card: sessionPickerCard(cwd, sessions, nonce) });
    return toast('success', '请选择要恢复的 Session。');
  }
  if (cmd === 'model.form') {
    if (!requireActiveSession()) return toast('warning', '请先使用 new 或 resume 选择 Session。');
    const models = await ctx.pi.models();
    if (models.length === 0) return toast('error', '没有可用的 provider/model。');
    const nonce = createPending();
    await ctx.lark.send(event.chatId, { card: modelPickerCard(models, nonce) });
    return toast('success', '请选择 provider/model。');
  }
  if (cmd === 'thinkingLevel.form') {
    const sessionFile = requireActiveSession();
    if (!sessionFile) return toast('warning', '请先使用 new 或 resume 选择 Session。');
    const thinkingLevels = await ctx.pi.thinkingLevels(cwd, sessionFile);
    if (thinkingLevels.length === 0) return toast('warning', '当前 model 不支持思考强度设置。');
    const nonce = createPending();
    await ctx.lark.send(event.chatId, { card: thinkingLevelPickerCard(thinkingLevels, nonce) });
    return toast('success', '请选择思考强度。');
  }
  if (cmd === 'session.sync.form') {
    if (!requireActiveSession()) return toast('warning', '请先使用 new 或 resume 选择 Session。');
    await ctx.lark.send(event.chatId, { card: syncFormCard() });
    return toast('success', '请填写同步条数。');
  }
  if (cmd === 'session.sync.submit') {
    const sessionFile = requireActiveSession();
    if (!sessionFile) return toast('warning', '请先使用 new 或 resume 选择 Session。');
    const count = parseSyncCount(cardFormValue(event).count);
    if (count === null) return toast('error', '同步条数必须是正整数。');
    const result = await syncComputerSessions(ctx, event.chatId, 'manual', count);
    if (result.retry) return toast('warning', 'Session 正在写入，请稍后重试。');
    if (result.busy) return toast('warning', 'Agent 正在处理消息，请稍后再同步。');
    if (result.progressReset) return toast('warning', 'Session 文件已更新（可能已压缩），同步进度已重置。请再次同步；结果可能包含已发送的历史轮次。');
    if (result.sent === 0) await ctx.lark.send(event.chatId, { markdown: '无待同步消息。' });
    return toast('success', result.sent ? `已同步 ${result.sent} 轮对话${result.truncated ? '（内容已截断）' : ''}。` : '无待同步消息。');
  }
  if (cmd === 'session.rename.form') {
    if (!requireActiveSession()) return toast('warning', '请先使用 new 或 resume 选择 Session。');
    const nonce = createPending();
    await ctx.lark.send(event.chatId, { card: renameSessionFormCard(nonce) });
    return toast('success', '请填写 Session 名称。');
  }
  if (cmd === 'session.compact') {
    const sessionFile = requireActiveSession();
    if (!sessionFile) return toast('warning', '请先使用 new 或 resume 选择 Session。');
    void ctx.pi.compact(cwd, sessionFile).catch((error) => {
      console.error('[compact]', error);
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 200);
      void ctx.lark.send(event.chatId, { markdown: `Session 压缩失败：${reason}` });
    });
    return toast('success', '正在压缩 Session 上下文。');
  }
  if (cmd === 'model.select' && typeof value.provider === 'string' && typeof value.modelId === 'string') {
    const sessionFile = requireActiveSession();
    if (!sessionFile || !current) return toast('warning', '该操作卡片已过期，请重新打开 /help。');
    const selected = await ctx.pi.setModel(cwd, sessionFile, value.provider, value.modelId);
    ctx.pending.delete(event.chatId);
    void updateAnnouncement(ctx, event.chatId);
    return toast('success', `已切换到 ${selected.provider}/${selected.name}。`);
  }
  if (cmd === 'thinkingLevel.select' && typeof value.thinkingLevel === 'string') {
    const sessionFile = requireActiveSession();
    if (!sessionFile || !current) return toast('warning', '该操作卡片已过期，请重新打开 /help。');
    await ctx.pi.setThinkingLevel(cwd, sessionFile, value.thinkingLevel as PiThinkingLevel);
    ctx.pending.delete(event.chatId);
    void updateAnnouncement(ctx, event.chatId);
    return toast('success', `已设置思考强度：${value.thinkingLevel}。`);
  }
  if (cmd === 'session.rename.submit') {
    const sessionFile = requireActiveSession();
    if (!sessionFile || !current) return toast('warning', '该操作卡片已过期，请重新打开 /help。');
    const name = cardFormValue(event).name.replace(/[\r\n]+/g, ' ').trim();
    if (!name) return toast('error', '请填写 Session 名称。');
    await ctx.pi.rename(cwd, sessionFile, name);
    ctx.pending.delete(event.chatId);
    void updateAnnouncement(ctx, event.chatId);
    return toast('success', `已命名为 ${name}。`);
  }
  let selected: string;
  if (cmd === 'session.create.submit') {
    if (!current) return toast('warning', '该新建表单已过期，请重新打开 /help。');
    const name = cardFormValue(event).name.replace(/[\r\n]+/g, ' ').trim();
    if (!name) return toast('error', '请填写 Session 名称。');
    await useNewSession(ctx, event.chatId, cwd, name);
    selected = name;
  } else if (cmd === 'session.use' && typeof value.sessionFile === 'string') {
    if (!current) return toast('warning', '该恢复卡片已过期，请重新打开 /help。');
    const sessions = await ctx.pi.list(cwd);
    const selectedSession = sessions.find((session) => session.path === value.sessionFile);
    if (!selectedSession) return toast('error', '该 Session 不属于当前项目或已不存在。');
    ctx.state.update(event.chatId, { activeSessionFile: value.sessionFile, sessionSync: undefined });
    await ctx.state.flush();
    await ctx.sessionSyncWatcher.reconcile();
    selected = sessionDisplayName(selectedSession);
  } else return toast('warning', '不支持的卡片操作。');
  ctx.pending.delete(event.chatId);
  void updateAnnouncement(ctx, event.chatId);
  const prompt = current?.prompt;
  if (prompt) {
    void runPrompt(ctx, prompt.message, prompt.text).catch((error) => console.error('[card prompt]', error));
    return toast('success', `已切换到 ${selected}，正在处理消息。`);
  }
  return toast('success', `已切换到 ${selected}。`);
}

function parseCommandTimeout(value: string | undefined): number | undefined | null {
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) return null;
  const seconds = Number.parseInt(value, 10);
  return seconds >= 1 && seconds <= 86_400 ? seconds : null;
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
