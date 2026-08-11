import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { COMMAND_OUTPUT_LIMIT } from '../config.js';

/** 命令转义：防止用户输入的反引号 / 换行破坏卡片 markdown 渲染 */
export function escapeCommand(command: string): string {
  return command.replace(/`/g, '\\`').replace(/[\r\n]+/g, ' ').trim();
}

/** 时间格式化：兼容 number / string / 非法值（非法时显示占位） */
export function formatTimestamp(timestamp: unknown): string {
  const date = new Date(typeof timestamp === 'string' || typeof timestamp === 'number' ? timestamp : NaN);
  if (Number.isNaN(date.getTime())) return '??-??-?? ??:??:??';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.getFullYear()).slice(-2)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function commandOutputMarkdown(command: string, stdout: string, stderr: string, limit = COMMAND_OUTPUT_LIMIT): string {
  const output = [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`].filter(Boolean).join('\n\n');
  // 尾部截断按码点（Array.from），避免切断多字节字符
  const clipped = output.length > limit ? `${Array.from(output).slice(-limit).join('')}\n\n（输出已截断）` : output;
  return clipped ? `\`$ ${escapeCommand(command)}\`\n\n${markdownCodeBlock(clipped)}` : `\`$ ${escapeCommand(command)}\`\n\n（当前没有输出）`;
}

/** 使用比内容中最长反引号序列更长的 fence，避免命令输出提前闭合 Markdown code block。 */
export function markdownCodeBlock(content: string, language = 'text'): string {
  let longest = 0;
  for (const match of content.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${content}\n${fence}`;
}

export function elapsedSince(startedAt: number): string {
  return `${Math.max(1, Math.round((Date.now() - startedAt) / 1_000))} 秒`;
}

export function agentFailureContent(latest: string, error: unknown, stopped: boolean): string {
  const reason = error instanceof Error ? error.toString() : String(error);
  const prefix = latest.trim();
  const suffix = `${stopped ? '已停止处理。\n' : ''}错误：${reason}`;
  return prefix ? `${prefix}\n\n${suffix}` : suffix;
}

/**
 * 默认项目群名称：工作路径最后一级 + 本地时间 YYMMDDHHmm（如 my-project2508100932）。
 * basename 为空（如根目录）时兜底为 project；时间用本地时区。
 */
export function defaultProjectName(cwd: string): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${String(now.getFullYear()).slice(-2)}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${basename(cwd) || 'project'}${stamp}`;
}

export function resolveWorkspacePath(input: string, baseCwd: string): string {
  const value = input.trim();
  if (!value) throw new Error('请填写工作路径。');
  if (value.startsWith('~') && value !== '~' && !value.startsWith('~/')) {
    throw new Error('仅支持 `~` 或 `~/...` 形式的用户目录路径。');
  }
  const expanded = value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
  return resolve(baseCwd, expanded);
}
