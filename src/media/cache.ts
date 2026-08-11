import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import type { LarkChannel, ResourceDescriptor } from '@larksuite/channel';
import { MEDIA_CACHE_MAX_BYTES, MEDIA_DOWNLOAD_TIMEOUT_MS, mediaRoot } from '../config.js';

/**
 * 引用附件缓存：飞书消息资源（图片 / 文件 / 音频 / 视频 / 贴纸）下载到
 * `<LARK_STATE_DIR>/media`，按内容 sha256 命名（`<hash>.<ext>`）去重复用；
 * 缓存总量超限时按 mtime（即访问时间）LRU 清理最旧文件。
 *
 * 设计要点：
 * - 只有「被引用（回复）」的消息才会触发下载（未引用不占缓存）；
 * - 下载失败 / 超时 / 容量不足 → 返回用户可见原因，由调用方决定「本轮不进 agent」；
 * - 决策逻辑（LRU 选择、扩展名映射）抽为纯函数便于独立验证。
 */

export type AttachmentKind = 'image' | 'file' | 'audio' | 'video' | 'sticker';

/** 一次下载请求：被引用消息 + 其中一个资源 */
export interface MediaResourceItem {
  messageId: string;
  resource: ResourceDescriptor;
}

/** 落盘成功后的缓存文件信息（供 prompt 注入使用） */
export interface CachedMediaFile {
  absPath: string;
  mime: string;
  size: number;
  hash: string;
  originalName?: string;
}

export type MediaResolveResult =
  | { ok: true; file: CachedMediaFile }
  | { ok: false; userVisible: string };

export interface MediaResolveOptions {
  rootDir?: string;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface MediaFileStat {
  path: string;
  size: number;
  mtimeMs: number;
}

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/json': 'json',
  'application/xml': 'xml',
  'text/html': 'html',
  'text/css': 'css',
  'application/javascript': 'js',
  'application/octet-stream': 'bin',
};

/** mime → 缓存文件扩展名（未知回退 bin） */
export function extensionForMime(mime: string): string {
  return MIME_EXT[mime.toLowerCase()] ?? 'bin';
}

/**
 * LRU 清理选择（纯函数）：按 mtime 升序（最旧先删）累计腾出至少 needBytes 空间。
 * 返回应删除的文件路径列表；调用方删除后须重新统计确认是否已腾够。
 */
export function planEvictions(files: readonly MediaFileStat[], needBytes: number): string[] {
  const sorted = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs);
  const paths: string[] = [];
  let freed = 0;
  for (const file of sorted) {
    if (freed >= needBytes) break;
    paths.push(file.path);
    freed += file.size;
  }
  return paths;
}

/**
 * 下载一条消息资源到缓存。
 * - 下载前不预检容量（无法预知大小）；流式写临时文件后按实际大小判定；
 * - 单文件 > 上限，或 LRU 清理后仍放不下 → 删除临时文件并返回失败原因；
 * - 同 hash 已存在 → 复用并刷新 mtime（LRU 命中），不重复占用；
 * - 并发安全：下载（IO）并行执行，但「复用判定 + 容量检查 + 落盘」在互斥临界区内串行，
 *   避免 check-then-act 导致缓存超限或同 hash 双写。
 */
export async function resolveResource(
  channel: LarkChannel,
  item: MediaResourceItem,
  options: MediaResolveOptions = {},
): Promise<MediaResolveResult> {
  const rootDir = options.rootDir ?? mediaRoot;
  const maxBytes = options.maxBytes ?? MEDIA_CACHE_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? MEDIA_DOWNLOAD_TIMEOUT_MS;
  await mkdir(rootDir, { recursive: true });

  const { messageId, resource } = item;
  const tmpPath = join(rootDir, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const download = channel.downloadResourceToFile(
    messageId,
    resource.fileKey,
    resource.type === 'image' ? 'image' : 'file',
    tmpPath,
  );
  const downloaded = await raceWithTimeout(download, timeoutMs, () => rm(tmpPath, { force: true }).catch(() => undefined));
  if (!downloaded.ok) {
    if (!downloaded.timedOut) {
      // 下载已结束，临时文件可直接清理（超时路径由 raceWithTimeout 兜底在下载结束后清理）
      await rm(tmpPath, { force: true }).catch(() => undefined);
      console.warn('[media] download failed', { messageId, fileKey: resource.fileKey, reason: downloaded.reason });
    }
    return { ok: false, userVisible: downloaded.timedOut ? '附件下载超时。' : '附件下载失败。' };
  }
  const { contentType } = downloaded.value;

  let tmpStat;
  try {
    tmpStat = await stat(tmpPath);
  } catch (error) {
    console.warn('[media] tmp stat failed', { messageId, fileKey: resource.fileKey, error: String(error) });
    await rm(tmpPath, { force: true }).catch(() => undefined);
    return { ok: false, userVisible: '附件下载失败：临时文件不可用。' };
  }
  if (tmpStat.size > maxBytes) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    return { ok: false, userVisible: '附件大小超出缓存容量上限。' };
  }

  const hash = await hashFile(tmpPath);
  const mime = contentType ?? defaultMime(resource.type);
  const absPath = join(rootDir, `${hash}.${extensionForMime(mime)}`);
  const file = cachedFile(absPath, mime, tmpStat.size, hash, resource);

  // 临界区：复用判定 / 容量腾挪 / 落盘串行执行（并发下载仍并行，仅决策串行）
  return runExclusive(async () => {
    if (await exists(absPath)) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      await utimes(absPath, new Date(), new Date()).catch(() => undefined);
      return { ok: true, file };
    }
    if (!(await ensureCapacity(rootDir, maxBytes, tmpStat.size))) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
      return { ok: false, userVisible: '缓存空间不足，无法保存该附件。' };
    }
    try {
      await rename(tmpPath, absPath);
    } catch (error) {
      // rename 失败（如并发同 hash 已落盘）：尽力复用已有文件
      await rm(tmpPath, { force: true }).catch(() => undefined);
      if (!(await exists(absPath))) {
        console.warn('[media] rename failed', { messageId, fileKey: resource.fileKey, error: String(error) });
        return { ok: false, userVisible: '附件保存失败。' };
      }
    }
    return { ok: true, file };
  });
}

/**
 * 保证缓存还能容纳 newSizeBytes：总量 + 新文件 > 上限时按 mtime LRU 清理最旧文件。
 * 返回清理后是否已腾够。**必须**在 {@link runExclusive} 临界区内调用（调用方保证）。
 */
async function ensureCapacity(rootDir: string, maxBytes: number, newSizeBytes: number): Promise<boolean> {
  const files = await listMediaFiles(rootDir);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total + newSizeBytes <= maxBytes) return true;
  const toRemove = planEvictions(files, total + newSizeBytes - maxBytes);
  await Promise.all(
    toRemove.map((path) => rm(path, { force: true }).catch(() => undefined)),
  );
  const after = await listMediaFiles(rootDir);
  return after.reduce((sum, file) => sum + file.size, 0) + newSizeBytes <= maxBytes;
}

/** 容量决策互斥链：并发下载（IO 并行）但「复用 + 容量 + 落盘」决策串行，避免 check-then-act */
let capacityChain: Promise<void> = Promise.resolve();
function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = capacityChain.then(fn, fn);
  capacityChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function cachedFile(
  absPath: string,
  mime: string,
  size: number,
  hash: string,
  resource: ResourceDescriptor,
): CachedMediaFile {
  return {
    absPath,
    mime,
    size,
    hash,
    ...(resource.fileName?.trim() ? { originalName: resource.fileName.trim() } : {}),
  };
}

function defaultMime(kind: AttachmentKind): string {
  switch (kind) {
    case 'image':
      return 'image/png';
    case 'audio':
      return 'audio/ogg';
    case 'video':
      return 'video/mp4';
    default:
      return 'application/octet-stream';
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 目录内全部缓存文件（排除未完成下载的 .tmp-* 临时文件） */
async function listMediaFiles(rootDir: string): Promise<MediaFileStat[]> {
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const out: MediaFileStat[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.tmp-')) continue;
    if (!entry.isFile()) continue;
    const path = join(rootDir, entry.name);
    try {
      const st = await stat(path);
      out.push({ path, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* 文件被并发删除等竞态：跳过 */
    }
  }
  return out;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/**
 * 给下载挂超时：超时后**不阻塞调用方**立即返回，原始下载结束后（无论成败）触发兜底清理
 * （避免 Windows 上删除被占用文件失败导致 .tmp-* 永久残留）；原始 promise 已挂处理避免 unhandled rejection。
 */
async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeoutCleanup?: () => void,
): Promise<{ ok: true; value: T } | { ok: false; reason: string; timedOut?: boolean }> {
  const settled = promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }),
  );
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
  });
  try {
    return await Promise.race([settled, timeout]);
  } catch {
    void settled.then(() => onTimeoutCleanup?.());
    return { ok: false, reason: '附件下载超时。', timedOut: true };
  } finally {
    clearTimeout(timer);
  }
}
