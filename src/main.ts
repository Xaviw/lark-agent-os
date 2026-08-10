import 'dotenv/config';
import { mkdir, open, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { createLarkChannel } from '@larksuite/channel';
import { StateStore } from './state.js';
import { PiSessions } from './pi.js';
import { LarkApi } from './lark-api.js';
import { appId, appSecret, defaultWorkspace, stateRoot } from './config.js';
import type { BackgroundTask, CommandTask, PendingEntry } from './types.js';
import type { AppContext } from './app-context.js';
import { AgentRunManager } from './agent/run-manager.js';
import { SessionSyncWatcher } from './sync/watcher.js';
import { handleMessage } from './lark/messages.js';
import { handleCardAction } from './lark/card-actions.js';
import { updateAnnouncement } from './announcement.js';

// ── 启动引导：env → 单实例锁 → state / 容器 ────────────────────────────────
await mkdir(stateRoot, { recursive: true });
const instanceLock = await acquireInstanceLock(join(stateRoot, 'instance.lock'));
const state = new StateStore(stateRoot);
await state.load();
const pending = new Map<string, PendingEntry>();
const backgroundTasks = new Map<string, BackgroundTask>();
const commandTasks = new Map<string, CommandTask>();
const pi = new PiSessions(state, () => backgroundTasks.size);
const api = new LarkApi(appId, appSecret);

const channel = createLarkChannel({
  appId, appSecret, domain: 'https://open.feishu.cn', source: 'lark-agent-os',
  policy: { dmMode: 'open', requireMention: false, respondToMentionAll: false },
  safety: { chatQueue: { enabled: false } },
  includeRawEvent: true,
});

// ── 组装点：构造 ctx（agentRuns / sessionSyncWatcher 先占位回填），attach 打破循环依赖 ──
const ctx: AppContext = {
  state, pi, api, lark: channel, defaultWorkspace, pending, backgroundTasks, commandTasks,
  agentRuns: undefined!,
  sessionSyncWatcher: undefined!,
};
const agentRuns = new AgentRunManager(ctx);
ctx.agentRuns = agentRuns;
const sessionSyncWatcher = new SessionSyncWatcher(ctx);
ctx.sessionSyncWatcher = sessionSyncWatcher;
agentRuns.attach({ onRunFinished: (chatId) => sessionSyncWatcher.schedule(chatId) });
sessionSyncWatcher.attach({ isAgentActive: (chatId) => agentRuns.isActive(chatId) });
// 组装不变量：以下消费方（如 syncComputerSessions 的 ctx.agentRuns 访问）都依赖回填完成；
// 显式校验让「组装顺序被破坏」在启动期即报错，而不是运行期静默 undefined 崩溃
if (!ctx.agentRuns || !ctx.sessionSyncWatcher) throw new Error('AppContext 组装失败：agentRuns / sessionSyncWatcher 未回填');

// ── 事件接线 ──────────────────────────────────────────────────────────────
channel.on({
  message: (message) => void handleMessage(ctx, message).catch((error) => console.error('[message]', error)),
  cardAction: async (event) => {
    try {
      return await handleCardAction(ctx, event);
    } catch (error) {
      console.error('[cardAction]', error);
      return { toast: { type: 'error', content: '操作失败，请重新打开 session 选择器。' } };
    }
  },
});
await channel.connect();
console.log(`lark-agent-os connected as ${channel.botIdentity?.name ?? 'bot'}`);
await sessionSyncWatcher.reconcile();
for (const chatId of Object.keys(state.all())) void updateAnnouncement(ctx, chatId);

// ── 生命周期：信号 → 终止任务 → 关 watcher → 停止 agent → 收尾 ──────────────
let shutdownPromise: Promise<void> | undefined;

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
async function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    for (const task of commandTasks.values()) task.terminate();
    commandTasks.clear();
    for (const task of backgroundTasks.values()) task.terminate();
    backgroundTasks.clear();
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
