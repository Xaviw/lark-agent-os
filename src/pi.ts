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
import type { StateStore } from './state.js';

export type PiPromptResult = {
  answer: string;
  status?: string;
};

export type PiModelOption = {
  provider: string;
  id: string;
  name: string;
};

export type PiEffort = Parameters<AgentSession['setThinkingLevel']>[0];

function latestAssistantError(session: AgentSession, beforeMessageIds: ReadonlySet<string>): string | undefined {
  const entry = [...session.sessionManager.getEntries()]
    .reverse()
    .find((item) => item.type === 'message' && item.message.role === 'assistant' && !beforeMessageIds.has(item.id));
  if (!entry || entry.type !== 'message' || entry.message.role !== 'assistant') return undefined;
  if (entry.message.stopReason !== 'error' && entry.message.stopReason !== 'aborted') return undefined;
  return entry.message.errorMessage?.trim() || `pi 以 ${entry.message.stopReason} 结束。`;
}

const piStatusEnabled = process.env.LARK_PI_STATUS_ENABLED?.trim().toLowerCase() !== 'false';
const piAutoCompaction = process.env.LARK_PI_STATUS_AUTO_COMPACTION?.trim().toLowerCase() !== 'false';

export class PiSessions {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly modelRuntimePromise = ModelRuntime.create();

  constructor(private readonly state: StateStore) {}

  async list(cwd: string): Promise<SessionInfo[]> {
    return SessionManager.list(cwd);
  }

  async prompt(
    chatId: string,
    cwd: string,
    sessionFile: string,
    text: string,
    onDelta?: (text: string) => void,
  ): Promise<PiPromptResult> {
    const session = await this.getOrOpen(chatId, cwd, sessionFile);
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
    try {
      const beforeMessageIds = new Set(
        session.sessionManager.getEntries()
          .filter((entry) => entry.type === 'message')
          .map((entry) => entry.id),
      );
      await session.prompt(text);
      const error = latestAssistantError(session, beforeMessageIds);
      if (error) throw new Error(error);
      return {
        answer: answer.trim() || '（Agent 没有返回文本）',
        status: this.statusFor(session),
      };
    } finally {
      unsubscribe();
    }
  }

  async abort(chatId: string): Promise<void> {
    await this.sessions.get(chatId)?.abort();
  }

  async models(): Promise<PiModelOption[]> {
    const runtime = await this.modelRuntimePromise;
    return (await runtime.getAvailable()).map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name ?? model.id,
    }));
  }

  async setModel(chatId: string, cwd: string, sessionFile: string, provider: string, modelId: string): Promise<PiModelOption> {
    const runtime = await this.modelRuntimePromise;
    const model = (await runtime.getAvailable()).find((item) => item.provider === provider && item.id === modelId);
    if (!model) throw new Error('该 model 当前不可用。');
    const session = await this.getOrOpen(chatId, cwd, sessionFile);
    await session.setModel(model);
    return { provider: model.provider, id: model.id, name: model.name ?? model.id };
  }

  async efforts(chatId: string, cwd: string, sessionFile: string): Promise<PiEffort[]> {
    return (await this.getOrOpen(chatId, cwd, sessionFile)).getAvailableThinkingLevels();
  }

  async setEffort(chatId: string, cwd: string, sessionFile: string, effort: PiEffort): Promise<void> {
    const session = await this.getOrOpen(chatId, cwd, sessionFile);
    if (!session.getAvailableThinkingLevels().includes(effort)) throw new Error('当前 model 不支持该思考强度。');
    session.setThinkingLevel(effort);
  }

  async rename(chatId: string, cwd: string, sessionFile: string, name: string): Promise<void> {
    const session = await this.getOrOpen(chatId, cwd, sessionFile);
    session.sessionManager.appendSessionInfo(name);
  }

  async compact(chatId: string, cwd: string, sessionFile: string): Promise<void> {
    await (await this.getOrOpen(chatId, cwd, sessionFile)).compact();
  }

  async status(chatId: string, cwd: string, sessionFile: string): Promise<string | undefined> {
    if (!piStatusEnabled) return undefined;
    return this.statusFor(await this.getOrOpen(chatId, cwd, sessionFile));
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
      session.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  }

  private statusFor(session: AgentSession): string | undefined {
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
    if (stats.tokens.input) parts.push(`↑${formatPiTokens(stats.tokens.input)}`);
    if (stats.tokens.output) parts.push(`↓${formatPiTokens(stats.tokens.output)}`);
    if (stats.tokens.cacheRead) parts.push(`R${formatPiTokens(stats.tokens.cacheRead)}`);
    if (stats.tokens.cacheWrite) parts.push(`W${formatPiTokens(stats.tokens.cacheWrite)}`);
    if (promptTokens > 0 && (stats.tokens.cacheRead > 0 || stats.tokens.cacheWrite > 0)) {
      parts.push(`CH${((usage!.cacheRead / promptTokens) * 100).toFixed(1)}%`);
    }
    if (stats.cost) parts.push(`$${stats.cost.toFixed(3)}`);
    const context = stats.contextUsage;
    const contextWindow = context?.contextWindow ?? 0;
    const percent = context?.percent === null ? '?' : (context?.percent ?? 0).toFixed(1);
    parts.push(`${percent}%/${formatPiTokens(contextWindow)}${piAutoCompaction && session.autoCompactionEnabled ? ' (auto)' : ''}`);
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
      session.dispose();
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

  private async getOrOpen(chatId: string, cwd: string, sessionFile: string): Promise<AgentSession> {
    const existing = this.sessions.get(chatId);
    if (existing && existing.sessionFile === sessionFile) return existing;
    existing?.dispose();
    const { session } = await createAgentSession({
      cwd,
      modelRuntime: await this.modelRuntimePromise,
      sessionManager: SessionManager.open(sessionFile, undefined, cwd),
    });
    this.sessions.set(chatId, session);
    return session;
  }

  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }
}

function formatPiTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}
