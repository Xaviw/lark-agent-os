import { completedComputerTurns } from './session-entries.js';
import type { ComputerTurn, SessionMessageEntry } from '../types.js';

/**
 * 方案 B 轮次选择（纯函数）：扫描 from 之后的完整轮次，按来源分组——
 * - 飞书轮次（任一 entry 命中来源标记）→ 不发送，但视为已消费，进度推进到它（防回环信息随消费即释放）
 * - 电脑端轮次 → auto 仅最新一轮 / manual 按 count 回溯最近 N 轮，发送
 * 返回 { selected, consumed }：consumed = 已消费轮次中位置最靠后的一个（发送或排除）；无可消费轮次时为 undefined。
 */
export type SyncTurnSelection = {
  selected: ComputerTurn[];
  consumed?: ComputerTurn;
};

export function selectSyncTurns(
  entries: Array<SessionMessageEntry & { message: NonNullable<SessionMessageEntry['message']> }>,
  from: number,
  feishuOrigin: Set<string>,
  mode: 'auto' | 'manual',
  count?: number,
): SyncTurnSelection {
  const indexOf = (id: string): number => entries.findIndex((entry) => entry.id === id);
  const turnsAfter = completedComputerTurns(entries).filter((turn) => indexOf(turn.final.id) > from);
  // 预计算 final 位置，避免 sort comparator 内重复 findIndex（O(n·k·log k) → O(n + k·log k)）
  const positionOf = new Map<string, number>();
  for (const turn of turnsAfter) positionOf.set(turn.final.id, indexOf(turn.final.id));
  const isFeishuTurn = (turn: ComputerTurn): boolean => turn.entries.some((entry) => feishuOrigin.has(entry.id));
  const feishuTurns = turnsAfter.filter(isFeishuTurn);
  const computerTurns = turnsAfter.filter((turn) => !isFeishuTurn(turn));
  const selected = mode === 'auto' ? computerTurns.slice(-1) : count ? computerTurns.slice(-count) : computerTurns;
  const consumed = [...selected, ...feishuTurns].sort((a, b) => positionOf.get(a.final.id)! - positionOf.get(b.final.id)!).at(-1);
  return { selected, consumed };
}
