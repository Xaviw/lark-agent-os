import { resolve } from 'node:path';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function nonNegativeIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer.`);
  return Number.parseInt(value, 10);
}

export const appId = required('LARK_APP_ID');
export const appSecret = required('LARK_APP_SECRET');
export const stateRoot = resolve(process.env.LARK_STATE_DIR ?? '.state');
export const defaultWorkspace = resolve(process.env.LARK_DEFAULT_WORKSPACE ?? process.cwd());
export const piAutoRetryMaxRetries = nonNegativeIntegerEnv('LARK_PI_RETRY_MAX_RETRIES', 3);

export const COMMAND_OUTPUT_LIMIT = 30_000;
export const COMMAND_CARD_OUTPUT_LIMIT = 6_000;
export const COMMAND_CARD_UPDATE_INTERVAL_MS = 750;
export const REPLY_CONTEXT_MAX_LENGTH = 12_000;
export const AGENT_CARD_UPDATE_INTERVAL_MS = 750;
export const SYNC_BODY_BYTE_LIMIT = 28 * 1024; // 飞书富文本 30KB 上限，为 JSON 转义 / md 标签膨胀预留余量
export const SYNC_TRUNCATION_MARKER = '（同步内容过长，内容已截断）';
