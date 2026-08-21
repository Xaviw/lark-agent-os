import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { CardActionEvent, CardActionResponse, SendInput } from '@larksuite/channel';
import type { AppContext } from '../app-context.js';
import { CARD_EVENT_SEEN_TTL_MS, COMMAND_CARD_OUTPUT_LIMIT, PENDING_PROMPT_MAX_MS } from '../config.js';
import { createSeenSet } from '../utils/seen.js';
import { createCardUpdater } from '../utils/card-update.js';
import { takePendingPrompt } from '../utils/pending-prompt.js';
import type { CardUpdater } from '../types.js';
import type { PiThinkingLevel } from '../pi.js';
import type { CardButtonValue, CardCommand, CardFormName, CardFormValues } from '../cards.js';
import { askFormCard, bgTaskListCard, bindProjectFormCard, commandFinalCard, commandFormCard, compactFailureCard, compactStartingCard, compactSuccessCard, createProjectFormCard, createSessionFormCard, modelPickerCard, reloadFailureCard, reloadStartingCard, reloadSuccessCard, renameSessionFormCard, sessionDisplayName, sessionPickerCard, syncFormCard, thinkingLevelPickerCard } from '../cards.js';
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

// ── 命令上下文与注册项 ──────────────────────────────────────────────────────

/**
 * 分发器注入 handler 的共享工具集：前置校验 / 话题感知 / 后台任务 / 表单解析全部收敛于此，
 * handler 只写业务逻辑（locality：每个命令的前置与逻辑同处一个注册项）。
 */
type CommandContext = {
  ctx: AppContext;
  event: CardActionEvent;
  /** 命令注册项声明的 fire-and-forget 独占守卫 key（无则不独占执行） */
  taskKey?: string;
  /** 群工作路径（绑定 cwd；私聊固定默认工作区；未绑定回退默认工作区） */
  cwd: string;
  /** requiresSession 命令：分发器已解析的活动会话文件（话题内为懒初始化独立会话）；其余命令无 */
  sessionFile?: string;
  /** 惰性话题解析：仅需要话题语义时反查（发送侧缓存命中 → 零网络开销；仅重启后的旧卡回退 fetchMessage） */
  resolveThread: () => Promise<string | undefined>;
  /** 话题内回复到触发卡（保持在话题窗口内）；发送后记录新卡上下文，供后续操作直接命中缓存 */
  send: (input: SendInput) => Promise<void>;
  fireAndForget: typeof fireAndForget;
  toast: typeof toast;
  sessionFileExists: typeof sessionFileExists;
  formValue: <K extends CardFormName>(event: CardActionEvent, name: K) => CardFormValues[K];
};

/** 命令注册项：前置声明 + 处理器（cmd 即注册表键） */
type CommandEntry = {
  /** 需要已绑定项目（未绑定 → toast「该群尚未绑定项目」） */
  requiresBinding?: boolean;
  /** 需要活动会话（无 → toast「请先使用「新建会话」或「切换会话」」；话题内触发独立会话懒初始化） */
  requiresSession?: boolean;
  /** 话题内拦截（话题 = 独立会话，群级会话管理 / 项目绑定 / 同步不可用） */
  topicBlocked?: boolean;
  /** fire-and-forget 独占守卫 key：busy 判定由 fireAndForget 内部统一持有 */
  taskKey?: string;
  run: (c: CommandContext) => Promise<CardActionResponse>;
};

// ── 共享 helper ────────────────────────────────────────────────────────────

/** 卡片事件防重推（event_id 去重，内存态，重启即清） */
const seenCardEvents = createSeenSet(CARD_EVENT_SEEN_TTL_MS);

/**
 * fire-and-forget 独占守卫：按 (taskKey, chatId) 记录进行中任务（原 5 个模块级 Set 收敛于此）。
 * 守卫声明与命令同处注册项（taskKey），状态统一由 fireAndForget 管理。
 */
const busyKeys = new Map<string, Set<string>>();
function isBusy(taskKey: string, chatId: string): boolean {
  return busyKeys.get(taskKey)?.has(chatId) ?? false;
}
function beginBusy(taskKey: string, chatId: string): void {
  const set = busyKeys.get(taskKey) ?? new Set<string>();
  set.add(chatId);
  busyKeys.set(taskKey, set);
}
function endBusy(taskKey: string, chatId: string): void {
  const set = busyKeys.get(taskKey);
  if (!set) return;
  set.delete(chatId);
  if (set.size === 0) busyKeys.delete(taskKey);
}

/** 用户可见错误文本：剥离内部 API 路径等细节（完整 error 已由日志保留） */
function userFacingError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Feishu API \/open-apis\/[^:\n]+: /, '飞书 API 错误：');
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

const FORM_FIELDS: { [K in CardFormName]: readonly (keyof CardFormValues[K])[] } = {
  command_form: ['command', 'timeoutSeconds', 'isBackground'],
  quick_ask_form: ['prompt'],
  project_create_form: ['name', 'cwd'],
  project_bind_form: ['cwd'],
  session_create_form: ['name'],
  session_sync_form: ['count'],
  session_name_form: ['name'],
};

/** 按表单名读取白名单字段，trim 字符串并保留 checker 布尔值。 */
function formValue<K extends CardFormName>(event: CardActionEvent, name: K): CardFormValues[K] {
  const allowed = new Set<string>(FORM_FIELDS[name].map(String));
  return Object.fromEntries(Object.entries(rawFormValue(event)).flatMap(([key, item]) => {
    if (!allowed.has(key)) return [];
    return typeof item === 'string' || typeof item === 'boolean'
      ? [[key, typeof item === 'string' ? item.trim() : item]]
      : [];
  })) as CardFormValues[K];
}

/** 提取卡片表单原始 form_value（string / boolean 等） */
function rawFormValue(event: CardActionEvent): Record<string, unknown> {
  const raw = event.raw as { action?: { form_value?: Record<string, unknown> } } | undefined;
  return event.action.formValue ?? raw?.action?.form_value ?? {};
}

/** 读取已通过 CardButtonValue 契约的按钮值。 */
function buttonValue(c: CommandContext): CardButtonValue | undefined {
  const value = c.event.action.value as Record<string, unknown> | undefined;
  return value && typeof value.cmd === 'string' ? value as CardButtonValue : undefined;
}

type StringButtonField = 'taskId' | 'sessionFile' | 'provider' | 'modelId' | 'thinkingLevel' | 'baseCwd';
function buttonString(c: CommandContext, field: StringButtonField): string | undefined {
  const value = buttonValue(c);
  if (!value || !(field in value)) return undefined;
  const item = (value as Record<string, unknown>)[field];
  return typeof item === 'string' ? item : undefined;
}

/** 消费并续跑挂起消息；返回结果类型供 session.use 生成对应 toast。 */
type PendingPromptKind = ReturnType<typeof takePendingPrompt>['kind'];
function resumePendingPrompt(c: CommandContext): PendingPromptKind {
  const outcome = takePendingPrompt(c.ctx.pending, c.event.chatId, PENDING_PROMPT_MAX_MS);
  if (outcome.kind !== 'ok') return outcome.kind;
  void runPrompt(c.ctx, outcome.message, outcome.text).catch((error) => {
    console.error('[card prompt]', error);
    void c.send({ markdown: `消息处理失败：${error instanceof Error ? error.message : String(error)}` })
      .catch((noticeError) => console.warn('[card prompt fail notice]', noticeError));
  });
  return 'ok';
}

function parseCommandTimeout(value: string | undefined): number | undefined | null {
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) return null;
  const seconds = Number.parseInt(value, 10);
  return seconds >= 1 && seconds <= 86_400 ? seconds : null;
}

/**
 * fire-and-forget 后台任务：卡片回调需 3s 内 ack（SDK 等 handler 返回才发 ack），重量级链路
 * （同步 / 建群 / 建会话 / 状态卡）后台异步执行、先回 toast，避免阻塞 ack 触发平台重推。
 * 统一负责：
 * - 独占守卫（c.taskKey × chatId；进行中重复触发返回 false，由调用方回 busy toast）；
 * - 失败兜底（发 failPrefix + 错误消息）；
 * - pendingBackground 登记（shutdown 等待收尾，避免进度 / 绑定未落盘）。
 * 调用方须先完成输入校验再调用（busy 判定在业务校验之后，与历史行为一致）。
 */
function fireAndForget(c: CommandContext, opts: {
  failPrefix: string;
  task: () => Promise<void>;
}): boolean {
  const taskKey = c.taskKey;
  const chatId = c.event.chatId;
  if (!taskKey) return false;
  if (isBusy(taskKey, chatId)) return false;
  beginBusy(taskKey, chatId);
  const promise = (async () => {
    try {
      await opts.task();
    } catch (error) {
      console.error(`[${taskKey}]`, error);
      void c.send({ markdown: `${opts.failPrefix}${userFacingError(error)}` })
        .catch((noticeError) => console.warn(`[${taskKey} fail notice]`, noticeError));
    } finally {
      endBusy(taskKey, chatId);
    }
  })();
  c.ctx.pendingBackground.add(promise);
  void promise.finally(() => { c.ctx.pendingBackground.delete(promise); });
  return true;
}

/** 后台发送卡片（fire-and-forget）：先回 toast、后台异步发送（失败补发消息），卡片显示由发送完成自然呈现 */
function fireSendCard(c: CommandContext, card: object, failLabel: string): void {
  void c.send({ card }).catch((error) => {
    console.error(`[card send] ${failLabel}`, error);
    void c.send({ markdown: `${failLabel}打开失败：${userFacingError(error)}` }).catch((noticeError) => console.warn('[card send fail notice]', noticeError));
  });
}

/** 打开表单 / 选择器等纯「回卡」命令（fireSendCard + 固定成功 toast 的通用形态） */
function openForm(makeCard: (c: CommandContext) => object, failLabel: string, successToast: string): CommandEntry['run'] {
  return (c) => {
    fireSendCard(c, makeCard(c), failLabel);
    return Promise.resolve(c.toast('success', successToast));
  };
}

/** 需要先读取 pi 数据的选择器：读取、卡片发送、失败提示全部后台执行，handler 立即 ack。 */
function fireLoadCard(c: CommandContext, load: () => Promise<SendInput>, failLabel: string): void {
  void load()
    .then((input) => c.send(input))
    .catch((error) => {
      console.error(`[card load] ${failLabel}`, error);
      void c.send({ markdown: `${failLabel}打开失败：${userFacingError(error)}` })
        .catch((noticeError) => console.warn('[card load fail notice]', noticeError));
    });
}

/** 状态卡链路选项（guard / chatId / logLabel 收敛到 c.taskKey / c.event） */
type StatusCardOpOptions<T> = {
  /** 立即弹出的起始卡 */
  startingCard: object;
  /** createCardUpdater 标签 */
  tag: string;
  /** 实际操作（通常串行于 session 锁内，等待期间起始卡保持进行中状态） */
  op: () => Promise<T>;
  /** 成功最终卡（可携带 op 结果，如压缩前后对比 / reload 后状态栏） */
  successCard: (result: T) => object;
  /** 失败最终卡 */
  failureCard: (reason: string) => object;
  /** 起始卡未发出时的降级失败消息前缀 */
  failPrefix: string;
};

/**
 * 运行「状态卡链路」的 fire-and-forget 异步操作：立即弹 starting 卡 → 执行 op →
 * finish 更新为 success 卡；失败更新为 failure 卡；起始卡都未发出（群失效 / 网络异常）时
 * 退化为直接发失败消息（fireAndForget 兜底）。进行中（c.taskKey busy）返回 false，调用方回 busy toast。
 */
function runStatusCardOp<T>(c: CommandContext, opts: StatusCardOpOptions<T>): boolean {
  return fireAndForget(c, {
    failPrefix: opts.failPrefix,
    task: async () => {
      let updater: CardUpdater | undefined;
      try {
        const threadId = await c.resolveThread();
        const sent = await sendChat(c.ctx, c.event.chatId, { card: opts.startingCard }, threadId ? { replyTo: c.event.messageId } : undefined);
        updater = createCardUpdater(c.ctx, c.event.chatId, sent.messageId, opts.tag);
        const result = await opts.op();
        await updater.finish(opts.successCard(result))
          .catch((updateError) => console.warn(`[${c.taskKey} success status]`, updateError));
      } catch (error) {
        console.error(`[${c.taskKey}]`, error);
        const reason = escapeMarkdown(userFacingError(error)).slice(0, 200);
        if (updater) {
          // 起始卡已发出：更新为失败卡（失败可能只是「Already compacted」等，均视为未生效）
          void updater.finish(opts.failureCard(reason)).catch((updateError) => console.warn(`[${c.taskKey} fail status]`, updateError));
        } else {
          // 起始卡都未发出（群失效 / 网络异常）：交给 fireAndForget 兜底发失败消息
          throw error;
        }
      }
    },
  });
}

// ── 命令注册表 ──────────────────────────────────────────────────────────────

/** help.open 是规范命令；help 保留为历史卡片兼容别名。 */
const helpCommand: CommandEntry['run'] = async (c) => {
  const { ctx, event } = c;
  const tid = await c.resolveThread();
  void showHelp(ctx, event.chatId, event.messageId, tid).catch((error) => {
    console.error('[help]', error);
    void c.send({ markdown: `操作面板打开失败：${userFacingError(error)}` }).catch(() => undefined);
  });
  return c.toast('success', '已打开操作面板。');
};

/**
 * 命令注册表：cmd → 前置声明 + 处理器。
 * `Record<CardCommand, CommandEntry>` 标注保证契约（cards.ts 的 CardCommand 联合）中每个命令都有注册项，
 * 遗漏 / 拼错 cmd 编译期即报错。全部命令按域分组，逻辑与改造前逐字等价。
 */
const REGISTRY: Record<CardCommand, CommandEntry> = {
  // ── 通用 / 项目 ──
  'help.open': { run: helpCommand },
  'help': { run: helpCommand },
  'project.create.form': {
    run: openForm((c) => createProjectFormCard(c.cwd), '创建项目群表单', '已打开创建项目群表单。'),
  },
  'project.create.submit': {
    taskKey: 'project.create',
    async run(c) {
      const { ctx, event } = c;
      const form = c.formValue(event, 'project_create_form');
      const cwdInput = form.cwd;
      if (!cwdInput) return c.toast('error', '请填写工作路径。');
      const baseCwd = buttonString(c, 'baseCwd') ?? c.cwd;
      let cwd: string;
      try {
        cwd = resolveWorkspacePath(cwdInput, baseCwd);
        await assertWorkspaceDirectory(cwd);
      } catch (error) {
        return c.toast('error', error instanceof Error ? error.message : '工作路径无效。');
      }
      const name = form.name || defaultProjectName(cwd);
      // 防并发重复建群：后台化后建群窗口拉长（createChat 一般 1-3s，后台执行期间再点会重复建群）
      // 建群是重量级链路（建群 + 拉人、欢迎消息、群公告 Docx API 链），可能超过飞书 3s 事件响应窗口——
      // 先回 toast、后台异步执行（成功由新群欢迎消息 + 本群确认消息呈现，失败补发错误消息）。
      if (!fireAndForget(c, {
        failPrefix: '创建项目群失败：',
        task: async () => {
          const created = await createProject(ctx, event.operator.openId, name, cwd);
          console.debug(`[project create] ${created.chatId} 已创建项目群：${name}`);
          await c.send({ markdown: `已创建项目群 **${name}**（${created.chatId.slice(-8)}）。` });
        },
      })) return c.toast('warning', '项目群正在创建中，请稍候。');
      return c.toast('success', '正在创建项目群…');
    },
  },
  'project.bind.form': {
    topicBlocked: true,
    async run(c) {
      if (c.ctx.state.get(c.event.chatId)?.chatType === 'p2p') return c.toast('warning', '私聊固定使用默认工作区，不支持绑定项目。');
      fireSendCard(c, bindProjectFormCard(c.cwd, Boolean(c.ctx.state.get(c.event.chatId))), '绑定项目表单');
      return c.toast('success', '已打开绑定项目表单。');
    },
  },
  'project.bind.submit': {
    topicBlocked: true,
    async run(c) {
      const { ctx, event } = c;
      if (ctx.state.get(event.chatId)?.chatType === 'p2p') return c.toast('warning', '私聊固定使用默认工作区，不支持绑定项目。');
      const form = c.formValue(event, 'project_bind_form');
      const cwdInput = form.cwd;
      if (!cwdInput) return c.toast('error', '请填写工作路径。');
      const baseCwd = buttonString(c, 'baseCwd') ?? c.cwd;
      let cwd: string;
      try {
        cwd = resolveWorkspacePath(cwdInput, baseCwd);
        await assertWorkspaceDirectory(cwd);
      } catch (error) {
        return c.toast('error', error instanceof Error ? error.message : '工作路径无效。');
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
      if (!(await c.resolveThread())) void updateAnnouncement(ctx, event.chatId);
      return c.toast('success', bound ? '已修改项目绑定。' : '已绑定项目。');
    },
  },

  // ── 命令执行 / 快速提问 / 停止 ──
  'command.form': {
    requiresBinding: true,
    run: openForm((c) => commandFormCard(c.cwd, process.platform === 'win32'), '命令表单', '已打开命令执行表单。'),
  },
  'command.submit': {
    requiresBinding: true,
    async run(c) {
      const { ctx, event } = c;
      const form = c.formValue(event, 'command_form');
      const command = form.command;
      if (!command) return c.toast('error', '请填写命令。');
      const isBackground = form.isBackground === true;
      // 常驻任务模式忽略超时：跳过格式校验（“忽略超时秒数”语义）
      const timeoutSeconds = isBackground ? undefined : parseCommandTimeout(form.timeoutSeconds);
      if (timeoutSeconds === null) return c.toast('error', '超时必须是 1 到 86400 之间的整数秒。');
      const taskId = randomUUID();
      // 话题上下文：命令卡回复到触发表单卡（保持在话题窗口内）
      void startShellCommand(ctx, event.chatId, c.cwd, command, taskId, isBackground ? undefined : timeoutSeconds, isBackground, (await c.resolveThread()) ? event.messageId : undefined).catch((error) => {
        console.error('[command]', error);
        // 启动前失败（starting 卡发送失败等）用户无感知，补发失败消息（spawn 失败本身已有失败卡）
        void c.send({ markdown: `命令启动失败：${error instanceof Error ? error.message : String(error)}` }).catch((noticeError) => console.warn('[command fail notice]', noticeError));
      });
      return c.toast('success', isBackground ? '后台任务已启动。' : '命令已开始执行。');
    },
  },
  'command.stop': {
    async run(c) {
      const { ctx, event } = c;
      const taskId = buttonString(c, 'taskId');
      if (!taskId) return c.toast('warning', '不支持的卡片操作。');
      const task = ctx.commandTasks.get(taskId);
      if (!task || task.chatId !== event.chatId) return c.toast('warning', '该命令已经结束。');
      task.stopped = true;
      task.terminate();
      if (task.updater) void task.updater.finish(commandFinalCard('正在停止命令', `${commandOutputMarkdown(task.command, task.stdout, task.stderr, COMMAND_CARD_OUTPUT_LIMIT)}\n\n正在停止命令。`))
        .catch((error) => console.warn('[command stop status]', error));
      return c.toast('success', '正在停止命令。');
    },
  },
  'quickAsk.form': {
    requiresBinding: true,
    run: openForm((c) => askFormCard(c.cwd), '快速提问表单', '已打开快速提问表单。'),
  },
  'quickAsk.submit': {
    requiresBinding: true,
    async run(c) {
      const { ctx, event } = c;
      const prompt = c.formValue(event, 'quick_ask_form').prompt;
      if (!prompt) return c.toast('error', '请填写问题内容。');
      // 话题上下文：提问任务卡回复到触发表单卡（保持在话题窗口内）
      const tid = await c.resolveThread();
      void runQuickAsk(ctx, event.chatId, prompt, { replyTo: tid ? event.messageId : undefined, threadId: tid }).catch((error) => {
        console.error('[quick ask]', error);
        void c.send({ markdown: `快速提问启动失败：${error instanceof Error ? error.message : String(error)}` }).catch((noticeError) => console.warn('[quick ask fail notice]', noticeError));
      });
      return c.toast('success', '已提交快速提问。');
    },
  },
  'agent.stop': {
    async run(c) {
      const taskId = buttonString(c, 'taskId');
      if (!taskId) return c.toast('warning', '不支持的卡片操作。');
      if (!c.ctx.agentRuns.stop(c.event.chatId, taskId)) return c.toast('warning', '该 Agent 已结束。');
      return c.toast('success', '正在停止 Agent。');
    },
  },
  'bgTask.form': {
    run: openForm((c) => bgTaskListCard([...c.ctx.backgroundTasks.values()].map((task) => ({ id: task.id, command: task.command, startedAt: task.startedAt }))), '后台任务列表', '已打开后台任务列表。'),
  },
  'bgTask.stop': {
    async run(c) {
      const taskId = buttonString(c, 'taskId');
      if (!taskId) return c.toast('warning', '不支持的卡片操作。');
      const task = c.ctx.backgroundTasks.get(taskId);
      if (!task) return c.toast('warning', '该后台任务已结束。');
      task.terminate();
      c.ctx.backgroundTasks.delete(taskId);
      fireSendCard(c, bgTaskListCard([...c.ctx.backgroundTasks.values()].map((task) => ({ id: task.id, command: task.command, startedAt: task.startedAt }))), '后台任务列表刷新');
      return c.toast('success', '后台任务已停止。');
    },
  },

  // ── 会话管理（话题内不可用）──
  'session.new.form': {
    requiresBinding: true,
    topicBlocked: true,
    run: openForm(() => createSessionFormCard(), '新建会话表单', '请填写会话名称。'),
  },
  'session.resume.form': {
    requiresBinding: true,
    topicBlocked: true,
    async run(c) {
      fireLoadCard(c, async () => {
        const sessions = await c.ctx.pi.list(c.cwd);
        return sessions.length === 0
          ? { markdown: '当前工作路径没有可切换的历史会话，请使用「新建会话」。' }
          : { card: sessionPickerCard(c.cwd, sessions) };
      }, '会话选择器');
      return c.toast('success', '正在加载历史会话，请稍候。');
    },
  },
  'session.use': {
    requiresBinding: true,
    topicBlocked: true,
    async run(c) {
      const { ctx, event } = c;
      const sessionFile = buttonString(c, 'sessionFile');
      if (!sessionFile) return c.toast('warning', '不支持的卡片操作。');
      const sessions = await ctx.pi.list(c.cwd);
      const selectedSession = sessions.find((session) => session.path === sessionFile);
      if (!selectedSession) return c.toast('error', '该会话不属于当前项目或已不存在。');
      ctx.state.update(event.chatId, { activeSessionFile: sessionFile, sessionSync: undefined });
      await ctx.state.flush();
      await ctx.sessionSyncWatcher.reconcile();
      const selected = sessionDisplayName(selectedSession);
      if (!(await c.resolveThread())) void updateAnnouncement(ctx, event.chatId);
      // 挂起消息一次性续跑（消费即删；超过 PENDING_PROMPT_MAX_MS 不再续跑）——历史卡重复点击只切换、不重复发送
      const pendingPromptKind = resumePendingPrompt(c);
      if (pendingPromptKind === 'ok') return c.toast('success', `已切换到 ${selected}，正在处理消息。`);
      if (pendingPromptKind === 'expired') return c.toast('warning', `已切换到 ${selected}。之前挂起的消息已超过 ${PENDING_PROMPT_MAX_MS / 60_000} 分钟未处理，请重新发送。`);
      return c.toast('success', `已切换到 ${selected}。`);
    },
  },
  'session.create.submit': {
    requiresBinding: true,
    topicBlocked: true,
    taskKey: 'session.create',
    async run(c) {
      const { ctx, event } = c;
      const name = (c.formValue(event, 'session_create_form').name ?? '').replace(/[\r\n]+/g, ' ').trim();
      if (!name) return c.toast('error', '请填写会话名称。');
      // 防并发重复创建：创建流程进行中再次点击直接提示（fire-and-forget 后完成信号由「已新建会话」消息承担）
      // 会话创建是重量级链路（pi 首次初始化 + 公告 Docx API 链 + 发消息），可能超过飞书 3s 事件响应窗口——
      // 改为先回 toast、后台异步执行（失败补发消息，不再阻塞 ack）；挂起消息续跑随之移入后台。
      if (!fireAndForget(c, {
        failPrefix: '会话创建失败：',
        task: async () => {
          console.debug(`[session create] ${event.chatId} 开始创建会话：${name}`);
          await useNewSession(ctx, event.chatId, c.cwd, name);
          // 挂起消息一次性续跑（消费即删；超过 PENDING_PROMPT_MAX_MS 不再续跑）——toast 已回，续跑结果由处理中卡片呈现
          resumePendingPrompt(c);
        },
      })) return c.toast('warning', '正在创建会话，请稍候。');
      return c.toast('success', `已创建会话：${name}，正在初始化。`);
    },
  },
  'session.rename.form': {
    requiresBinding: true,
    requiresSession: true,
    run: openForm(() => renameSessionFormCard(), '会话重命名表单', '请填写会话名称。'),
  },
  'session.rename.submit': {
    requiresBinding: true,
    requiresSession: true,
    async run(c) {
      const { ctx, event } = c;
      if (!(await c.sessionFileExists(c.sessionFile!))) return c.toast('warning', '该会话已不存在，请使用「切换会话」重新选择。');
      const name = (c.formValue(event, 'session_name_form').name ?? '').replace(/[\r\n]+/g, ' ').trim();
      if (!name) return c.toast('error', '请填写会话名称。');
      await ctx.pi.rename(c.cwd, c.sessionFile!, name);
      if (!(await c.resolveThread())) void updateAnnouncement(ctx, event.chatId);
      return c.toast('success', `已命名为 ${name}。`);
    },
  },
  'session.compact': {
    requiresBinding: true,
    requiresSession: true,
    taskKey: 'session.compact',
    async run(c) {
      const { ctx } = c;
      // 状态卡链路见 runStatusCardOp（fire-and-forget，防 3s ack 超时）；压缩会排队等待 session 锁（多群共享 / agent 处理中）
      if (!runStatusCardOp(c, {
        startingCard: compactStartingCard(),
        tag: 'compact status',
        op: () => ctx.pi.compact(c.cwd, c.sessionFile!),
        successCard: (result) => compactSuccessCard(formatCompactResult(result.tokensBefore, result.estimatedTokensAfter), result.status),
        failureCard: (reason) => compactFailureCard(reason),
        failPrefix: '会话压缩失败：',
      })) return c.toast('warning', '正在压缩会话，请稍候。');
      return c.toast('success', '正在压缩会话上下文。');
    },
  },
  'config.reload': {
    requiresBinding: true,
    requiresSession: true,
    taskKey: 'config.reload',
    async run(c) {
      const { ctx } = c;
      // 状态卡链路见 runStatusCardOp；reload 会重建扩展 runtime（MCP 等扩展重启初始化），与 compact 同受 session 锁串行
      if (!runStatusCardOp(c, {
        startingCard: reloadStartingCard(),
        tag: 'reload status',
        op: () => ctx.pi.reload(c.cwd, c.sessionFile!),
        successCard: (status) => reloadSuccessCard(status),
        failureCard: (reason) => reloadFailureCard(reason),
        failPrefix: '重新加载失败：',
      })) return c.toast('warning', '正在重新加载，请稍候。');
      return c.toast('success', '正在重新加载配置。');
    },
  },
  'session.sync.form': {
    requiresBinding: true,
    requiresSession: true,
    topicBlocked: true,
    run: openForm(() => syncFormCard(), '同步设置表单', '请填写同步条数。'),
  },
  'session.sync.submit': {
    requiresBinding: true,
    requiresSession: true,
    topicBlocked: true,
    taskKey: 'session.sync',
    async run(c) {
      const { ctx, event } = c;
      if (!(await c.sessionFileExists(c.sessionFile!))) return c.toast('warning', '该会话已不存在，请使用「切换会话」重新选择。');
      const count = parseSyncCount(c.formValue(event, 'session_sync_form').count);
      if (count === null) return c.toast('error', '同步条数必须是正整数。');
      // 防并发重复同步：后台化后两个同步提交同时读到同一未推进进度，会重复发送相同轮次（进度由最后一条推进，完成前不变）
      // 同步是重量级链路（读/解析 session JSONL、statusAt 快照初始化模型运行时、28KB 富文本发送、state 落盘），
      // 可能超过飞书 3s 事件响应窗口——先回 toast、后台异步执行，结果以消息呈现，不再阻塞 ack。
      if (!fireAndForget(c, {
        failPrefix: '同步失败：',
        task: async () => {
          const result = await syncComputerSessions(ctx, event.chatId, 'manual', count);
          const message = result.retry ? '会话正在写入，请稍后重试。'
            : result.busy ? 'Agent 正在处理消息，请稍后再同步。'
            : result.progressReset ? '会话文件已更新（可能已压缩），同步进度已重置。请再次同步；结果可能包含已发送的历史轮次。'
            : result.sent > 0 ? `已同步 ${result.sent} 轮对话${result.truncated ? '（内容已截断）' : ''}。`
            : '无待同步消息。';
          await c.send({ markdown: message });
        },
      })) return c.toast('warning', '同步正在进行中，请稍候。');
      return c.toast('success', '正在同步消息，请稍候。');
    },
  },

  // ── 会话设置（模型 / 思考强度）──
  'model.form': {
    requiresBinding: true,
    requiresSession: true,
    async run(c) {
      fireLoadCard(c, async () => {
        const models = await c.ctx.pi.models();
        return models.length === 0
          ? { markdown: '没有可用的 provider/model。' }
          : { card: modelPickerCard(models) };
      }, '模型选择器');
      return c.toast('success', '正在加载 provider/model，请稍候。');
    },
  },
  'model.select': {
    requiresBinding: true,
    requiresSession: true,
    async run(c) {
      const { ctx, event } = c;
      const provider = buttonString(c, 'provider');
      const modelId = buttonString(c, 'modelId');
      if (!provider || !modelId) return c.toast('warning', '不支持的卡片操作。');
      if (!(await c.sessionFileExists(c.sessionFile!))) return c.toast('warning', '该会话已不存在，请使用「切换会话」重新选择。');
      const selected = await ctx.pi.setModel(c.cwd, c.sessionFile!, provider, modelId);
      if (!(await c.resolveThread())) void updateAnnouncement(ctx, event.chatId);
      return c.toast('success', `已切换到 ${selected.provider}/${selected.name}。`);
    },
  },
  'thinkingLevel.form': {
    requiresBinding: true,
    requiresSession: true,
    async run(c) {
      fireLoadCard(c, async () => {
        const thinkingLevels = await c.ctx.pi.thinkingLevels(c.cwd, c.sessionFile!);
        return thinkingLevels.length === 0
          ? { markdown: '当前 model 不支持思考强度设置。' }
          : { card: thinkingLevelPickerCard(thinkingLevels) };
      }, '思考强度选择器');
      return c.toast('success', '正在加载思考强度，请稍候。');
    },
  },
  'thinkingLevel.select': {
    requiresBinding: true,
    requiresSession: true,
    async run(c) {
      const { ctx, event } = c;
      const thinkingLevel = buttonString(c, 'thinkingLevel');
      if (!thinkingLevel) return c.toast('warning', '不支持的卡片操作。');
      if (!(await c.sessionFileExists(c.sessionFile!))) return c.toast('warning', '该会话已不存在，请使用「切换会话」重新选择。');
      await ctx.pi.setThinkingLevel(c.cwd, c.sessionFile!, thinkingLevel as PiThinkingLevel);
      if (!(await c.resolveThread())) void updateAnnouncement(ctx, event.chatId);
      return c.toast('success', `已设置思考强度：${thinkingLevel}。`);
    },
  },
};

/**
 * 纯函数：cmd 是否已注册（注册表完备性由 Record 标注在编译期保证，此处提供运行期校验与独立测试入口）。
 * 返回规范化后的 CardCommand，未知 cmd 返回 undefined。
 */
export function resolveCardCommand(cmd: string): CardCommand | undefined {
  return Object.hasOwn(REGISTRY, cmd) ? (cmd as CardCommand) : undefined;
}

/** 卡片动作分发：event_id 去重 → cmd 解析 → 前置校验（话题 / 绑定 / 会话 / 守卫）→ 委托注册项处理器 */
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
  if (typeof cmd !== 'string' || !resolveCardCommand(cmd)) return toast('warning', '不支持的卡片操作。');
  const entry = REGISTRY[cmd as CardCommand];

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
  // 话题拦截：话题内群级操作直接拒绝（防旧卡 / 直连触发）
  if (entry.topicBlocked && (await resolveThread())) return toast('warning', '话题内不支持该操作，请回到群聊使用。');

  // 项目绑定前置：未绑定 → 提示绑定
  if (entry.requiresBinding && !ctx.state.get(event.chatId)) return toast('error', '该群尚未绑定项目。');

  // 活动会话前置：话题内懒初始化独立会话（先于任何会话操作完成绑定）；普通群 = 主会话 activeSessionFile
  let sessionFile: string | undefined;
  if (entry.requiresSession) {
    const binding = ctx.state.get(event.chatId);
    const tid = await resolveThread();
    sessionFile = tid ? await ensureThreadSession(ctx, event.chatId, tid, workspaceForChat(ctx, event.chatId)) : binding?.activeSessionFile;
    if (!sessionFile) return toast('warning', '请先使用「新建会话」或「切换会话」。');
  }

  const c: CommandContext = {
    ctx, event, taskKey: entry.taskKey, cwd: workspaceForChat(ctx, event.chatId), sessionFile,
    resolveThread, send, fireAndForget, toast, sessionFileExists, formValue,
  };
  return entry.run(c);
}
