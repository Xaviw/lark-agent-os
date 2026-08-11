import { randomUUID } from 'node:crypto';
import type { NormalizedMessage } from '@larksuite/channel';
import type { AppContext } from '../app-context.js';
import { AGENT_CARD_UPDATE_INTERVAL_MS } from '../config.js';
import type { AgentRun, PreparedPrompt, PromptImage } from '../types.js';

/** submit 的入参（避免可选参数膨胀） */
export interface SubmitRunOptions {
  cwd: string;
  sessionFile: string;
  /** 提交时的 prompt 骨架（引用附件段可能由 prepare 补齐） */
  prompt: string;
  id?: string;
  /** 后台附件准备（下载被引用资源 → 最终 prompt）；提交时立即启动，execute 前 await */
  prepare?: () => Promise<PreparedPrompt>;
}
import { agentFailureContent, elapsedSince } from '../utils/format.js';
import { createCardUpdater } from '../utils/card-update.js';
import { retryOnce } from '../utils/retry.js';
import { agentFinalCard, agentQueuedCard, agentRunningCard } from '../cards.js';
import { markFeishuOriginEntries } from '../sync/sync-service.js';

/**
 * 每群 Agent 串行队列 + 状态机（queued → running → succeeded / failed / cancelled，含 stopping 过渡）。
 * 交叉引用：run 结束后通过 attach 注入的 onRunFinished 回调通知 sessionSyncWatcher（避免模块循环依赖）。
 */
export class AgentRunManager {
  private readonly runs = new Map<string, AgentRun>();
  private readonly queues = new Map<string, AgentRun[]>();
  private readonly current = new Map<string, AgentRun>();
  private onRunFinished: ((chatId: string, sessionFile: string) => void) | undefined;

  constructor(private readonly ctx: AppContext) {}

  /** 组装点注入：AgentRun 结束（含失败/取消）后回调（main.ts 中指向 SessionSyncWatcher.schedule） */
  attach(deps: { onRunFinished: (chatId: string, sessionFile: string) => void }): void {
    this.onRunFinished = deps.onRunFinished;
  }

  isActive(chatId: string): boolean {
    return (this.queues.get(chatId)?.length ?? 0) > 0 || this.current.has(chatId);
  }

  isSessionActive(sessionFile: string): boolean {
    return [...this.runs.values()].some((run) => run.sessionFile === sessionFile
      && !['succeeded', 'failed', 'cancelled'].includes(run.state));
  }

  async submit(message: NormalizedMessage, opts: SubmitRunOptions): Promise<void> {
    const id = opts.id ?? randomUUID();
    const sent = await this.ctx.lark.send(message.chatId, { card: agentQueuedCard(id, opts.prompt) }, { replyTo: message.messageId });
    const run: AgentRun = {
      id, chatId: message.chatId, cwd: opts.cwd, sessionFile: opts.sessionFile, prompt: opts.prompt, messageId: sent.messageId, startedAt: Date.now(), state: 'queued',
      updater: createCardUpdater(this.ctx.lark, sent.messageId, 'agent status'), stopRequested: false, latestOutput: '',
      // 后台附件准备：提交时立即启动（与排队并行），execute 前 await；内部异常兑底为失败结果
      prepare: opts.prepare
        ? opts.prepare().catch((error) => ({ prompt: opts.prompt, error: `附件准备失败：${error instanceof Error ? error.message : String(error)}` }))
        : undefined,
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
    if (run.state === 'stopping') return true;
    run.stopRequested = true;
    if (run.state === 'queued') {
      run.state = 'cancelled';
      // 排队中取消：该 run 对应的 inFlightFeishuRun 不会经 execute.finally 清理，必须在此释放，
      // 否则残留的 inFlight 会永久阻塞该群自动/手动同步（watcher.run 与 syncComputerSessions 均检查它）
      if (this.clearInFlightIfOwned(run)) void this.ctx.state.flush().catch((error) => console.warn(`[feishu origin cleanup] ${run.chatId}:`, error));
      void this.finishWithStatus(run, 'Agent 已停止', '已在开始前取消。', 'agent stop status');
      return true;
    }
    run.state = 'stopping';
    void this.finishWithStatus(run, '正在停止 Agent', run.latestOutput || '正在停止处理。', 'agent stop status');
    // 过渡卡「正在停止 Agent」会在 abort 完成后的最终卡覆盖（createCardUpdater.finish 多次调用属预期契约）。
    // 仅当该 run 是当前持锁执行者时 abort 才生效（pi.abort 按 runId 匹配）；等待锁中的 run 由 prompt 的 isCancelled 放弃执行
    if (this.current.get(chatId)?.id === id) void this.ctx.pi.abort(run.sessionFile, run.id).catch((error) => console.error('[agent stop]', error));
    return true;
  }

  async shutdown(): Promise<void> {
    const updates: Promise<void>[] = [];
    for (const run of this.runs.values()) {
      run.stopRequested = true;
      if (run.state === 'queued') {
        run.state = 'cancelled';
        this.clearInFlightIfOwned(run);
        updates.push(this.finishWithStatus(run, 'Agent 已停止', '服务关闭，任务未开始。', 'agent shutdown'));
      } else if (run.state === 'running' || run.state === 'stopping') {
        run.state = 'stopping';
        void this.ctx.pi.abort(run.sessionFile, run.id).catch((error) => console.error('[agent shutdown]', error));
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
          this.current.delete(chatId);
          this.runs.delete(run.id);
          this.onRunFinished?.(chatId, run.sessionFile);
        }
      }
    } finally {
      if (!queue?.length) this.queues.delete(chatId);
    }
  }

  private async execute(run: AgentRun): Promise<void> {
    run.state = 'running';
    run.startedAt = Date.now();
    // 附件就绪（提交时已后台并行下载；失败 → 失败卡结束，本轮不进 agent）
    if (run.prepare) {
      const prepared = await run.prepare;
      if (prepared.error) {
        // stop 竞态对齐：prepare 失败与用户停止同时发生时按停止处理
        run.state = run.stopRequested ? 'cancelled' : 'failed';
        console.warn('[agent prepare]', prepared.error);
        await run.updater.finish(agentFinalCard(run.state === 'cancelled' ? 'Agent 已停止' : 'Agent 处理失败', prepared.error, undefined, elapsedSince(run.startedAt))).catch((error) => console.warn('[agent final status]', error));
        return;
      }
      run.prompt = prepared.prompt;
      run.images = prepared.images;
      run.prepare = undefined;
    }
    void run.updater.update(agentRunningCard(run.id, run.prompt)).catch((error) => console.warn('[agent start status]', error));
    let previewTimer: NodeJS.Timeout | undefined;
    let lastPreviewAt = 0;
    const updatePreview = (): void => {
      previewTimer = undefined;
      if (run.state !== 'running') return;
      lastPreviewAt = Date.now();
      void run.updater.update(agentRunningCard(run.id, run.prompt, run.latestOutput)).catch((error) => console.warn('[agent preview status]', error));
    };
    const isStopping = (): boolean => run.stopRequested;
    try {
      const result = await this.ctx.pi.prompt(run.cwd, run.sessionFile, run.prompt, (text) => {
        run.latestOutput = text;
        const delay = AGENT_CARD_UPDATE_INTERVAL_MS - (Date.now() - lastPreviewAt);
        if (delay <= 0) updatePreview();
        else if (!previewTimer) previewTimer = setTimeout(updatePreview, delay);
      }, {
        runId: run.id,
        isCancelled: () => run.stopRequested,
        images: run.images,
        onBeforeEntryIds: async (entryIds) => {
          run.originBefore = new Set(entryIds);
          this.ctx.state.update(run.chatId, {
            inFlightFeishuRun: {
              runId: run.id,
              sessionFile: run.sessionFile,
              beforeEntryIds: entryIds,
              prompt: run.prompt,
            },
          });
          await this.ctx.state.flush();
        },
        onEntryIds: (entryIds) => { run.originEntryIds = entryIds; },
      });
      if (previewTimer) clearTimeout(previewTimer);
      run.state = isStopping() ? 'cancelled' : 'succeeded';
      const card = run.state === 'cancelled'
        ? agentFinalCard('Agent 已停止', run.latestOutput || '已停止处理。', result.status, elapsedSince(run.startedAt))
        : agentFinalCard('Agent 处理完成', result.answer, result.status, elapsedSince(run.startedAt));
      await run.updater.finish(card).catch((error) => console.warn('[agent final status]', error));
    } catch (error) {
      run.state = isStopping() ? 'cancelled' : 'failed';
      const content = agentFailureContent(run.latestOutput, error, run.stopRequested);
      const status = await this.ctx.pi.status(run.cwd, run.sessionFile).catch(() => undefined);
      await run.updater.finish(agentFinalCard(run.stopRequested ? 'Agent 已停止' : 'Agent 处理失败', content, status, elapsedSince(run.startedAt))).catch((updateError) => console.warn('[agent final status]', updateError));
    } finally {
      if (previewTimer) clearTimeout(previewTimer);
      if (run.originBefore) {
        await this.markAndClearOrigin(run);
      }
    }
  }

  /**
   * 清理与指定 run 对应的 inFlightFeishuRun（防回环标记的同步暂停保护）。
   * 新状态按 runId 校验属主；旧状态无 runId 时兼容 beforeEntryIds 集合比对。返回是否清理。
   */
  private clearInFlightIfOwned(run: AgentRun): boolean {
    const originBefore = run.originBefore;
    if (!originBefore) return false;
    const inFlight = this.ctx.state.get(run.chatId)?.inFlightFeishuRun;
    if (!inFlight || inFlight.sessionFile !== run.sessionFile) return false;
    if (inFlight.runId && inFlight.runId !== run.id) return false;
    const before = inFlight.beforeEntryIds;
    if (before.length !== originBefore.size || before.some((id) => !originBefore.has(id))) return false;
    this.ctx.state.update(run.chatId, { inFlightFeishuRun: undefined });
    return true;
  }

  private async markAndClearOrigin(run: AgentRun): Promise<void> {
    try {
      await retryOnce(
        () => markFeishuOriginEntries(this.ctx, run.sessionFile, run.originEntryIds ?? []),
        () => true,
        500,
        (error) => console.debug(`[feishu origin retry] ${run.chatId}:`, error),
      );
      // 属主判断后再清理：多个排队 run 时 inFlightFeishuRun 只记录最后一次 runPrompt 的 run，
      // 较早 run 完成不得误清较晚 run 的 inFlight（否则其执行期间同步暂停保护会提前失效）
      if (this.clearInFlightIfOwned(run)) await this.ctx.state.flush();
    } catch (error) {
      // 标记失败时保留 inFlight，避免本轮被当作电脑端轮次同步；延迟再尝试一次，仍失败则留待启动 reconcile。
      console.warn(`[feishu origin] ${run.chatId}:`, error);
      setTimeout(() => void this.retryOriginCleanup(run), 1_000).unref();
    }
  }

  private async retryOriginCleanup(run: AgentRun): Promise<void> {
    try {
      await markFeishuOriginEntries(this.ctx, run.sessionFile, run.originEntryIds ?? []);
      if (this.clearInFlightIfOwned(run)) await this.ctx.state.flush();
      this.onRunFinished?.(run.chatId, run.sessionFile);
    } catch (error) {
      console.warn(`[feishu origin retry] ${run.chatId}:`, error);
    }
  }

  private async finishWithStatus(run: AgentRun, title: string, content: string, label: string): Promise<void> {
    const status = await this.ctx.pi.status(run.cwd, run.sessionFile).catch(() => undefined);
    const elapsed = this.current.get(run.chatId)?.id === run.id ? elapsedSince(run.startedAt) : undefined;
    await run.updater.finish(agentFinalCard(title, content, status, elapsed)).catch((error) => console.warn(`[${label}]`, error));
  }
}
