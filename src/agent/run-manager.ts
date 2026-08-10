import { randomUUID } from 'node:crypto';
import type { NormalizedMessage } from '@larksuite/channel';
import type { AppContext } from '../app-context.js';
import { AGENT_CARD_UPDATE_INTERVAL_MS } from '../config.js';
import type { AgentRun } from '../types.js';
import { agentFailureContent, elapsedSince } from '../utils/format.js';
import { createCardUpdater } from '../utils/card-update.js';
import { agentFinalCard, agentQueuedCard, agentRunningCard } from '../cards.js';
import { markFeishuOrigin } from '../sync/sync-service.js';
import { updateAnnouncement } from '../announcement.js';

/**
 * 每群 Agent 串行队列 + 状态机（queued → running → succeeded / failed / cancelled，含 stopping 过渡）。
 * 交叉引用：run 结束后通过 attach 注入的 onRunFinished 回调通知 sessionSyncWatcher（避免模块循环依赖）。
 */
export class AgentRunManager {
  private readonly runs = new Map<string, AgentRun>();
  private readonly queues = new Map<string, AgentRun[]>();
  private readonly current = new Map<string, AgentRun>();
  private onRunFinished: ((chatId: string) => void) | undefined;

  constructor(private readonly ctx: AppContext) {}

  /** 组装点注入：AgentRun 结束（含失败/取消）后回调（main.ts 中指向 SessionSyncWatcher.schedule） */
  attach(deps: { onRunFinished: (chatId: string) => void }): void {
    this.onRunFinished = deps.onRunFinished;
  }

  isActive(chatId: string): boolean {
    return (this.queues.get(chatId)?.length ?? 0) > 0 || this.current.has(chatId);
  }

  async submit(message: NormalizedMessage, cwd: string, sessionFile: string, prompt: string, originBefore?: Set<string>, originPrompt?: string): Promise<void> {
    const id = randomUUID();
    const sent = await this.ctx.lark.send(message.chatId, { card: agentQueuedCard(id, prompt) }, { replyTo: message.messageId });
    const run: AgentRun = {
      id, chatId: message.chatId, cwd, sessionFile, prompt, messageId: sent.messageId, startedAt: Date.now(), state: 'queued',
      updater: createCardUpdater(this.ctx.lark, sent.messageId, 'agent status'), stopStatus: () => undefined, originBefore, originPrompt, stopRequested: false, latestOutput: '',
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
    void this.finishWithStatus(run, '正在停止 Agent', run.latestOutput || '正在停止处理。', 'agent stop status');
    if (this.current.get(chatId)?.id === id) void this.ctx.pi.abort(chatId).catch((error) => console.error('[agent stop]', error));
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
        void this.ctx.pi.abort(run.chatId).catch((error) => console.error('[agent shutdown]', error));
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
          this.onRunFinished?.(chatId);
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
    let previewTimer: NodeJS.Timeout | undefined;
    let lastPreviewAt = 0;
    const updatePreview = (): void => {
      previewTimer = undefined;
      if (run.state !== 'running') return;
      lastPreviewAt = Date.now();
      void run.updater.update(agentRunningCard(run.id, run.prompt, run.latestOutput)).catch((error) => console.warn('[agent preview status]', error));
    };
    run.stopStatus = () => undefined;
    const isStopping = (): boolean => run.stopRequested;
    try {
      const result = await this.ctx.pi.prompt(run.chatId, run.cwd, run.sessionFile, run.prompt, (text) => {
        run.latestOutput = text;
        const delay = AGENT_CARD_UPDATE_INTERVAL_MS - (Date.now() - lastPreviewAt);
        if (delay <= 0) updatePreview();
        else if (!previewTimer) previewTimer = setTimeout(updatePreview, delay);
      });
      if (previewTimer) clearTimeout(previewTimer);
      run.state = isStopping() ? 'cancelled' : 'succeeded';
      const card = run.state === 'cancelled'
        ? agentFinalCard('Agent 已停止', run.latestOutput || '已停止处理。', result.status, elapsedSince(run.startedAt))
        : agentFinalCard('Agent 处理完成', result.answer, result.status, elapsedSince(run.startedAt));
      await run.updater.finish(card).catch((error) => console.warn('[agent final status]', error));
      void updateAnnouncement(this.ctx, run.chatId);
    } catch (error) {
      run.state = isStopping() ? 'cancelled' : 'failed';
      const content = agentFailureContent(run.latestOutput, error, run.stopRequested);
      const status = await this.ctx.pi.status(run.chatId, run.cwd, run.sessionFile).catch(() => undefined);
      await run.updater.finish(agentFinalCard(run.stopRequested ? 'Agent 已停止' : 'Agent 处理失败', content, status, elapsedSince(run.startedAt))).catch((updateError) => console.warn('[agent final status]', updateError));
    } finally {
      if (previewTimer) clearTimeout(previewTimer);
      if (run.originBefore) {
        try {
          await markFeishuOrigin(this.ctx, run.chatId, run.sessionFile, run.originBefore, run.originPrompt);
          this.ctx.state.update(run.chatId, { inFlightFeishuRun: undefined });
          await this.ctx.state.flush();
        } catch (error) {
          console.warn(`[feishu origin] ${run.chatId}:`, error);
        }
      }
      run.stopStatus();
    }
  }

  private async finishWithStatus(run: AgentRun, title: string, content: string, label: string): Promise<void> {
    const status = await this.ctx.pi.status(run.chatId, run.cwd, run.sessionFile).catch(() => undefined);
    const elapsed = this.current.get(run.chatId)?.id === run.id ? elapsedSince(run.startedAt) : undefined;
    await run.updater.finish(agentFinalCard(title, content, status, elapsed)).catch((error) => console.warn(`[${label}]`, error));
  }
}
