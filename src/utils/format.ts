import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { COMMAND_OUTPUT_LIMIT } from '../config.js';
import { escapeCommand } from '../cards.js';

export function commandOutputMarkdown(command: string, stdout: string, stderr: string, limit = COMMAND_OUTPUT_LIMIT): string {
  const output = [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`].filter(Boolean).join('\n\n');
  const clipped = output.length > limit ? `${output.slice(-limit)}\n\n（输出已截断）` : output;
  return clipped ? `\`$ ${escapeCommand(command)}\`\n\n\`\`\`text\n${clipped}\n\`\`\`` : `\`$ ${escapeCommand(command)}\`\n\n（当前没有输出）`;
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
