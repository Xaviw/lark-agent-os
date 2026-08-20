import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type SessionInfo,
} from '@earendil-works/pi-coding-agent';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PI_SESSION_CACHE_LIMIT } from './config.js';
import { buildSendImageTool, type SendImageExecutor } from './agent/send-image.js';
import type { PromptImage } from './types.js';
import { formatTokens } from './utils/format.js';

export type PiPromptResult = {
  answer: string;
  status?: string;
};

/** 压缩会话的结果：压缩前后 context 对比 + 压缩后状态栏 */
export type PiCompactResult = {
  /** 压缩前 context tokens（usage 口径，含固定开销） */
  tokensBefore?: number;
  /** 压缩后估算 context tokens（SDK 可能不提供；压缩后需新对话才有精确 usage） */
  estimatedTokensAfter?: number;
  /** 压缩后的状态栏（含上下文占用；压缩后无新对话时 percent 显示 ?） */
  status?: string;
};

export type PiModelOption = {
  provider: string;
  id: string;
  name: string;
};

export type PiThinkingLevel = Parameters<AgentSession['setThinkingLevel']>[0];

type PiPromptOptions = {
  runId?: string;
  isCancelled?: () => boolean;
  /** 随 prompt 注入的图片（base64），转 pi-ai ImageContent 传给模型 */
  images?: PromptImage[];
  onBeforeEntryIds?: (entryIds: string[]) => Promise<void>;
  onEntryIds?: (entryIds: string[]) => void;
  /** 本次 prompt 所属飞书 run 的 chatId（send_image 工具反查发送目标用；per-session 串行下唯一） */
  chatId?: string;
  /** 本次 prompt 所属飞书 run 的状态卡 messageId（send_image 工具 replyTo 用） */
  messageId?: string;
};

function latestAssistantError(session: AgentSession, beforeMessageIds: ReadonlySet<string>): string | undefined {
  const entry = [...session.sessionManager.getEntries()]
    .reverse()
    .find((item) => item.type === 'message' && item.message.role === 'assistant' && !beforeMessageIds.has(item.id));
  if (!entry || entry.type !== 'message' || entry.message.role !== 'assistant') return undefined;
  if (entry.message.stopReason !== 'error' && entry.message.stopReason !== 'aborted') return undefined;
  return entry.message.errorMessage?.trim() || `pi 以 ${entry.message.stopReason} 结束。`;
}

const piStatusEnabled = process.env.LARK_PI_STATUS_ENABLED?.trim().toLowerCase() !== 'false';

export class PiSessions {
  /**
   * session 实例按 sessionFile 全局单例：多个群绑定同一 session 文件时共享同一实例，避免整文件重写互相覆盖。
   * 空闲实例使用有界 LRU 缓存；正在使用的实例不会回收。
   */
  private readonly sessions = new Map<string, AgentSession>();
  /** 独占操作（prompt/compact/rename/setModel/setThinkingLevel）按 sessionFile 串行化的锁链：多群共享同一 session 时串行执行 */
  private readonly sessionLocks = new Map<string, Promise<unknown>>();
  /** 已提交但尚未完成的独占操作数；归零后释放对应锁链 */
  private readonly operationCounts = new Map<string, number>();
  /** 正在使用 session 实例的调用数；非零实例不得从 LRU 回收 */
  private readonly sessionUsers = new Map<string, number>();
  /** getOrOpen 的 in-flight 去重：并发调用共享同一创建过程，避免 createAgentSession 竞态产生重复实例 */
  private readonly opening = new Map<string, Promise<AgentSession>>();
  /** 每个 sessionFile 当前持锁执行的 prompt 的 runId（不同 session 的 prompt 并行，须按 sessionFile 区分）；abort 据此判断被停止的 run 是否真的是执行者 */
  private readonly runningPrompt = new Map<string, string | undefined>();
  /** 每个 sessionFile 当前活跃 run 的发送目标（chatId + 状态卡 messageId）：prompt 进入时写入、finally 清理；
   *  send_image 工具据此反查「发到哪个飞书对话」。per-session 串行锁保证同一时刻每 sessionFile 至多一个活跃 run */
  private readonly activeRunBySessionFile = new Map<string, { chatId: string; messageId: string }>();
  /** send_image 工具执行器（组装点注入，持有 LarkChannel）；未注入时工具不可用 */
  private sendImage?: SendImageExecutor;
  /** dispose 后拒绝新打开并释放迟到的创建结果 */
  private disposed = false;
  private readonly modelRuntimePromise = ModelRuntime.create();
  private readonly backgroundTaskCountProvider: () => number;

  constructor(backgroundTaskCountProvider?: () => number) {
    this.backgroundTaskCountProvider = backgroundTaskCountProvider ?? (() => 0);
  }

  /** 组装点注入 send_image 执行器（channel 创建完成后调用；未注入则 Agent 侧无此工具） */
  setSendImage(executor: SendImageExecutor): void {
    this.sendImage = executor;
  }

  /** send_image 工具反查：当前活跃 run 的发送目标（无活跃 run 返回 undefined） */
  activeRunForSession(sessionFile: string): { chatId: string; messageId: string } | undefined {
    return this.activeRunBySessionFile.get(sessionFile);
  }

  async list(cwd: string): Promise<SessionInfo[]> {
    return SessionManager.list(cwd);
  }

  /** 按 sessionFile 串行化独占操作：多群共享同一 session 文件时，prompt/compact 等写操作排队执行（pi SDK 对并发 prompt 会抛「Agent is already processing」） */
  private async withSessionLock<T>(sessionFile: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.sessionLocks.get(sessionFile) ?? Promise.resolve();
    this.operationCounts.set(sessionFile, (this.operationCounts.get(sessionFile) ?? 0) + 1);
    const next = previous.then(fn, fn).finally(() => this.releaseOperation(sessionFile)); // 前一个失败也继续执行本次
    this.sessionLocks.set(sessionFile, next.catch(() => undefined));
    return next;
  }

  private releaseOperation(sessionFile: string): void {
    const remaining = (this.operationCounts.get(sessionFile) ?? 1) - 1;
    if (remaining > 0) {
      this.operationCounts.set(sessionFile, remaining);
      return;
    }
    this.operationCounts.delete(sessionFile);
    this.sessionLocks.delete(sessionFile);
    this.pruneSessions();
  }

  private async usingSession<T>(cwd: string, sessionFile: string, fn: (session: AgentSession) => Promise<T> | T): Promise<T> {
    this.sessionUsers.set(sessionFile, (this.sessionUsers.get(sessionFile) ?? 0) + 1);
    try {
      return await fn(await this.getOrOpen(cwd, sessionFile));
    } finally {
      const remaining = (this.sessionUsers.get(sessionFile) ?? 1) - 1;
      if (remaining > 0) this.sessionUsers.set(sessionFile, remaining);
      else this.sessionUsers.delete(sessionFile);
      this.pruneSessions();
    }
  }

  /**
   * @param opts.runId 调用方（AgentRunManager）的 run 标识，abort 据此区分「正在执行的 run」与「仍在锁队列中等待的 run」
   * @param opts.isCancelled 锁内检查的取消回调：等待锁期间（如多群共享 session 时前一个 run 尚未结束）用户已停止时，
   *                        拿到锁后直接放弃执行，避免「停止无效 → run 仍完整执行」。检查点与 session.prompt 调用之间
   *                        无 await（同步段），stop 只能落在检查之前（被捕获）或 prompt 运行之后（由 abort 接管）。
   */
  async prompt(
    cwd: string,
    sessionFile: string,
    text: string,
    onDelta?: (text: string) => void,
    opts?: PiPromptOptions,
  ): Promise<PiPromptResult> {
    return this.withSessionLock(sessionFile, () => this.usingSession(cwd, sessionFile, async (session) => {
      this.runningPrompt.set(sessionFile, opts?.runId);
      if (opts?.chatId && opts.messageId) {
        this.activeRunBySessionFile.set(sessionFile, { chatId: opts.chatId, messageId: opts.messageId });
      }
      let answer = '';
      let separateNextAssistantMessage = false;
      const unsubscribe = session.subscribe((event) => {
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
          if (separateNextAssistantMessage && answer) answer += '\n\n';
          separateNextAssistantMessage = false;
          answer += event.assistantMessageEvent.delta;
          onDelta?.(answer);
        } else if (event.type === 'message_end' && event.message.role === 'assistant' && answer) {
          separateNextAssistantMessage = true;
        }
      });
      let beforeMessageIds: Set<string> | undefined;
      try {
        beforeMessageIds = new Set(
          session.sessionManager.getEntries()
            .filter((entry) => entry.type === 'message')
            .map((entry) => entry.id),
        );
        if (opts?.isCancelled?.()) return { answer: '', status: undefined };
        // 持锁保存精确快照后再执行 prompt，供进程异常退出后的 reconcile 使用。
        await opts?.onBeforeEntryIds?.([...beforeMessageIds]);
        // flush 期间可能收到 stop；第二次检查与下方 prompt 调用处于同一同步段。
        if (opts?.isCancelled?.()) return { answer: '', status: undefined };
        const images = opts?.images?.map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType }));
        await session.prompt(text, images && images.length > 0 ? { images } : undefined);
        const error = latestAssistantError(session, beforeMessageIds);
        if (error) throw new Error(error);
        return {
          answer: answer.trim() || '（Agent 没有返回文本）',
          status: this.statusFor(session, this.backgroundTaskCountProvider()),
        };
      } finally {
        if (beforeMessageIds) {
          const entryIds = session.sessionManager.getEntries()
            .filter((entry) => entry.type === 'message' && !beforeMessageIds!.has(entry.id))
            .map((entry) => entry.id);
          opts?.onEntryIds?.(entryIds);
        }
        this.runningPrompt.delete(sessionFile);
        this.activeRunBySessionFile.delete(sessionFile);
        unsubscribe();
      }
    }));
  }

  /**
   * 中止指定 run 的 prompt（仅当它是该 sessionFile 当前持锁执行者）。
   * - 该 session 无执行中的 prompt（run 尚在锁队列等待）→ 忽略：等待中的 run 会在拿到锁后经 prompt 的 isCancelled 回调自行放弃；
   * - 执行者是别的 run（多群共享 session，前一个 run 仍在执行）→ 忽略：不得中断他人的执行。
   */
  async abort(sessionFile: string, runId?: string): Promise<void> {
    if (!this.runningPrompt.has(sessionFile)) return;
    const ownerRunId = this.runningPrompt.get(sessionFile);
    if (runId !== undefined && ownerRunId !== runId) return;
    await this.sessions.get(sessionFile)?.abort();
  }

  /** 当前会话模型是否支持图片输入（视觉）。查询失败按不支持处理（调用方降级为路径注入）。 */
  async supportsImages(cwd: string, sessionFile: string): Promise<boolean> {
    try {
      return await this.usingSession(cwd, sessionFile, (session) => session.model?.input.includes('image') ?? false);
    } catch {
      return false;
    }
  }

  async models(): Promise<PiModelOption[]> {
    const runtime = await this.modelRuntimePromise;
    return (await runtime.getAvailable()).map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name ?? model.id,
    }));
  }

  async setModel(cwd: string, sessionFile: string, provider: string, modelId: string): Promise<PiModelOption> {
    return this.withSessionLock(sessionFile, () => this.usingSession(cwd, sessionFile, async (session) => {
      const runtime = await this.modelRuntimePromise;
      const model = (await runtime.getAvailable()).find((item) => item.provider === provider && item.id === modelId);
      if (!model) throw new Error('该 model 当前不可用。');
      await session.setModel(model);
      return { provider: model.provider, id: model.id, name: model.name ?? model.id };
    }));
  }

  /** 当前生效模型：读 session JSONL 最后一条 model_change entry（无则 undefined） */
  async modelOf(cwd: string, sessionFile: string): Promise<PiModelOption | undefined> {
    return this.withSessionLock(sessionFile, () => this.usingSession(cwd, sessionFile, (session) => {
      const entries = session.sessionManager.getEntries();
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i] as { type?: string; provider?: string; modelId?: string };
        if (entry.type === 'model_change' && typeof entry.provider === 'string' && typeof entry.modelId === 'string') {
          return { provider: entry.provider, id: entry.modelId, name: entry.modelId };
        }
      }
      return undefined;
    }));
  }

  async thinkingLevels(cwd: string, sessionFile: string): Promise<PiThinkingLevel[]> {
    return this.usingSession(cwd, sessionFile, (session) => session.getAvailableThinkingLevels());
  }

  async setThinkingLevel(cwd: string, sessionFile: string, thinkingLevel: PiThinkingLevel): Promise<void> {
    return this.withSessionLock(sessionFile, () => this.usingSession(cwd, sessionFile, (session) => {
      if (!session.getAvailableThinkingLevels().includes(thinkingLevel)) throw new Error('当前 model 不支持该思考强度。');
      session.setThinkingLevel(thinkingLevel);
    }));
  }

  async rename(cwd: string, sessionFile: string, name: string): Promise<void> {
    return this.withSessionLock(sessionFile, () => this.usingSession(cwd, sessionFile, (session) => {
      session.sessionManager.appendSessionInfo(name);
    }));
  }

  async compact(cwd: string, sessionFile: string): Promise<PiCompactResult> {
    return this.withSessionLock(sessionFile, () => this.usingSession(cwd, sessionFile, async (session) => {
      const result = await session.compact();
      return {
        tokensBefore: result.tokensBefore,
        estimatedTokensAfter: result.estimatedTokensAfter,
        status: this.statusFor(session, this.backgroundTaskCountProvider()),
      };
    }));
  }

  /** 重新加载 keybindings / 扩展 / skills / prompts / themes / context 文件（对应 pi 的 /reload 命令）。
   *  SDK 的 session.reload() 会重读 settings、重置 API providers、重载资源并重建扩展 runtime，但内部仅在存在
   *  uiContext / shutdownHandler / onError 等 bindings 时才自动重发 session_start；本项目只 bindExtensions({ mode: 'print' })，
   *  这些字段未设置 → reload 后扩展 runtime 不会自动重启，MCP 等扩展依赖 session_start 初始化，故须在此显式重新绑定。
   *  返回 reload 后的状态栏（含上下文占用）。 */
  async reload(cwd: string, sessionFile: string): Promise<string | undefined> {
    return this.withSessionLock(sessionFile, () => this.usingSession(cwd, sessionFile, async (session) => {
      await session.reload();
      await this.bindSessionExtensions(session);
      return this.statusFor(session, this.backgroundTaskCountProvider());
    }));
  }

  async status(cwd: string, sessionFile: string): Promise<string | undefined> {
    if (!piStatusEnabled) return undefined;
    return this.usingSession(cwd, sessionFile, (session) => this.statusFor(session, this.backgroundTaskCountProvider()));
  }

  async statusAt(cwd: string, sessionFile: string, entryId: string): Promise<string | undefined> {
    if (!piStatusEnabled) return undefined;
    const source = SessionManager.open(sessionFile, undefined, cwd);
    const branch = source.getBranch();
    const target = branch.findIndex((entry) => entry.id === entryId);
    if (target === -1) return undefined;
    const directory = await mkdtemp(join(tmpdir(), 'lark-agent-os-status-'));
    const snapshot = join(directory, 'session.jsonl');
    const entries = [source.getHeader(), ...branch.slice(0, target + 1)];
    await writeFile(snapshot, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, { mode: 0o600 });
    const { session } = await createAgentSession({
      cwd,
      modelRuntime: await this.modelRuntimePromise,
      sessionManager: SessionManager.open(snapshot, undefined, cwd),
    });
    try {
      return this.statusFor(session);
    } finally {
      await this.disposeSession(session);
      await rm(directory, { recursive: true, force: true });
    }
  }

  private statusFor(session: AgentSession, backgroundCount = 0): string | undefined {
    if (!piStatusEnabled) return undefined;
    const stats = session.getSessionStats();
    const latestAssistant = [...session.sessionManager.getEntries()]
      .reverse()
      .find((entry) => entry.type === 'message' && entry.message.role === 'assistant');
    const usage = latestAssistant?.type === 'message' && latestAssistant.message.role === 'assistant'
      ? latestAssistant.message.usage
      : undefined;
    const promptTokens = usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0;
    const parts: string[] = [];
    if (stats.tokens.input) parts.push(`↑${formatTokens(stats.tokens.input)}`);
    if (stats.tokens.output) parts.push(`↓${formatTokens(stats.tokens.output)}`);
    if (stats.tokens.cacheRead) parts.push(`R${formatTokens(stats.tokens.cacheRead)}`);
    if (stats.tokens.cacheWrite) parts.push(`W${formatTokens(stats.tokens.cacheWrite)}`);
    if (promptTokens > 0 && (stats.tokens.cacheRead > 0 || stats.tokens.cacheWrite > 0)) {
      parts.push(`CH${((usage!.cacheRead / promptTokens) * 100).toFixed(1)}%`);
    }
    if (stats.cost) parts.push(`$${stats.cost.toFixed(3)}`);
    const context = stats.contextUsage;
    const contextWindow = context?.contextWindow ?? 0;
    const percent = context?.percent === null ? '?' : (context?.percent ?? 0).toFixed(1);
    parts.push(`${percent}%/${formatTokens(contextWindow)}${session.autoCompactionEnabled ? ' (auto)' : ''}`);
    if (backgroundCount > 0) parts.push(`后台任务 ×${backgroundCount}`);
    return parts.join(' ');
  }

  async create(cwd: string, name: string): Promise<string> {
    const manager = SessionManager.create(cwd);
    const file = manager.getSessionFile();
    if (!file) throw new Error(`pi did not create a session for ${cwd}`);
    manager.appendSessionInfo(name);
    await this.initialize(cwd, manager);
    return file;
  }

  async ensure(cwd: string, sessionFile: string): Promise<void> {
    try {
      await access(sessionFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.initialize(cwd, SessionManager.open(sessionFile, undefined, cwd));
    }
  }

  private async initialize(cwd: string, sessionManager: SessionManager): Promise<void> {
    const { session } = await createAgentSession({
      cwd,
      modelRuntime: await this.modelRuntimePromise,
      sessionManager,
    });
    try {
      await this.persistInitialSession(sessionManager);
    } finally {
      await this.disposeSession(session);
    }
  }

  private async persistInitialSession(sessionManager: SessionManager): Promise<void> {
    const file = sessionManager.getSessionFile();
    if (!file) throw new Error('pi did not provide a session file');
    try {
      await access(file);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(dirname(file), { recursive: true });
    const entries = [sessionManager.getHeader(), ...sessionManager.getEntries()];
    try {
      await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }

  /** session 打开去重：同步检查 + 同步注册 in-flight promise（在首个 await 之前），保证并发调用共享同一创建过程 */
  private getOrOpen(cwd: string, sessionFile: string): Promise<AgentSession> {
    if (this.disposed) return Promise.reject(new Error('PiSessions 已关闭'));
    const existing = this.sessions.get(sessionFile);
    if (existing) {
      this.sessions.delete(sessionFile);
      this.sessions.set(sessionFile, existing);
      return Promise.resolve(existing);
    }
    const pending = this.opening.get(sessionFile);
    if (pending) return pending;
    const created = (async () => {
      // send_image 工具：仅注入已装配执行器的实例；闭包捕获 sessionFile / cwd，反查活跃 run 决定发送目标；
      // sendImage 惰性取值（而非创建时快照）：组装点注入顺序变化时仍能拿到执行器
      const customTools = this.sendImage
        ? [buildSendImageTool({
            resolveActiveRun: () => this.activeRunForSession(sessionFile),
            sendImage: () => this.sendImage,
            cwd,
          })]
        : undefined;
      const { session } = await createAgentSession({
        cwd,
        modelRuntime: await this.modelRuntimePromise,
        sessionManager: SessionManager.open(sessionFile, undefined, cwd),
        ...(customTools ? { customTools } : {}),
      });
      await this.bindSessionExtensions(session);
      return session;
    })().then((session) => {
      this.opening.delete(sessionFile);
      if (this.disposed) {
        // 关闭后完成的创建：立即释放，不入缓存，并对调用方报错（shutdown 竞态下不允许继续使用已关闭实例）
        void this.disposeSession(session).catch((error) => console.error('[pi] 会话释放失败:', error));
        throw new Error('PiSessions 已关闭');
      }
      this.sessions.set(sessionFile, session);
      return session;
    }).catch((error) => {
      this.opening.delete(sessionFile);
      throw error;
    });
    this.opening.set(sessionFile, created);
    return created;
  }

  /**
   * 会话打开后绑定扩展：SDK 的 createAgentSession 不会自动向扩展发 session_start 事件，
   * 而 pi-mcp-adapter 等扩展在 session_start 时才初始化（MCP server 懒连接），不绑定会导致
   * mcp 工具调用返回 "MCP not initialized"。绑定失败仅记日志，不影响内置工具与会话。
   */
  private async bindSessionExtensions(session: AgentSession): Promise<void> {
    try {
      await session.bindExtensions({ mode: 'print' });
    } catch (error) {
      console.error('[pi] 扩展 session_start 处理失败（mcp 等扩展工具可能不可用）:', error);
    }
  }

  /** 向扩展发 session_shutdown，让 pi-mcp-adapter 停止 MCP runtime 避免 server 进程泄漏；emit 不会 reject（SDK 内部吞掉 handler 异常） */
  private shutdownSessionExtensions(session: AgentSession): Promise<void> {
    try {
      return session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    } catch (error) {
      console.error('[pi] 扩展 session_shutdown 处理失败:', error);
      return Promise.resolve();
    }
  }

  /**
   * 统一释放路径：先发 session_shutdown 再 dispose。所有释放点（临时会话 / LRU 淘汰 / shutdown / 竞态分支）
   * 都走这里；未 bind 的临时会话也安全（适配器对 null state 是 no-op，且能停掉 eager server 的加载时初始化）。
   */
  private async disposeSession(session: AgentSession): Promise<void> {
    await this.shutdownSessionExtensions(session);
    session.dispose();
  }

  private pruneSessions(): void {
    if (this.sessions.size <= PI_SESSION_CACHE_LIMIT) return;
    for (const [sessionFile, session] of this.sessions) {
      if (this.sessions.size <= PI_SESSION_CACHE_LIMIT) break;
      if (this.sessionUsers.has(sessionFile) || this.opening.has(sessionFile)) continue;
      // dispose 先于 shutdown handler 的微任务执行，但当前扩展的 session_shutdown handler 均不访问 ctx
      // （其 getter 在 invalidate 后会 assertActive 抛错），清理不受影响；disposeSession 仍可能因 dispose 抛错，故保留 catch
      void this.disposeSession(session).catch((error) => console.error('[pi] 会话释放失败:', error));
      this.sessions.delete(sessionFile);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([...this.sessions.values()].map((session) => this.disposeSession(session)));
    this.sessions.clear();
    this.sessionLocks.clear();
    this.operationCounts.clear();
    this.sessionUsers.clear();
    this.opening.clear();
    this.runningPrompt.clear();
  }
}
