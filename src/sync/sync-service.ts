import { stat } from 'node:fs/promises';
import type { AppContext } from '../app-context.js';
import { SYNC_BODY_BYTE_LIMIT } from '../config.js';
import { formatTimestamp } from '../utils/format.js';
import type { ComputerTurn, SessionMessageEntry } from '../types.js';
import { extractText, finalFailureMessage, isSessionMessageEntry, sessionBranchEntries } from './session-entries.js';
import { selectSyncTurns } from './select-turns.js';
import { truncateSyncBody } from './truncate.js';

/** 群工作路径：私聊固定默认工作区；群聊取绑定 cwd，未绑定回退默认工作区 */
export function workspaceForChat(ctx: AppContext, chatId: string): string {
  const binding = ctx.state.get(chatId);
  return binding?.chatType === 'p2p' ? ctx.defaultWorkspace : binding?.cwd ?? ctx.defaultWorkspace;
}

export async function ensureAutoBaseline(ctx: AppContext, chatId: string): Promise<void> {
  const binding = ctx.state.get(chatId);
  if (!binding?.activeSessionFile) return;
  if (binding.sessionSync?.sessionFile === binding.activeSessionFile && binding.sessionSync.autoBaselineEntryId) return;
  let ids: string[] = [];
  try { ids = sessionBranchEntries(binding.activeSessionFile, workspaceForChat(ctx, chatId)).filter((entry) => entry.type === 'message').map((entry) => entry.id); } catch (error) {
    console.warn(`[session baseline] ${chatId}:`, error);
    return;
  }
  ctx.state.update(chatId, { sessionSync: { sessionFile: binding.activeSessionFile, autoBaselineEntryId: ids.at(-1) } });
  await ctx.state.flush();
}

/**
 * 电脑端 → 飞书 单向同步（方向不对称，飞书 → 电脑端无推送）。
 * 双 stat 校验避免读取写入中的 JSONL；方案 B 轮次选择（selectSyncTurns）按来源分组，
 * 进度推进到最后一个已消费轮次（含被排除的飞书轮次），消费后立即清理进度之前的飞书来源标记。
 */
export async function syncComputerSessions(
  ctx: AppContext,
  chatId: string,
  mode: 'auto' | 'manual',
  count?: number,
): Promise<{ sent: number; retry?: boolean; truncated?: boolean; busy?: boolean; progressReset?: boolean }> {
  const binding = ctx.state.get(chatId);
  if (!binding?.activeSessionFile) return { sent: 0 };
  if (isSessionBusy(ctx, binding.activeSessionFile)) return { sent: 0, busy: true };
  const firstStat = await stat(binding.activeSessionFile).catch(() => undefined);
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  const secondStat = await stat(binding.activeSessionFile).catch(() => undefined);
  if (!firstStat || !secondStat || firstStat.size !== secondStat.size || firstStat.mtimeMs !== secondStat.mtimeMs) return { sent: 0, retry: true };
  let entries: Array<SessionMessageEntry & { message: NonNullable<SessionMessageEntry['message']> }>;
  try {
    entries = sessionBranchEntries(binding.activeSessionFile, workspaceForChat(ctx, chatId)).filter(isSessionMessageEntry);
  } catch (error) {
    console.warn(`[session sync read] ${chatId}:`, error);
    return { sent: 0, retry: true };
  }
  const sync = binding.sessionSync?.sessionFile === binding.activeSessionFile
    ? binding.sessionSync
    : { sessionFile: binding.activeSessionFile, autoBaselineEntryId: undefined, lastLarkMessageId: undefined };
  const indexOf = (id: string | undefined): number => id ? entries.findIndex((entry) => entry.id === id) : -1;
  const from = mode === 'auto'
    ? Math.max(indexOf(sync.lastSyncedEntryId), indexOf(sync.autoBaselineEntryId))
    : indexOf(sync.lastSyncedEntryId);
  // 进度丢失（如 compact 重写文件后旧 entry id 已不存在）：先清除失效游标，本次不发送。
  // 用户再次手动同步时将从当前文件重新选择轮次；这可能重发历史，但不会把未同步轮次静默标成已消费。
  // 同时清理失效的飞书来源标记（旧 id 在重写后的文件中必然不存在，留只会无限累积）。
  if (mode === 'manual' && sync.lastSyncedEntryId && from === -1) {
    const autoBaselineEntryId = sync.autoBaselineEntryId && indexOf(sync.autoBaselineEntryId) !== -1
      ? sync.autoBaselineEntryId
      : undefined;
    ctx.state.update(chatId, {
      sessionSync: {
        sessionFile: binding.activeSessionFile,
        autoBaselineEntryId,
        lastSyncedEntryId: undefined,
        lastLarkMessageId: sync.lastLarkMessageId,
      },
      feishuOriginEntryIds: (binding.feishuOriginEntryIds ?? []).filter((id) => indexOf(id) !== -1),
    });
    await ctx.state.flush();
    return { sent: 0, progressReset: true };
  }
  const feishuOrigin = new Set(binding.feishuOriginEntryIds ?? []);
  // 方案 B：扫描 from 之后所有完整轮次，按来源分组（飞书轮次不发送但视为已消费，见 selectSyncTurns）
  const { selected, consumed } = selectSyncTurns(entries, from, feishuOrigin, mode, count);
  if (!consumed) return { sent: 0 };
  let sentCount = 0;
  let truncated = false;
  let sentMessageId: string | undefined;
  if (selected.length > 0) {
    const text = selected.map(formatComputerTurn).filter(Boolean).join('\n\n');
    if (text) {
      const last = selected.at(-1)!;
      const status = await ctx.pi.statusAt(workspaceForChat(ctx, chatId), binding.activeSessionFile, last.final.id).catch(() => undefined);
      let body = `${text}${status ? `\n\n${status}` : ''}`;
      if (Buffer.byteLength(body, 'utf8') > SYNC_BODY_BYTE_LIMIT) {
        body = truncateSyncBody(body, SYNC_BODY_BYTE_LIMIT);
        truncated = true;
      }
      const sent = await ctx.lark.send(chatId, { post: { zh_cn: { title: '', content: [[{ tag: 'md', text: body }]] } } });
      sentMessageId = sent.messageId;
      sentCount = selected.length;
    }
    // 说明：selected 有轮次但 text 为空（无法格式化的空轮次，如无文本消息）时，不发送但仍推进进度（视为已消费），
    // 避免该轮次被无限重扫；此时 toast 显示「无待同步消息」但 lastSyncedEntryId 已推进。
  }
  // 方案 B：进度推进到最后一个已消费轮次（含被排除的飞书轮次）；消费后立即清理进度之前的飞书来源标记（O(1) 即时释放，不再长期保留）
  const progressIndex = indexOf(consumed.final.id);
  ctx.state.update(chatId, {
    sessionSync: {
      sessionFile: binding.activeSessionFile,
      autoBaselineEntryId: sync.autoBaselineEntryId,
      lastSyncedEntryId: consumed.final.id,
      lastLarkMessageId: sentMessageId ?? sync.lastLarkMessageId,
    },
    feishuOriginEntryIds: (binding.feishuOriginEntryIds ?? []).filter((id) => indexOf(id) > progressIndex),
  });
  await ctx.state.flush();
  return { sent: sentCount, truncated };
}

function isSessionBusy(ctx: AppContext, sessionFile: string): boolean {
  if (ctx.agentRuns.isSessionActive(sessionFile)) return true;
  return Object.values(ctx.state.all()).some((binding) => binding.activeSessionFile === sessionFile
    && binding.inFlightFeishuRun?.sessionFile === sessionFile);
}

function formatComputerTurn(turn: ComputerTurn): string {
  const user = extractText(turn.user.message.content);
  const answer = turn.assistantMessages.map((entry) => extractText(entry.message.content)).filter(Boolean).join('\n\n');
  const failure = answer ? undefined : finalFailureMessage(turn);
  if (!user || (!answer && !failure)) return '';
  return `[User] ${formatTimestamp(turn.user.timestamp)}\n${user}\n\n[Agent] ${formatTimestamp(turn.final.timestamp)}\n${answer || `处理失败：${failure}`}`;
}

export function parseSyncCount(value: string | undefined): number | undefined | null {
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) return null;
  const count = Number.parseInt(value, 10);
  return count > 0 && count <= 1_000 ? count : null;
}

/** 飞书来源轮次标记（防回环）：run 结束即记录本轮 ids，同步消费（进度推进）后由 syncComputerSessions 清理 */
export async function markFeishuOrigin(ctx: AppContext, chatId: string, sessionFile: string, before: Set<string>, prompt?: string): Promise<void> {
  const entries = sessionBranchEntries(sessionFile, workspaceForChat(ctx, chatId));
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
  await markFeishuOriginEntries(ctx, sessionFile, ids);
}

/** 使用 prompt 持锁执行期间捕获的精确 entry ids 标记飞书来源，避免相同 prompt 的排队任务互相误认。 */
export async function markFeishuOriginEntries(ctx: AppContext, sessionFile: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  for (const [id, binding] of Object.entries(ctx.state.all())) {
    if (binding.activeSessionFile !== sessionFile) continue;
    const existing = binding.feishuOriginEntryIds ?? [];
    // 即时标记：run 结束即记录本轮 ids；消费（进度推进）后由 syncComputerSessions 清理。slice(-1000) 仅作极端兜底，正常不会接近上限
    ctx.state.update(id, { feishuOriginEntryIds: [...new Set([...existing, ...ids])].slice(-1000) });
  }
  await ctx.state.flush();
}
