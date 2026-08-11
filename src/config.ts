import { join, resolve } from 'node:path';

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
export const PI_SESSION_CACHE_LIMIT = 32;
export const INSTANCE_LOCK_INVALID_GRACE_MS = 5_000;
export const SYNC_BODY_BYTE_LIMIT = 28 * 1024; // 飞书富文本 30KB 上限，为 JSON 转义 / md 标签膨胀预留余量
export const SYNC_TRUNCATION_MARKER = '（同步内容过长，内容已截断）';

// ── 引用附件（飞书资源下载缓存）──
export const mediaRoot = join(stateRoot, 'media');
/** 附件缓存总容量上限（LRU 按 mtime 清理） */
export const MEDIA_CACHE_MAX_BYTES = nonNegativeIntegerEnv('LARK_MEDIA_CACHE_MAX_BYTES', 512 * 1024 * 1024);
/** 单个附件下载超时 */
export const MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000;
/** 图片走模型视觉通道（images 参数）的单张大小上限；超限降级为路径注入 */
export const MEDIA_IMAGE_INJECT_LIMIT = 10 * 1024 * 1024;
/** 纯附件类消息类型：到达时不进 agent（贴纸静默；其余回轻提示），且其 content 为 normalize 占位 */
export const ATTACHMENT_MESSAGE_TYPES = new Set(['image', 'file', 'audio', 'video', 'sticker']);
