import type { ChildProcess } from 'node:child_process';
import type { NormalizedMessage } from '@larksuite/channel';

export interface SessionSyncState {
  sessionFile: string;
  autoBaselineEntryId?: string;
  lastSyncedEntryId?: string;
  lastLarkMessageId?: string;
}

export interface ChatBinding {
  cwd: string;
  chatType?: 'group' | 'p2p';
  activeSessionFile?: string;
  /** 飞书来源 entry id（防回环）。即时标记：飞书 run 结束时记录本轮 ids，同步消费（进度推进）后立即清理，仅极端情况保留最近 1000 条 */
  feishuOriginEntryIds?: string[];
  sessionSync?: SessionSyncState;
  inFlightFeishuRun?: { runId?: string; sessionFile: string; beforeEntryIds: string[]; prompt: string };
  updatedAt: string;
}

export type State = Record<string, ChatBinding>;

/** 由 lark-agent-os 启动的常驻（后台）服务进程 */
export type BackgroundTask = {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  child: ChildProcess;
  terminate: () => void;
};

export type CommandTask = {
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

export type CardUpdater = {
  update: (card: object) => Promise<void>;
  finish: (card: object) => Promise<void>;
};

export type AgentRun = {
  id: string;
  chatId: string;
  cwd: string;
  sessionFile: string;
  prompt: string;
  messageId: string;
  startedAt: number;
  state: 'queued' | 'running' | 'stopping' | 'succeeded' | 'failed' | 'cancelled';
  updater: CardUpdater;
  originBefore?: Set<string>;
  /** 本次 prompt 在 session 锁内实际创建的 message entry ids */
  originEntryIds?: string[];
  stopRequested: boolean;
  latestOutput: string;
};

/** 卡片操作等待中的表单上下文（nonce 防过期） */
export type PendingEntry = {
  nonce: string;
  prompt?: { message: NormalizedMessage; text: string };
};

export type SessionMessageEntry = {
  type?: string;
  id: string;
  timestamp: unknown;
  message?: { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
};

/** 同步消息的一行：text 为行内容（可含 \n 软换行），bold 为加粗标题行（[User]/[Agent] 时间戳） */
export type SyncRow = {
  text: string;
  bold?: boolean;
};

export type ComputerTurn = {
  user: SessionMessageEntry & { message: NonNullable<SessionMessageEntry['message']> };
  final: SessionMessageEntry & { message: NonNullable<SessionMessageEntry['message']> };
  assistantMessages: Array<SessionMessageEntry & { message: NonNullable<SessionMessageEntry['message']> }>;
  entries: Array<SessionMessageEntry & { message: NonNullable<SessionMessageEntry['message']> }>;
};
