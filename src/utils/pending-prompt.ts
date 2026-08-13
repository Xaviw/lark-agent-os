import type { NormalizedMessage } from '@larksuite/channel';
import type { PendingEntry } from '../types.js';

/** 挂起消息消费结果：ok = 续跑；expired = 曾挂起但超过等待窗口（不续跑，调用方应提示用户）；none = 无挂起上下文 */
export type PendingPromptOutcome =
  | { kind: 'ok'; message: NormalizedMessage; text: string }
  | { kind: 'expired' }
  | { kind: 'none' };

/**
 * 消费挂起的消息上下文（纯函数模块，无副作用依赖）：
 * 读取并删除 pending 槽（一次性，防历史卡重复触发续跑）；超过 maxAgeMs 视为过期不续跑。
 * 空槽 / 无 prompt 也删除（不残留）。
 */
export function takePendingPrompt(pending: Map<string, PendingEntry>, chatId: string, maxAgeMs: number, now = Date.now()): PendingPromptOutcome {
  const entry = pending.get(chatId);
  if (!entry) return { kind: 'none' };
  pending.delete(chatId);
  if (!entry.prompt) return { kind: 'none' };
  const { message, text, promptAt } = entry.prompt;
  if (now - promptAt > maxAgeMs) return { kind: 'expired' };
  return { kind: 'ok', message, text };
}
