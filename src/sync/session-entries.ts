import { SessionManager } from '@earendil-works/pi-coding-agent';
import { piAutoRetryMaxRetries } from '../config.js';
import type { ComputerTurn, SessionMessageEntry } from '../types.js';

type MessageEntry = SessionMessageEntry & { message: NonNullable<SessionMessageEntry['message']> };

export function isSessionMessageEntry(entry: SessionMessageEntry): entry is MessageEntry {
  return entry.type === 'message' && typeof entry.id === 'string' && Boolean(entry.message?.role);
}

export function isPublishableAssistant(entry: MessageEntry): boolean {
  return entry.message.role === 'assistant'
    && entry.message.stopReason !== 'error'
    && entry.message.stopReason !== 'aborted';
}

export function finalFailureMessage(turn: ComputerTurn): string | undefined {
  const message = turn.final.message;
  if (message.role !== 'assistant' || message.stopReason !== 'error') return undefined;
  if (isRetryablePiError(message.errorMessage)) {
    const attempts = turn.entries.filter((entry) =>
      entry.message.role === 'assistant'
      && entry.message.stopReason === 'error'
      && isRetryablePiError(entry.message.errorMessage),
    ).length;
    if (attempts <= piAutoRetryMaxRetries) return undefined;
  }
  return message.errorMessage?.trim() || 'pi 未提供具体错误信息。';
}

export function isRetryablePiError(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  if (/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(errorMessage)) {
    return false;
  }
  return /overloaded|rate.?limit|too many requests|\b429\b|\b50[0-4]\b|\b524\b|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|upstream.?connect|reset before headers|socket hang up|socket connection was closed|timed? out|timeout|terminated|websocket.?closed|websocket.?error|ended without|stream ended before message_stop|stream ended before a terminal response event|http2 request did not get a response|retry delay|you can retry your request|try your request again|please retry your request|ResourceExhausted/i.test(errorMessage);
}

export function completedComputerTurns(entries: MessageEntry[]): ComputerTurn[] {
  const turns: ComputerTurn[] = [];
  for (let userIndex = 0; userIndex < entries.length; userIndex += 1) {
    const user = entries[userIndex];
    if (user.message.role !== 'user') continue;
    const nextUserIndex = entries.findIndex((entry, index) => index > userIndex && entry.message.role === 'user');
    const end = nextUserIndex === -1 ? entries.length : nextUserIndex;
    let final: MessageEntry | undefined;
    for (let index = end - 1; index > userIndex; index -= 1) {
      const entry = entries[index];
      if (entry.message.role === 'assistant' && entry.message.stopReason !== 'toolUse') {
        final = entry;
        break;
      }
    }
    if (final) {
      const turnEntries = entries.slice(userIndex, end);
      turns.push({ user, final, assistantMessages: turnEntries.filter(isPublishableAssistant), entries: turnEntries });
    }
  }
  return turns;
}

export function sessionBranchEntries(file: string, cwd: string): SessionMessageEntry[] {
  return SessionManager.open(file, undefined, cwd).getBranch() as unknown as SessionMessageEntry[];
}

export function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.filter((item) => item?.type === 'text').map((item) => item.text ?? '').join('').trim();
}
