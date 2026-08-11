import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { AppContext } from '../app-context.js';
import { ensureAutoBaseline, markFeishuOrigin, syncComputerSessions } from './sync-service.js';

/**
 * 电脑端 → 飞书 单向会话同步监听（方向不对称）：
 * fs.watch + 60s 轮询兜底 + 750ms 防抖 + 双 stat 校验 + 指数退避 ≤3 次。
 * 交叉引用：Agent 忙碌判定通过 attach 注入（main.ts 中指向 AgentRunManager.isActive，避免模块循环依赖）。
 */
export class SessionSyncWatcher {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Set<string>();
  private readonly dirty = new Set<string>();
  private readonly retries = new Map<string, number>();
  private readonly fileStats = new Map<string, string>();
  private readonly pollTimer: NodeJS.Timeout;
  private isAgentActive: (chatId: string) => boolean = () => {
    throw new Error('SessionSyncWatcher 未 attach：缺少 isAgentActive 依赖（main.ts 组装点必须调用 attach）');
  };

  constructor(private readonly ctx: AppContext) {
    this.pollTimer = setInterval(() => void this.poll(), 60_000);
    this.pollTimer.unref();
  }

  /** 组装点注入：Agent 是否正在处理（main.ts 中指向 AgentRunManager.isActive）；未 attach 时首次调用即报错 */
  attach(deps: { isAgentActive: (chatId: string) => boolean }): void {
    this.isAgentActive = deps.isAgentActive;
  }

  async reconcile(): Promise<void> {
    const active = new Map<string, Set<string>>();
    for (const [chatId, binding] of Object.entries(this.ctx.state.all())) {
      if (!binding.activeSessionFile) continue;
      const directory = dirname(binding.activeSessionFile);
      const chats = active.get(directory) ?? new Set<string>();
      chats.add(chatId);
      active.set(directory, chats);
      const fileStat = await stat(binding.activeSessionFile).catch(() => undefined);
      if (fileStat) this.fileStats.set(binding.activeSessionFile, `${fileStat.size}:${fileStat.mtimeMs}`);
      const inFlight = binding.inFlightFeishuRun;
      if (inFlight?.sessionFile === binding.activeSessionFile) {
        await markFeishuOrigin(this.ctx, chatId, inFlight.sessionFile, new Set(inFlight.beforeEntryIds), inFlight.prompt);
        this.ctx.state.update(chatId, { inFlightFeishuRun: undefined });
        await this.ctx.state.flush();
      }
      await ensureAutoBaseline(this.ctx, chatId);
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
        for (const [chatId, binding] of Object.entries(this.ctx.state.all())) {
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
        if (this.isAgentActive(chatId) || this.ctx.state.get(chatId)?.inFlightFeishuRun) break;
        const result = await syncComputerSessions(this.ctx, chatId, 'auto');
        if (result.retry) this.retry(chatId);
        else this.retries.delete(chatId);
      }
    } catch (error) {
      console.warn(`[session sync] ${chatId}:`, error);
    } finally {
      this.running.delete(chatId);
      // 写入期间可能已有新的 dirty 标记；若定时器恰好在运行中触发，补排一次，避免丢事件。
      if (this.dirty.has(chatId) && !this.timers.has(chatId)) this.schedule(chatId);
    }
  }

  private async poll(): Promise<void> {
    for (const [chatId, binding] of Object.entries(this.ctx.state.all())) {
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
