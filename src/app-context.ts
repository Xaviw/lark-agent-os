import type { LarkChannel } from '@larksuite/channel';
import type { AgentRunManager } from './agent/run-manager.js';
import type { LarkApi } from './lark-api.js';
import type { PiSessions } from './pi.js';
import type { StateStore } from './state.js';
import type { SessionSyncWatcher } from './sync/watcher.js';
import type { BackgroundTask, CommandTask, PendingEntry } from './types.js';

/**
 * 全局共享依赖（由 main.ts 唯一组装点装配）。
 * 组装顺序：先构造 ctx 骨架（agentRuns / sessionSyncWatcher 暂以 undefined 占位），
 * 依次创建 AgentRunManager、SessionSyncWatcher 并回填，最后 attach 交叉引用（避免循环依赖）。
 */
export interface AppContext {
  state: StateStore;
  pi: PiSessions;
  api: LarkApi;
  lark: LarkChannel;
  defaultWorkspace: string;
  /** 挂起的消息上下文（session 选择/新建后自动续跑；消费即删） */
  pending: Map<string, PendingEntry>;
  /** 常驻（后台）任务 */
  backgroundTasks: Map<string, BackgroundTask>;
  /** 前台命令任务 */
  commandTasks: Map<string, CommandTask>;
  agentRuns: AgentRunManager;
  sessionSyncWatcher: SessionSyncWatcher;
}
