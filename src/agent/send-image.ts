import { readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { LarkChannel } from '@larksuite/channel';
import { Type } from 'typebox';
import { SEND_IMAGE_DOWNLOAD_TIMEOUT_MS, SEND_IMAGE_MAX_BYTES } from '../config.js';

/**
 * send_image 工具：让 Agent 把一张图片作为独立图片消息发送到当前飞书对话。
 *
 * 设计要点：
 * - 注册方式：AgentSessionConfig.customTools（进程内、按 session 闭包捕获 sessionFile），
 *   不写 session JSONL、不污染对话上下文，也不渗透到电脑端独立启动的 pi agent；
 * - 发送目标：由 pi 内部按 sessionFile 记录的「当前活跃 run」反查（per-session 串行，多群共享
 *   session 时也唯一），图片消息 replyTo 该 run 的状态卡（话题内保持话题窗口）；
 * - 图片来源：本地文件路径（绝对/相对，不限制工作目录）或 http(s) URL；均 ≤10MB（对齐飞书
 *   上传图片接口上限）；发送走 channel.send 的 Buffer source，不触发 allowedFileDirs 配置；
 * - 失败兜底：任何错误（文件不存在/超限/下载失败/上传失败）转为工具结果文本返回给 Agent，
 *   由 Agent 在回复中说明，不阻塞本次 prompt。
 */

/** 图片目标解析结果：本地文件路径（不限工作目录）或 http(s) URL */
export type ImageTarget =
  | { kind: 'url'; url: string }
  | { kind: 'local'; absPath: string };

/** 当前执行中 run 的可发送目标（chatId + 状态卡 messageId，供 replyTo） */
export type ActiveSendTarget = { chatId: string; messageId: string };

/** 发送图片执行器：由组装点注入（持有 LarkChannel），负责「目标 → 字节 → 发送」 */
export type SendImageExecutor = (req: {
  target: ImageTarget;
  chatId: string;
  messageId: string;
  signal?: AbortSignal;
}) => Promise<{ ok: true; messageId: string } | { ok: false; error: string }>;

/**
 * 敏感文件判定（纯函数）：拒绝发送密钥 / 凭据 / 隐私文件（prompt injection 缓解）。
 * 匹配：.env 系列文件名、私钥 / 证书扩展名、SSH 私钥名、`.ssh` 目录（任意位置）。
 * 仅拦截高价值凭据类文件，对正常图片产物零影响。
 */
const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /^\.env(?:\..+)?$/i,
  /\.(?:pem|key|p12|pfx)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)$/i,
];
export function isSensitiveLocalPath(absPath: string): boolean {
  const base = basename(absPath);
  if (SENSITIVE_FILE_PATTERNS.some((re) => re.test(base))) return true;
  return absPath.split(/[\\/]/).includes('.ssh');
}

/**
 * 解析工具参数 target（纯函数）：
 * - http(s):// 前缀 → URL 来源；
 * - 其他 → 本地路径（相对 cwd 或绝对路径均可，不限制工作目录范围），但拒绝敏感文件。
 */
export function resolveImageTarget(target: string, cwd: string): ImageTarget {
  const trimmed = target.trim();
  if (!trimmed) throw new Error('图片路径为空');
  if (/^https?:\/\//i.test(trimmed)) return { kind: 'url', url: trimmed };
  const absPath = resolve(cwd, trimmed);
  if (isSensitiveLocalPath(absPath)) throw new Error('拒绝发送敏感文件（密钥 / 凭据 / 隐私文件）');
  return { kind: 'local', absPath };
}

/** 构造可被 LLM 调用的 send_image 工具定义（每 session 一份，闭包捕获 cwd） */
export function buildSendImageTool(opts: {
  /** 反查当前活跃 run 的发送目标（pi 内部按 sessionFile 记录；无活跃 run 时返回 undefined） */
  resolveActiveRun: () => ActiveSendTarget | undefined;
  /** 惰性获取发送执行器（组装点注入；未装配返回 undefined） */
  sendImage: () => SendImageExecutor | undefined;
  cwd: string;
}): ToolDefinition {
  const { resolveActiveRun, sendImage, cwd } = opts;
  const maxMb = SEND_IMAGE_MAX_BYTES / 1024 / 1024;
  return defineTool({
    name: 'send_image',
    label: '发送图片',
    description: [
      '把一张图片发送到当前飞书对话（作为独立图片消息）。',
      '当你生成图表、截图或下载了图片，需要把图片直接发给用户时调用此工具。',
      `参数 target 为图片的本地文件路径（绝对路径或相对工作目录的路径）或 http(s) 图片 URL；单张图片大小不能超过 ${maxMb}MB。`,
      '禁止发送密钥、凭据或隐私文件（如 .env、SSH 私钥、证书文件）。',
      '调用成功后请继续用文字说明图片内容。',
    ].join(' '),
    parameters: Type.Object({
      target: Type.String({ description: '图片文件路径或 http(s) 图片 URL' }),
    }),
    async execute(_toolCallId, params, signal) {
      const active = resolveActiveRun();
      if (!active) {
        return {
          content: [{ type: 'text', text: '图片发送失败：当前没有正在进行的飞书对话，无法确定发送目标。' }],
          details: {},
        };
      }
      let target: ImageTarget;
      try {
        target = resolveImageTarget(params.target, cwd);
      } catch (error) {
        return { content: [{ type: 'text', text: `图片发送失败：${error instanceof Error ? error.message : String(error)}` }], details: {} };
      }
      const executor = sendImage();
      if (!executor) {
        return { content: [{ type: 'text', text: '图片发送失败：发送执行器未装配。' }], details: {} };
      }
      const outcome = await executor({ target, chatId: active.chatId, messageId: active.messageId, signal });
      const text = outcome.ok
        ? `图片已发送到飞书对话（消息 id：${outcome.messageId}）。`
        : `图片发送失败：${outcome.error}`;
      return { content: [{ type: 'text', text }], details: {} };
    },
  });
}

/** 创建发送执行器：读本地文件 / 下载 URL → Buffer（大小校验）→ channel.send 发独立图片消息 */
export function createSendImageExecutor(channel: LarkChannel): SendImageExecutor {
  return async ({ target, chatId, messageId, signal }) => {
    try {
      const buffer = await loadImageBytes(target, signal);
      const sent = await channel.send(chatId, { image: { source: buffer } }, { replyTo: messageId });
      return { ok: true, messageId: sent.messageId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[send_image] 发送失败', { chatId, target: target.kind === 'url' ? target.url : target.absPath, error: message });
      return { ok: false, error: message };
    }
  };
}

async function loadImageBytes(target: ImageTarget, signal?: AbortSignal): Promise<Buffer> {
  if (target.kind === 'local') {
    let st;
    try {
      st = await stat(target.absPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`图片文件不存在：${target.absPath}`);
      throw new Error(`无法读取图片文件：${target.absPath}`);
    }
    if (!st.isFile()) throw new Error(`图片路径不是文件：${target.absPath}`);
    if (st.size > SEND_IMAGE_MAX_BYTES) throw new Error(`图片大小超过 ${SEND_IMAGE_MAX_BYTES / 1024 / 1024}MB 上限`);
    return readFile(target.absPath);
  }
  // URL 来源：限 http(s)（resolveImageTarget 已保证），流式下载 + 大小/超时限制，支持外部 abort
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEND_IMAGE_DOWNLOAD_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  // signal 已中止时（如用户已停止 agent）后续注册的监听器不会被调用，须显式中止；未中止则订阅后续 abort
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(target.url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`下载图片失败：HTTP ${res.status}`);
    if (!res.body) throw new Error('下载图片失败：响应无内容');
    return await readBodyLimited(res.body, SEND_IMAGE_MAX_BYTES);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** 流式读取响应体并限制总大小：超限中断并报错（防恶意 URL 返回海量内容） */
async function readBodyLimited(body: ReadableStream<Uint8Array>, limit: number): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`图片大小超过 ${limit / 1024 / 1024}MB 上限`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
