import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createLarkChannel, type LarkChannel, type CardActionEvent, type CardActionResponse, type NormalizedMessage } from '@larksuite/channel';
import { StateStore } from './state.js';
import { PiSessions, type PiEffort } from './pi.js';
import { LarkApi } from './lark-api.js';
import type { ChatBinding } from './types.js';
import { agentFinalCard, agentQueuedCard, agentRunningCard, commandFinalCard, commandFormCard, commandRunningCard, commandStartingCard, createProjectFormCard, createSessionFormCard, effortPickerCard, helpCard, modelPickerCard, renameSessionFormCard, sessionDisplayName, sessionPickerCard, syncFormCard } from './cards.js';

const appId = required('LARK_APP_ID');
const appSecret = required('LARK_APP_SECRET');
const stateRoot = resolve(process.env.LARK_STATE_DIR ?? '.state');
const defaultWorkspace = resolve(process.env.LARK_DEFAULT_WORKSPACE ?? process.cwd());
await mkdir(stateRoot, { recursive: true });
const instanceLock = await acquireInstanceLock(join(stateRoot, 'instance.lock'));
const state = new StateStore(stateRoot);
await state.load();
const pi = new PiSessions(state);
const api = new LarkApi(appId, appSecret);
const pending = new Map<string, { nonce: string; prompt?: { message: NormalizedMessage; text: string } }>();
const commandTasks = new Map<string, CommandTask>();
const COMMAND_OUTPUT_LIMIT = 30_000;
const COMMAND_CARD_OUTPUT_LIMIT = 6_000;
const REPLY_CONTEXT_MAX_LENGTH = 12_000;
const AGENT_CARD_UPDATE_INTERVAL_MS = 750;
const piAutoRetryMaxRetries = nonNegativeIntegerEnv('LARK_PI_RETRY_MAX_RETRIES', 3);

type CommandTask = {
  child: ChildProcess;
  chatId: string;
  command: string;
  cwd: string;
  stopped: boolean;
  timedOut: boolean;
  timeoutSeconds?: number;
  messageId?: string;
  updater?: CardUpdater;
  startedAt: number;
  stdout: string;
  stderr: string;
  terminate: () => void;
};

type CardUpdater = {
  update: (card: object) => Promise<void>;
  finish: (card: object) => Promise<void>;
};

type AgentRun = {
  id: string;
  chatId: string;
  cwd: string;
  sessionFile: string;
  prompt: string;
  messageId: string;
  startedAt: number;
  state: 'queued' | 'running' | 'stopping' | 'succeeded' | 'failed' | 'cancelled';
  updater: CardUpdater;
  stopStatus: () => void;
  originBefore?: Set<string>;
  originPrompt?: string;
  stopRequested: boolean;
};

class AgentRunManager {
  private readonly runs = new Map<string, AgentRun>();
  private readonly queues = new Map<string, AgentRun[]>();
  private readonly current = new Map<string, AgentRun>();

  constructor(private readonly lark: LarkChannel) {}

  isActive(chatId: string): boolean {
    return (this.queues.get(chatId)?.length ?? 0) > 0 || this.current.has(chatId);
  }

  async submit(message: NormalizedMessage, cwd: string, sessionFile: string, prompt: string, originBefore?: Set<string>, originPrompt?: string): Promise<void> {
    const id = randomUUID();
    const sent = await this.lark.send(message.chatId, { card: agentQueuedCard(id, prompt) }, { replyTo: message.messageId });
    const run: AgentRun = {
      id, chatId: message.chatId, cwd, sessionFile, prompt, messageId: sent.messageId, startedAt: Date.now(), state: 'queued',
      updater: createCardUpdater(this.lark, sent.messageId, 'agent status'), stopStatus: () => undefined, originBefore, originPrompt, stopRequested: false,
    };
    this.runs.set(id, run);
    const queue = this.queues.get(run.chatId) ?? [];
    queue.push(run);
    this.queues.set(run.chatId, queue);
    void this.startNext(run.chatId).catch((error) => console.error('[agent queue]', error));
  }

  stop(chatId: string, id: string): boolean {
    const run = this.runs.get(id);
    if (!run || run.chatId !== chatId || ['succeeded', 'failed', 'cancelled'].includes(run.state)) return false;
    run.stopRequested = true;
    run.stopStatus();
    if (run.state === 'queued') {
      run.state = 'cancelled';
      void this.finishWithStatus(run, 'Agent 已停止', '已在开始前取消。', 'agent stop status');
      return true;
    }
    run.state = 'stopping';
    void this.finishWithStatus(run, '正在停止 Agent', '正在停止处理。', 'agent stop status');
    if (this.current.get(chatId)?.id === id) void pi.abort(chatId).catch((error) => console.error('[agent stop]', error));
    return true;
  }

  async shutdown(): Promise<void> {
    const updates: Promise<void>[] = [];
    for (const run of this.runs.values()) {
      run.stopRequested = true;
      run.stopStatus();
      if (run.state === 'queued') {
        run.state = 'cancelled';
        updates.push(this.finishWithStatus(run, 'Agent 已停止', '服务关闭，任务未开始。', 'agent shutdown'));
      } else if (run.state === 'running' || run.state === 'stopping') {
        run.state = 'stopping';
        void pi.abort(run.chatId).catch((error) => console.error('[agent shutdown]', error));
        updates.push(this.finishWithStatus(run, 'Agent 已停止', '服务正在关闭。', 'agent shutdown'));
      }
    }
    await Promise.race([
      Promise.allSettled(updates).then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 1_500)),
    ]);
  }

  private async startNext(chatId: string): Promise<void> {
    if (this.current.has(chatId)) return;
    const queue = this.queues.get(chatId);
    try {
      while (queue?.length) {
        const run = queue.shift()!;
        if (run.state === 'cancelled') {
          this.runs.delete(run.id);
          continue;
        }
        this.current.set(chatId, run);
        try {
          await this.execute(run);
        } catch (error) {
          run.state = run.stopRequested ? 'cancelled' : 'failed';
          const content = agentFailureContent('', error, run.stopRequested);
          void this.finishWithStatus(run, run.stopRequested ? 'Agent 已停止' : 'Agent 处理失败', content, 'agent final status');
          console.error('[agent run]', error);
        } finally {
          run.stopStatus();
          this.current.delete(chatId);
          this.runs.delete(run.id);
          sessionSyncWatcher.schedule(chatId);
        }
      }
    } finally {
      if (!queue?.length) this.queues.delete(chatId);
    }
  }

  private async execute(run: AgentRun): Promise<void> {
    run.state = 'running';
    run.startedAt = Date.now();
    void run.updater.update(agentRunningCard(run.id, run.prompt)).catch((error) => console.warn('[agent start status]', error));
    let latest = '';
    let previewTimer: NodeJS.Timeout | undefined;
    let lastPreviewAt = 0;
    const updatePreview = (): void => {
      previewTimer = undefined;
      if (run.state !== 'running') return;
      lastPreviewAt = Date.now();
      void run.updater.update(agentRunningCard(run.id, run.prompt, latest)).catch((error) => console.warn('[agent preview status]', error));
    };
    run.stopStatus = () => undefined;
    const isStopping = (): boolean => run.stopRequested;
    try {
      const result = await pi.prompt(run.chatId, run.cwd, run.sessionFile, run.prompt, (text) => {
        latest = text;
        const delay = AGENT_CARD_UPDATE_INTERVAL_MS - (Date.now() - lastPreviewAt);
        if (delay <= 0) updatePreview();
        else if (!previewTimer) previewTimer = setTimeout(updatePreview, delay);
      });
      if (previewTimer) clearTimeout(previewTimer);
      run.state = isStopping() ? 'cancelled' : 'succeeded';
      const card = run.state === 'cancelled'
        ? agentFinalCard('Agent 已停止', latest || '已停止处理。', result.status, elapsedSince(run.startedAt))
        : agentFinalCard('Agent 处理完成', result.answer, result.status, elapsedSince(run.startedAt));
      await run.updater.finish(card).catch((error) => console.warn('[agent final status]', error));
      void updateAnnouncement(run.chatId);
    } catch (error) {
      run.state = isStopping() ? 'cancelled' : 'failed';
      const content = agentFailureContent(latest, error, run.stopRequested);
      const status = await pi.status(run.chatId, run.cwd, run.sessionFile).catch(() => undefined);
      await run.updater.finish(agentFinalCard(run.stopRequested ? 'Agent 已停止' : 'Agent 处理失败', content, status, elapsedSince(run.startedAt))).catch((updateError) => console.warn('[agent final status]', updateError));
    } finally {
      if (previewTimer) clearTimeout(previewTimer);
      if (run.originBefore) {
        try {
          await markFeishuOrigin(run.chatId, run.sessionFile, run.originBefore, run.originPrompt);
          state.update(run.chatId, { inFlightFeishuRun: undefined });
          await state.flush();
        } catch (error) {
          console.warn(`[feishu origin] ${run.chatId}:`, error);
        }
      }
      run.stopStatus();
    }
  }

  private async finishWithStatus(run: AgentRun, title: string, content: string, label: string): Promise<void> {
    const status = await pi.status(run.chatId, run.cwd, run.sessionFile).catch(() => undefined);
    const elapsed = this.current.get(run.chatId)?.id === run.id ? elapsedSince(run.startedAt) : undefined;
    await run.updater.finish(agentFinalCard(title, content, status, elapsed)).catch((error) => console.warn(`[${label}]`, error));
  }

}

class SessionSyncWatcher {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Set<string>();
  private readonly dirty = new Set<string>();
  private readonly retries = new Map<string, number>();
  private readonly fileStats = new Map<string, string>();
  private readonly pollTimer: NodeJS.Timeout;

  constructor(private readonly lark: LarkChannel) {
    this.pollTimer = setInterval(() => void this.poll(), 60_000);
    this.pollTimer.unref();
  }

  async reconcile(): Promise<void> {
    const active = new Map<string, Set<string>>();
    for (const [chatId, binding] of Object.entries(state.all())) {
      if (!binding.activeSessionFile) continue;
      const directory = dirname(binding.activeSessionFile);
      const chats = active.get(directory) ?? new Set<string>();
      chats.add(chatId);
      active.set(directory, chats);
      const fileStat = await stat(binding.activeSessionFile).catch(() => undefined);
      if (fileStat) this.fileStats.set(binding.activeSessionFile, `${fileStat.size}:${fileStat.mtimeMs}`);
      const inFlight = binding.inFlightFeishuRun;
      if (inFlight?.sessionFile === binding.activeSessionFile) {
        await markFeishuOrigin(chatId, inFlight.sessionFile, new Set(inFlight.beforeEntryIds), inFlight.prompt);
        state.update(chatId, { inFlightFeishuRun: undefined });
        await state.flush();
      }
      await ensureAutoBaseline(chatId);
    }
    for (const [directory, watcher] of this.watchers) {
      if (!active.has(directory)) {
        watcher.close();
        this.watchers.delete(directory);
      }
    }
    for (const directory of active.keys()) {
      if (this.watchers.has(directory)) continue;
      const watcher = watch(directory, { persistent: true }, (_eventType, filename) => {
        if (!filename) return;
        const changed = String(filename);
        for (const [chatId, binding] of Object.entries(state.all())) {
          if (binding.activeSessionFile && dirname(binding.activeSessionFile) === directory && basename(binding.activeSessionFile) === changed) this.schedule(chatId);
        }
      });
      watcher.on('error', (error) => {
        console.warn(`[session watch] ${directory}:`, error);
        watcher.close();
        this.watchers.delete(directory);
        setTimeout(() => void this.reconcile().catch((reconcileError) => console.warn('[session watch reconcile]', reconcileError)), 1_000).unref();
      });
      this.watchers.set(directory, watcher);
    }
  }

  schedule(chatId: string): void {
    this.dirty.add(chatId);
    const existing = this.timers.get(chatId);
    if (existing) clearTimeout(existing);
    this.timers.set(chatId, setTimeout(() => {
      this.timers.delete(chatId);
      void this.run(chatId);
    }, 750));
  }

  private async run(chatId: string): Promise<void> {
    if (this.running.has(chatId)) return;
    this.running.add(chatId);
    try {
      while (this.dirty.delete(chatId)) {
        if (agentRuns.isActive(chatId) || state.get(chatId)?.inFlightFeishuRun) break;
        const result = await syncComputerSessions(this.lark, chatId, 'auto');
        if (result.retry) this.retry(chatId);
        else this.retries.delete(chatId);
      }
    } catch (error) {
      console.warn(`[session sync] ${chatId}:`, error);
    } finally {
      this.running.delete(chatId);
    }
  }

  private async poll(): Promise<void> {
    for (const [chatId, binding] of Object.entries(state.all())) {
      if (!binding.activeSessionFile) continue;
      const fileStat = await stat(binding.activeSessionFile).catch(() => undefined);
      if (!fileStat) continue;
      const next = `${fileStat.size}:${fileStat.mtimeMs}`;
      const previous = this.fileStats.get(binding.activeSessionFile);
      this.fileStats.set(binding.activeSessionFile, next);
      if (previous && previous !== next) this.schedule(chatId);
    }
  }

  private retry(chatId: string): void {
    const attempts = (this.retries.get(chatId) ?? 0) + 1;
    if (attempts > 3) {
      this.retries.delete(chatId);
      return;
    }
    this.retries.set(chatId, attempts);
    setTimeout(() => this.schedule(chatId), 250 * 2 ** (attempts - 1)).unref();
  }

  close(): void {
    clearInterval(this.pollTimer);
    for (const watcher of this.watchers.values()) watcher.close();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.watchers.clear();
    this.timers.clear();
  }
}

const channel = createLarkChannel({
  appId, appSecret, domain: 'https://open.feishu.cn', source: 'lark-agent-os',
  policy: { dmMode: 'open', requireMention: false, respondToMentionAll: false },
  safety: { chatQueue: { enabled: false } },
  includeRawEvent: true,
});

const agentRuns = new AgentRunManager(channel);
const sessionSyncWatcher = new SessionSyncWatcher(channel);

channel.on({
  message: (message) => void handleMessage(channel, message).catch((error) => console.error('[message]', error)),
  cardAction: async (event) => {
    try {
      return await handleCardAction(channel, event);
    } catch (error) {
      console.error('[cardAction]', error);
      return { toast: { type: 'error', content: '操作失败，请重新打开 session 选择器。' } };
    }
  },
});
await channel.connect();
console.log(`lark-agent-os connected as ${channel.botIdentity?.name ?? 'bot'}`);
await sessionSyncWatcher.reconcile();
for (const chatId of Object.keys(state.all())) void updateAnnouncement(chatId);
async function handleMessage(lark: LarkChannel, message: NormalizedMessage): Promise<void> {
  if (!allowed(message)) return;
  const text = message.content.trim();
  if (message.chatType === 'p2p') await ensureDirectChat(message.chatId);
  if (text === '/help') return showHelp(lark, message.chatId, message.messageId);
  if (message.chatType !== 'p2p' && !message.mentionedBot) return;

  const command = text.replace(/^<at>.*?<\/at>\s*/i, '').trim();
  if (command === '/help') return showHelp(lark, message.chatId, message.messageId);
  if (command.startsWith('/')) {
    await lark.send(message.chatId, { markdown: '飞书仅支持 `/help` 文本命令，其他操作请在操作面板中完成。' }, { replyTo: message.messageId });
    return;
  }
  const binding = state.get(message.chatId);
  const cwd = workspaceForChat(message.chatId);
  const sessions = await pi.list(cwd);
  if (!binding) {
    await lark.send(message.chatId, { markdown: '该群尚未绑定项目，请使用 `/help` 中的“创建项目群”。' }, { replyTo: message.messageId });
    return;
  }
  if (!binding.activeSessionFile) return showSessionSetup(lark, message, sessions, { message, text: command });
  const active = state.get(message.chatId)?.activeSessionFile;
  if (!active) return;
  await runPrompt(lark, message, text);
}

async function ensureDirectChat(chatId: string): Promise<ChatBinding> {
  const existing = state.get(chatId);
  if (existing) {
    if (existing.chatType !== 'p2p' || existing.cwd !== defaultWorkspace) {
      const binding = state.update(chatId, { chatType: 'p2p', cwd: defaultWorkspace });
      await state.flush();
      return binding!;
    }
    return existing;
  }
  return bindDirectChat(chatId);
}

async function bindDirectChat(chatId: string): Promise<ChatBinding> {
  const binding: ChatBinding = {
    cwd: defaultWorkspace,
    chatType: 'p2p',
    updatedAt: new Date().toISOString(),
  };
  state.set(chatId, binding);
  await state.flush();
  return binding;
}

async function createProject(lark: LarkChannel, userId: string, name: string, cwd: string): Promise<{ chatId: string }> {
  const created = await lark.createChat({ name, inviteUserIds: [userId], userIdType: 'open_id' });
  state.set(created.chatId, { cwd, chatType: 'group', updatedAt: new Date().toISOString() });
  await state.flush();
  await lark.send(created.chatId, { markdown: `已创建项目群 **${name}**\n\n工作目录：\`${cwd}\`\n\n请使用 \`/help\` 选择 new 或 resume。` });
  await updateAnnouncement(created.chatId);
  return created;
}

async function showHelp(lark: LarkChannel, chatId: string, replyTo?: string): Promise<void> {
  const binding = state.get(chatId);
  await lark.send(chatId, { card: helpCard(workspaceForChat(chatId), Boolean(binding), Boolean(binding?.activeSessionFile)) }, replyTo ? { replyTo } : undefined);
}

async function showSessionSetup(
  lark: LarkChannel,
  message: NormalizedMessage,
  sessions: Awaited<ReturnType<PiSessions['list']>>,
  prompt?: { message: NormalizedMessage; text: string },
): Promise<void> {
  const nonce = randomUUID();
  pending.set(message.chatId, { nonce, prompt });
  const card = sessions.length === 0
    ? createSessionFormCard(nonce, '新建 Session')
    : sessionPickerCard(workspaceForChat(message.chatId), sessions, nonce);
  await lark.send(message.chatId, { card }, { replyTo: message.messageId });
}

async function handleCardAction(lark: LarkChannel, event: CardActionEvent): Promise<CardActionResponse> {
  const value = event.action.value as Record<string, unknown> | undefined;
  if (!value || typeof value !== 'object') return toast('warning', '无效的卡片操作。');
  const cmd = value.cmd;
  if (cmd === 'command.form') {
    if (!state.get(event.chatId)) return toast('error', '该群尚未绑定项目。');
    await lark.send(event.chatId, { card: commandFormCard(workspaceForChat(event.chatId)) });
    return toast('success', '已打开命令执行表单。');
  }
  if (cmd === 'command.submit') {
    const binding = state.get(event.chatId);
    if (!binding) return toast('error', '该群尚未绑定项目。');
    const form = cardFormValue(event);
    const command = form.command;
    if (!command) return toast('error', '请填写命令。');
    const timeoutSeconds = parseCommandTimeout(form.timeoutSeconds);
    if (timeoutSeconds === null) return toast('error', '超时必须是 1 到 86400 之间的整数秒。');
    const taskId = randomUUID();
    void startShellCommand(lark, event.chatId, workspaceForChat(event.chatId), command, taskId, timeoutSeconds).catch((error) =>
      console.error('[command]', error),
    );
    return toast('success', '命令已开始执行。');
  }
  if (cmd === 'agent.stop' && typeof value.taskId === 'string') {
    if (!agentRuns.stop(event.chatId, value.taskId)) return toast('warning', '该 Agent 已结束。');
    return toast('success', '正在停止 Agent。');
  }
  if (cmd === 'command.output' && typeof value.taskId === 'string') {
    const task = commandTasks.get(value.taskId);
    if (!task || task.chatId !== event.chatId || !task.updater) return toast('warning', '该命令已经结束。');
    await task.updater.update(commandRunningCard(value.taskId, task.command, task.cwd, task.timeoutSeconds, commandOutputMarkdown(task.command, task.stdout, task.stderr, COMMAND_CARD_OUTPUT_LIMIT)));
    return toast('success', '已更新最新输出。');
  }
  if (cmd === 'command.stop' && typeof value.taskId === 'string') {
    const task = commandTasks.get(value.taskId);
    if (!task || task.chatId !== event.chatId) return toast('warning', '该命令已经结束。');
    task.stopped = true;
    task.terminate();
    if (task.updater) void task.updater.finish(commandFinalCard('正在停止命令', commandOutputMarkdown(task.command, task.stdout, task.stderr, COMMAND_CARD_OUTPUT_LIMIT)))
      .catch((error) => console.warn('[command stop status]', error));
    return toast('success', '正在停止命令。');
  }
  if (cmd === 'project.create.form') {
    const baseCwd = workspaceForChat(event.chatId);
    await lark.send(event.chatId, { card: createProjectFormCard(baseCwd) });
    return toast('success', '已打开创建项目群表单。');
  }
  if (cmd === 'project.create.submit') {
    const form = cardFormValue(event);
    const cwdInput = form.cwd;
    if (!cwdInput) return toast('error', '请填写工作路径。');
    const baseCwd = workspaceForChat(event.chatId);
    let cwd: string;
    try {
      cwd = resolveWorkspacePath(cwdInput, baseCwd);
    } catch (error) {
      return toast('error', error instanceof Error ? error.message : '工作路径无效。');
    }
    const name = form.name || `Pi · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    const created = await createProject(lark, event.operator.openId, name, cwd);
    await lark.send(event.chatId, { markdown: `已创建项目群 **${name}**。` });
    return toast('success', `已创建项目群（${created.chatId.slice(-8)}）。`);
  }
  const binding = state.get(event.chatId);
  if (!binding) return toast('error', '该群尚未绑定项目。');
  const cwd = workspaceForChat(event.chatId);
  const activeSessionFile = binding.activeSessionFile;
  const requireActiveSession = (): string | undefined => activeSessionFile;
  const createPending = (): string => {
    const nonce = randomUUID();
    pending.set(event.chatId, { nonce });
    return nonce;
  };
  const current = pending.get(event.chatId);
  if (typeof value.nonce === 'string' && current && value.nonce !== current.nonce) return toast('warning', '该操作卡片已过期，请重新打开 /help。');

  if (cmd === 'session.new.form') {
    const nonce = createPending();
    await lark.send(event.chatId, { card: createSessionFormCard(nonce, '新建 Session') });
    return toast('success', '请填写 Session 名称。');
  }
  if (cmd === 'session.resume.form') {
    const sessions = await pi.list(cwd);
    if (sessions.length === 0) return toast('warning', '当前路径没有可恢复的 Session，请使用 new。');
    const nonce = createPending();
    await lark.send(event.chatId, { card: sessionPickerCard(cwd, sessions, nonce) });
    return toast('success', '请选择要恢复的 Session。');
  }
  if (cmd === 'model.form') {
    if (!requireActiveSession()) return toast('warning', '请先使用 new 或 resume 选择 Session。');
    const models = await pi.models();
    if (models.length === 0) return toast('error', '没有可用的 provider/model。');
    const nonce = createPending();
    await lark.send(event.chatId, { card: modelPickerCard(models, nonce) });
    return toast('success', '请选择 provider/model。');
  }
  if (cmd === 'effort.form') {
    const sessionFile = requireActiveSession();
    if (!sessionFile) return toast('warning', '请先使用 new 或 resume 选择 Session。');
    const efforts = await pi.efforts(event.chatId, cwd, sessionFile);
    if (efforts.length === 0) return toast('warning', '当前 model 不支持思考强度设置。');
    const nonce = createPending();
    await lark.send(event.chatId, { card: effortPickerCard(efforts, nonce) });
    return toast('success', '请选择思考强度。');
  }
  if (cmd === 'session.sync.form') {
    if (!requireActiveSession()) return toast('warning', '请先使用 new 或 resume 选择 Session。');
    await lark.send(event.chatId, { card: syncFormCard() });
    return toast('success', '请填写同步条数。');
  }
  if (cmd === 'session.sync.submit') {
    const sessionFile = requireActiveSession();
    if (!sessionFile) return toast('warning', '请先使用 new 或 resume 选择 Session。');
    const count = parseSyncCount(cardFormValue(event).count);
    if (count === null) return toast('error', '同步条数必须是正整数。');
    const result = await syncComputerSessions(lark, event.chatId, 'manual', count);
    if (result.retry) return toast('warning', 'Session 正在写入，请稍后重试。');
    if (result.tooLong) return toast('error', '同步内容过长，请填写更小的同步轮数。');
    if (result.sent === 0) await lark.send(event.chatId, { markdown: '无待同步消息。' });
    return toast('success', result.sent ? `已同步 ${result.sent} 轮对话。` : '无待同步消息。');
  }
  if (cmd === 'session.rename.form') {
    if (!requireActiveSession()) return toast('warning', '请先使用 new 或 resume 选择 Session。');
    const nonce = createPending();
    await lark.send(event.chatId, { card: renameSessionFormCard(nonce) });
    return toast('success', '请填写 Session 名称。');
  }
  if (cmd === 'session.compact') {
    const sessionFile = requireActiveSession();
    if (!sessionFile) return toast('warning', '请先使用 new 或 resume 选择 Session。');
    void pi.compact(event.chatId, cwd, sessionFile).then(() => updateAnnouncement(event.chatId)).catch((error) => console.error('[compact]', error));
    return toast('success', '正在压缩 Session 上下文。');
  }
  if (cmd === 'model.select' && typeof value.provider === 'string' && typeof value.modelId === 'string') {
    const sessionFile = requireActiveSession();
    if (!sessionFile || !current) return toast('warning', '该操作卡片已过期，请重新打开 /help。');
    const selected = await pi.setModel(event.chatId, cwd, sessionFile, value.provider, value.modelId);
    pending.delete(event.chatId);
    void updateAnnouncement(event.chatId);
    return toast('success', `已切换到 ${selected.provider}/${selected.name}。`);
  }
  if (cmd === 'effort.select' && typeof value.effort === 'string') {
    const sessionFile = requireActiveSession();
    if (!sessionFile || !current) return toast('warning', '该操作卡片已过期，请重新打开 /help。');
    await pi.setEffort(event.chatId, cwd, sessionFile, value.effort as PiEffort);
    pending.delete(event.chatId);
    return toast('success', `已设置思考强度：${value.effort}。`);
  }
  if (cmd === 'session.rename.submit') {
    const sessionFile = requireActiveSession();
    if (!sessionFile || !current) return toast('warning', '该操作卡片已过期，请重新打开 /help。');
    const name = cardFormValue(event).name.replace(/[\r\n]+/g, ' ').trim();
    if (!name) return toast('error', '请填写 Session 名称。');
    await pi.rename(event.chatId, cwd, sessionFile, name);
    pending.delete(event.chatId);
    void updateAnnouncement(event.chatId);
    return toast('success', `已命名为 ${name}。`);
  }
  let selected: string;
  if (cmd === 'session.create.submit') {
    if (!current) return toast('warning', '该新建表单已过期，请重新打开 /help。');
    const name = cardFormValue(event).name.replace(/[\r\n]+/g, ' ').trim();
    if (!name) return toast('error', '请填写 Session 名称。');
    await useNewSession(lark, event.chatId, cwd, name);
    selected = name;
  } else if (cmd === 'session.use' && typeof value.sessionFile === 'string') {
    if (!current) return toast('warning', '该恢复卡片已过期，请重新打开 /help。');
    const sessions = await pi.list(cwd);
    const selectedSession = sessions.find((session) => session.path === value.sessionFile);
    if (!selectedSession) return toast('error', '该 Session 不属于当前项目或已不存在。');
    state.update(event.chatId, { activeSessionFile: value.sessionFile, sessionSync: undefined });
    await state.flush();
    await sessionSyncWatcher.reconcile();
    selected = sessionDisplayName(selectedSession);
  } else return toast('warning', '不支持的卡片操作。');
  pending.delete(event.chatId);
  void updateAnnouncement(event.chatId);
  const prompt = current?.prompt;
  if (prompt) {
    void runPrompt(lark, prompt.message, prompt.text).catch((error) => console.error('[card prompt]', error));
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
  const raw = event.raw as { action?: { form_value?: Record<string, unknown> } } | undefined;
  const value = event.action.formValue ?? raw?.action?.form_value ?? {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) =>
    typeof item === 'string' ? [[key, item.trim()]] : [],
  ));
}

function resolveWorkspacePath(input: string, baseCwd: string): string {
  const value = input.trim();
  if (!value) throw new Error('请填写工作路径。');
  if (value.startsWith('~') && value !== '~' && !value.startsWith('~/')) {
    throw new Error('仅支持 `~` 或 `~/...` 形式的用户目录路径。');
  }
  const expanded = value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
  return resolve(baseCwd, expanded);
}

async function useNewSession(lark: LarkChannel, chatId: string, cwd: string, name: string): Promise<void> {
  const sessionFile = await pi.create(cwd, name);
  state.update(chatId, { activeSessionFile: sessionFile, sessionSync: undefined });
  await state.flush();
  await sessionSyncWatcher.reconcile();
  await updateAnnouncement(chatId);
  await lark.send(chatId, { markdown: `已新建 session：\`${name}\`` });
}

async function runPrompt(lark: LarkChannel, message: NormalizedMessage, text: string): Promise<void> {
  const binding = state.get(message.chatId);
  if (!binding?.activeSessionFile) return;
  const before = new Set(await sessionEntryIds(binding.activeSessionFile));
  const prompt = await promptWithReplyContext(lark, message, text);
  state.update(message.chatId, { inFlightFeishuRun: { sessionFile: binding.activeSessionFile, beforeEntryIds: [...before], prompt } });
  await state.flush();
  await agentRuns.submit(message, workspaceForChat(message.chatId), binding.activeSessionFile, prompt, before, prompt);
}

async function promptWithReplyContext(lark: LarkChannel, message: NormalizedMessage, text: string): Promise<string> {
  if (!message.replyToMessageId) return text;
  try {
    const replied = await lark.fetchMessage(message.replyToMessageId);
    const content = replied?.content.trim();
    if (!replied || !content) return text;
    const excerpt = content.length > REPLY_CONTEXT_MAX_LENGTH
      ? `${content.slice(0, REPLY_CONTEXT_MAX_LENGTH)}\n[引用消息已截断]`
      : content;
    const sender = replied.senderName?.trim() || replied.senderId;
    return `<reply_context>\n回复消息发送者: ${sender}\n${excerpt}\n</reply_context>\n\n${text}`;
  } catch (error) {
    console.warn(`[reply context] ${message.messageId}:`, error);
    return text;
  }
}

async function startShellCommand(
  lark: LarkChannel,
  chatId: string,
  cwd: string,
  command: string,
  taskId: string,
  timeoutSeconds?: number,
): Promise<void> {
  const sent = await lark.send(chatId, { card: commandStartingCard(command, cwd, timeoutSeconds) });
  await runShellCommand(lark, chatId, cwd, command, taskId, sent.messageId, timeoutSeconds);
}

async function runShellCommand(
  lark: LarkChannel,
  chatId: string,
  cwd: string,
  command: string,
  taskId: string,
  messageId: string,
  timeoutSeconds?: number,
): Promise<void> {
  const shell = process.env.SHELL?.trim() || '/bin/sh';
  let child: ChildProcess;
  try {
    child = spawn(shell, ['-lc', command], {
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await lark.updateCard(messageId, commandFinalCard(`命令启动失败：${reason}`, commandOutputMarkdown(command, '', '', COMMAND_CARD_OUTPUT_LIMIT)));
    return;
  }
  let stdout = '';
  let stderr = '';
  let settled = false;
  const startedAt = Date.now();
  const append = (current: string, chunk: Buffer): string => `${current}${chunk.toString('utf8')}`.slice(-COMMAND_OUTPUT_LIMIT);
  const terminate = (): void => {
    if (child.pid && process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
      setTimeout(() => {
        if (!settled && child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }
      }, 5_000).unref();
      return;
    }
    child.kill('SIGTERM');
  };
  const task: CommandTask = {
    child, chatId, command, cwd, stopped: false, timedOut: false, timeoutSeconds, startedAt, stdout: '', stderr: '', terminate,
  };
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout = append(stdout, chunk);
    task.stdout = stdout;
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = append(stderr, chunk);
    task.stderr = stderr;
  });
  const resultPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
    child.once('error', (error) => resolve({ code: null, signal: null, error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  task.messageId = messageId;
  task.updater = createCardUpdater(lark, messageId, 'command status');
  commandTasks.set(taskId, task);
  void task.updater.update(commandRunningCard(taskId, command, cwd, timeoutSeconds)).catch((error) => console.warn('[command start status]', error));
  const timeout = timeoutSeconds
    ? setTimeout(() => {
      task.timedOut = true;
      if (task.updater) void task.updater
        .finish(commandFinalCard(`命令超时（${timeoutSeconds} 秒）`, commandOutputMarkdown(task.command, task.stdout, task.stderr, COMMAND_CARD_OUTPUT_LIMIT), elapsedSince(task.startedAt)))
        .catch((error) => console.warn('[command timeout status]', error));
      terminate();
    }, timeoutSeconds * 1_000)
    : undefined;

  const result = await resultPromise;
  settled = true;
  if (timeout) clearTimeout(timeout);
  commandTasks.delete(taskId);

  const statusText = task.timedOut
    ? `命令超时（${timeoutSeconds} 秒）并已停止。`
    : task.stopped
      ? '命令已手动停止。'
      : result.error
        ? `命令启动失败：${result.error.message}`
        : result.code === 0
          ? '命令执行完成。'
          : `命令执行失败（退出码 ${result.code ?? 'unknown'}${result.signal ? `，信号 ${result.signal}` : ''}）。`;
  await task.updater!.finish(commandFinalCard(statusText, commandOutputMarkdown(command, stdout, stderr, COMMAND_CARD_OUTPUT_LIMIT), elapsedSince(startedAt)));
}

function createCardUpdater(lark: LarkChannel, messageId: string, label: string): CardUpdater {
  let pendingCard: object | undefined;
  let updatePromise: Promise<void> | undefined;
  let finished = false;

  const startUpdate = (): Promise<void> => {
    if (updatePromise) return updatePromise;
    updatePromise = (async () => {
      while (!finished && pendingCard) {
        const card = pendingCard;
        pendingCard = undefined;
        await updateCardWithRetry(lark, messageId, card, label);
      }
    })().finally(() => {
      updatePromise = undefined;
    });
    return updatePromise;
  };

  const update = (card: object): Promise<void> => {
    if (finished) return Promise.resolve();
    pendingCard = card;
    return startUpdate();
  };

  const finish = (card: object): Promise<void> => {
    finished = true;
    pendingCard = undefined;
    const previous = updatePromise ?? Promise.resolve();
    return previous
      .catch((error) => console.warn(`[${label}] previous update failed`, error))
      .then(() => updateCardWithRetry(lark, messageId, card, label));
  };

  return { update, finish };
}

async function updateCardWithRetry(lark: LarkChannel, messageId: string, card: object, label: string): Promise<void> {
  let error: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await lark.updateCard(messageId, card);
      return;
    } catch (caught) {
      error = caught;
      if (attempt === 0) await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
  }
  console.warn(`[${label}] card update failed`, error);
  throw error;
}

function commandOutputMarkdown(command: string, stdout: string, stderr: string, limit = COMMAND_OUTPUT_LIMIT): string {
  const output = [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`].filter(Boolean).join('\n\n');
  const clipped = output.length > limit ? `${output.slice(-limit)}\n\n（输出已截断）` : output;
  return clipped ? `\`$ ${command}\`\n\n\`\`\`text\n${clipped}\n\`\`\`` : `\`$ ${command}\`\n\n（当前没有输出）`;
}

function elapsedSince(startedAt: number): string {
  return `${Math.max(1, Math.round((Date.now() - startedAt) / 1_000))} 秒`;
}

function agentFailureContent(latest: string, error: unknown, stopped: boolean): string {
  const reason = error instanceof Error ? error.toString() : String(error);
  const prefix = latest.trim();
  const suffix = `${stopped ? '已停止处理。\n' : ''}错误：${reason}`;
  return prefix ? `${prefix}\n\n${suffix}` : suffix;
}

async function ensureAutoBaseline(chatId: string): Promise<void> {
  const binding = state.get(chatId);
  if (!binding?.activeSessionFile) return;
  if (binding.sessionSync?.sessionFile === binding.activeSessionFile && binding.sessionSync.autoBaselineEntryId) return;
  let ids: string[] = [];
  try { ids = sessionBranchEntries(binding.activeSessionFile, workspaceForChat(chatId)).filter((entry) => entry.type === 'message').map((entry) => entry.id); } catch (error) {
    console.warn(`[session baseline] ${chatId}:`, error);
    return;
  }
  state.update(chatId, { sessionSync: { sessionFile: binding.activeSessionFile, autoBaselineEntryId: ids.at(-1) } });
  await state.flush();
}

async function syncComputerSessions(
  lark: LarkChannel,
  chatId: string,
  mode: 'auto' | 'manual',
  count?: number,
): Promise<{ sent: number; retry?: boolean; tooLong?: boolean }> {
  if (agentRuns.isActive(chatId) || state.get(chatId)?.inFlightFeishuRun) return { sent: 0 };
  const binding = state.get(chatId);
  if (!binding?.activeSessionFile) return { sent: 0 };
  const firstStat = await stat(binding.activeSessionFile).catch(() => undefined);
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  const secondStat = await stat(binding.activeSessionFile).catch(() => undefined);
  if (!firstStat || !secondStat || firstStat.size !== secondStat.size || firstStat.mtimeMs !== secondStat.mtimeMs) return { sent: 0, retry: true };
  let entries: Array<SessionMessageEntry & { message: NonNullable<SessionMessageEntry['message']> }>;
  try {
    entries = sessionBranchEntries(binding.activeSessionFile, workspaceForChat(chatId)).filter(isSessionMessageEntry);
  } catch (error) {
    console.warn(`[session sync read] ${chatId}:`, error);
    return { sent: 0, retry: true };
  }
  const sync = binding.sessionSync?.sessionFile === binding.activeSessionFile
    ? binding.sessionSync
    : { sessionFile: binding.activeSessionFile, autoBaselineEntryId: undefined };
  const indexOf = (id: string | undefined): number => id ? entries.findIndex((entry) => entry.id === id) : -1;
  const from = mode === 'auto'
    ? Math.max(indexOf(sync.lastSyncedEntryId), indexOf(sync.autoBaselineEntryId))
    : indexOf(sync.lastSyncedEntryId);
  const feishuOrigin = new Set(binding.feishuOriginEntryIds ?? []);
  const candidates = completedComputerTurns(entries).filter((turn) =>
    entries.findIndex((entry) => entry.id === turn.final.id) > from && !turn.entries.some((entry) => feishuOrigin.has(entry.id)),
  );
  const selected = mode === 'auto' ? candidates.slice(-1) : count ? candidates.slice(-count) : candidates;
  if (selected.length === 0) return { sent: 0 };
  const text = selected.map(formatComputerTurn).filter(Boolean).join('\n\n');
  if (!text) return { sent: 0 };
  const last = selected.at(-1)!;
  const status = await pi.statusAt(workspaceForChat(chatId), binding.activeSessionFile, last.final.id).catch(() => undefined);
  const body = `${text}${status ? `\n\n${status}` : ''}`;
  if (body.length > 30_000) return { sent: 0, tooLong: true };
  const sent = await lark.send(chatId, { post: { zh_cn: { title: '', content: [[{ tag: 'md', text: body }]] } } });
  state.update(chatId, {
    sessionSync: {
      sessionFile: binding.activeSessionFile,
      autoBaselineEntryId: sync.autoBaselineEntryId,
      lastSyncedEntryId: last.final.id,
      lastLarkMessageId: sent.messageId,
    },
  });
  await state.flush();
  return { sent: selected.length };
}

function formatComputerTurn(turn: ComputerTurn): string {
  const user = extractText(turn.user.message.content);
  const answer = turn.assistantMessages.map((entry) => extractText(entry.message.content)).filter(Boolean).join('\n\n');
  const failure = answer ? undefined : finalFailureMessage(turn);
  if (!user || (!answer && !failure)) return '';
  return `[User] ${formatSyncTimestamp(turn.user.timestamp)}\n${user}\n\n[Agent] ${formatSyncTimestamp(turn.final.timestamp)}\n${answer || `处理失败：${failure}`}`;
}

function parseSyncCount(value: string | undefined): number | undefined | null {
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) return null;
  const count = Number.parseInt(value, 10);
  return count > 0 && count <= 1_000 ? count : null;
}

type SessionMessageEntry = {
  type?: string;
  id: string;
  timestamp: unknown;
  message?: { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
};

type ComputerTurn = {
  user: SessionMessageEntry & { message: NonNullable<SessionMessageEntry['message']> };
  final: SessionMessageEntry & { message: NonNullable<SessionMessageEntry['message']> };
  assistantMessages: Array<SessionMessageEntry & { message: NonNullable<SessionMessageEntry['message']> }>;
  entries: Array<SessionMessageEntry & { message: NonNullable<SessionMessageEntry['message']> }>;
};

function isSessionMessageEntry(entry: SessionMessageEntry): entry is SessionMessageEntry & { message: NonNullable<SessionMessageEntry['message']> } {
  return entry.type === 'message' && typeof entry.id === 'string' && Boolean(entry.message?.role);
}

function isPublishableAssistant(entry: SessionMessageEntry & { message: NonNullable<SessionMessageEntry['message']> }): boolean {
  return entry.message.role === 'assistant'
    && entry.message.stopReason !== 'error'
    && entry.message.stopReason !== 'aborted';
}

function finalFailureMessage(turn: ComputerTurn): string | undefined {
  const message = turn.final.message;
  if (message.role !== 'assistant' || message.stopReason !== 'error') return undefined;
  if (isRetryablePiError(message.errorMessage)) {
    const attempts = turn.entries.filter((entry) =>
      entry.message.role === 'assistant'
      && entry.message.stopReason === 'error'
      && isRetryablePiError(entry.message.errorMessage),
    ).length;
    if (attempts <= piAutoRetryMaxRetries) return undefined;
  }
  return message.errorMessage?.trim() || 'pi 未提供具体错误信息。';
}

function isRetryablePiError(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  if (/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(errorMessage)) {
    return false;
  }
  return /overloaded|rate.?limit|too many requests|\b429\b|\b50[0-4]\b|\b524\b|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|upstream.?connect|reset before headers|socket hang up|socket connection was closed|timed? out|timeout|terminated|websocket.?closed|websocket.?error|ended without|stream ended before message_stop|stream ended before a terminal response event|http2 request did not get a response|retry delay|you can retry your request|try your request again|please retry your request|ResourceExhausted/i.test(errorMessage);
}

function completedComputerTurns(entries: Array<SessionMessageEntry & { message: NonNullable<SessionMessageEntry['message']> }>): ComputerTurn[] {
  const turns: ComputerTurn[] = [];
  for (let userIndex = 0; userIndex < entries.length; userIndex += 1) {
    const user = entries[userIndex];
    if (user.message.role !== 'user') continue;
    const nextUserIndex = entries.findIndex((entry, index) => index > userIndex && entry.message.role === 'user');
    const end = nextUserIndex === -1 ? entries.length : nextUserIndex;
    let final: (SessionMessageEntry & { message: NonNullable<SessionMessageEntry['message']> }) | undefined;
    for (let index = end - 1; index > userIndex; index -= 1) {
      const entry = entries[index];
      if (entry.message.role === 'assistant' && entry.message.stopReason !== 'toolUse') {
        final = entry;
        break;
      }
    }
    if (final) {
      const turnEntries = entries.slice(userIndex, end);
      turns.push({ user, final, assistantMessages: turnEntries.filter(isPublishableAssistant), entries: turnEntries });
    }
  }
  return turns;
}

async function markFeishuOrigin(chatId: string, sessionFile: string, before: Set<string>, prompt?: string): Promise<void> {
  const entries = sessionBranchEntries(sessionFile, workspaceForChat(chatId));
  const start = entries.findIndex((entry) => entry.type === 'message'
    && entry.message?.role === 'user'
    && !before.has(entry.id)
    && (!prompt || extractText(entry.message.content) === prompt));
  if (start === -1) return;
  const nextUser = entries.findIndex((entry, index) => index > start && entry.type === 'message' && entry.message?.role === 'user');
  const end = nextUser === -1 ? entries.length : nextUser;
  const ids = entries.slice(start, end)
    .filter((entry) => entry.type === 'message' && typeof entry.id === 'string')
    .map((entry) => entry.id);
  if (ids.length === 0) return;
  for (const [id, binding] of Object.entries(state.all())) {
    if (binding.activeSessionFile !== sessionFile) continue;
    const existing = binding.feishuOriginEntryIds ?? [];
    state.update(id, { feishuOriginEntryIds: [...new Set([...existing, ...ids])].slice(-1000) });
  }
  await state.flush();
}

function sessionBranchEntries(file: string, cwd: string): SessionMessageEntry[] {
  return SessionManager.open(file, undefined, cwd).getBranch() as unknown as SessionMessageEntry[];
}

async function sessionEntryIds(file: string): Promise<string[]> {
  try {
    return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: string; id?: string })
      .filter((entry) => entry.type === 'message' && typeof entry.id === 'string')
      .map((entry) => entry.id!);
  } catch { return []; }
}

async function updateAnnouncement(chatId: string): Promise<void> {
  const binding = state.get(chatId);
  if (!binding?.activeSessionFile || binding.chatType === 'p2p') return;
  try {
    await pi.ensure(binding.cwd, binding.activeSessionFile);
    const metadata = await readSessionMetadata(binding.activeSessionFile);
    const session = (await pi.list(binding.cwd)).find((item) => item.path === binding.activeSessionFile);
    const sessionName = session ? sessionDisplayName(session) : binding.activeSessionFile.split('/').pop()!;
    const announcement = await api.announcement(chatId);
    const blocks = await api.announcementBlocks(chatId);
    const content = `Project: ${metadata.cwd}\nProvider: ${metadata.provider ?? 'unknown'}\nModel: ${metadata.model ?? 'unknown'} · Thinking: ${metadata.thinkingLevel ?? 'unknown'}\nWork Path: ${binding.cwd}\nSession: ${sessionName}`;
    const textBlock = blocks.find((block) => block.block_type === 2 && block.text);
    if (!textBlock) {
      const rootBlock = blocks.find((block) => block.block_type === 1 && block.page);
      if (!rootBlock) { console.warn(`[announcement] no root block in ${chatId}`); return; }
      await api.createAnnouncementTextBlock(chatId, rootBlock.block_id, announcement.revision_id, content);
      await api.pinAnnouncement(chatId);
      const updated = await api.announcement(chatId);
      state.update(chatId, { announcementRevision: updated.revision_id });
    } else {
      const revision = await api.updateAnnouncement(chatId, announcement.revision_id, textBlock.block_id, content);
      state.update(chatId, { announcementRevision: revision });
    }
    await state.flush();
  } catch (error) { console.warn(`[announcement] ${chatId}:`, error); }
}

async function readSessionMetadata(file: string): Promise<{ cwd: string; provider?: string; model?: string; thinkingLevel?: string }> {
  const lines = (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as any);
  const header = lines.find((entry) => entry.type === 'session');
  const model = [...lines].reverse().find((entry) => entry.type === 'model_change');
  const thinking = [...lines].reverse().find((entry) => entry.type === 'thinking_level_change');
  return { cwd: header?.cwd ?? '', provider: model?.provider, model: model?.modelId, thinkingLevel: thinking?.thinkingLevel };
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.filter((item) => item?.type === 'text').map((item) => item.text ?? '').join('').trim();
}

function formatSyncTimestamp(timestamp: unknown): string {
  const date = new Date(typeof timestamp === 'string' || typeof timestamp === 'number' ? timestamp : NaN);
  if (Number.isNaN(date.getTime())) return '??-??-?? ??:??:??';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.getFullYear()).slice(-2)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function workspaceForChat(chatId: string): string {
  const binding = state.get(chatId);
  return binding?.chatType === 'p2p' ? defaultWorkspace : binding?.cwd ?? defaultWorkspace;
}

function allowed(message: NormalizedMessage): boolean { return message.senderId !== channel.botIdentity?.openId; }
function required(name: string): string { const value = process.env[name]?.trim(); if (!value) throw new Error(`Missing environment variable: ${name}`); return value; }
function nonNegativeIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer.`);
  return Number.parseInt(value, 10);
}
let shutdownPromise: Promise<void> | undefined;

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
async function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    for (const task of commandTasks.values()) task.terminate();
    commandTasks.clear();
    sessionSyncWatcher.close();
    await agentRuns.shutdown();
    await pi.dispose();
    await state.flush();
    await channel.disconnect();
    await instanceLock.close();
    process.exit(0);
  })();
  return shutdownPromise;
}

async function acquireInstanceLock(file: string): Promise<FileHandle> {
  try {
    const handle = await open(file, 'wx');
    await handle.writeFile(`${process.pid}\n`, 'utf8');
    return handle;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try {
      const pid = Number.parseInt((await readFile(file, 'utf8')).trim(), 10);
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, 0);
      throw new Error(`Another lark-agent-os instance is already running (pid ${pid || 'unknown'})`);
    } catch (probeError) {
      if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError;
      await import('node:fs/promises').then(({ unlink }) => unlink(file));
      return acquireInstanceLock(file);
    }
  }
}
