import { stat } from 'node:fs/promises';

/** Windows 保留设备名（主名 = 首个 `.` 前片段，不区分大小写） */
const WINDOWS_RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/;

/** 工作路径长度上限（字节，对齐 POSIX PATH_MAX；Windows 长路径同样适用） */
const MAX_WORKSPACE_PATH_BYTES = 4096;

/** 平台感知的路径语法校验（纯函数）。合法返回 undefined，否则返回错误描述（不带「工作路径」前缀，由调用方拼接）。 */
export function validatePathSyntax(path: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (Buffer.byteLength(path) > MAX_WORKSPACE_PATH_BYTES) return `路径过长（超过 ${MAX_WORKSPACE_PATH_BYTES} 字节）。`;
  if (platform === 'win32') {
    if (/[\u0000-\u001f]/.test(path)) return '包含控制字符。';
    const stripped = path.replace(/[\\/]/g, '');
    const hasDriveColon = /^[A-Za-z]:$/.test(stripped.slice(0, 2));
    if (stripped.slice(hasDriveColon ? 2 : 0).includes(':')) return '包含非法字符（:）。';
    if (/[<>"|?*]/.test(stripped)) return '包含非法字符（< > " | ? *）。';
    if (!/^[A-Za-z]:[\\/]/.test(path) && !/^\\\\/.test(path)) return '不是合法的 Windows 绝对路径。';
    for (const segment of path.split(/[\\/]+/).filter(Boolean)) {
      if (/[ .]$/.test(segment)) return `路径段「${segment}」不能以空格或点结尾。`;
      if (WINDOWS_RESERVED_NAMES.test(segment.split('.')[0].toUpperCase())) return `路径段「${segment}」是 Windows 保留设备名。`;
    }
    return undefined;
  }
  if (path.includes('\0')) return '包含非法字符（NUL）。';
  if (!path.startsWith('/')) return '不是合法的绝对路径。';
  return undefined;
}

/**
 * 校验路径已存在且为目录（不存在 / 是文件 / 不可访问都拒绝），供创建项目群 / 绑定项目提交时使用。
 * 注意：仅提供提交时的即时反馈，**非安全边界**——校验与后续使用之间存在 TOCTOU 窗口
 * （目录可被删除/替换），cwd 失效由命令执行 / 同步的既有容错兜底。
 */
export async function assertWorkspaceDirectory(cwd: string): Promise<void> {
  const info = await stat(cwd).catch((error: NodeJS.ErrnoException) => error);
  if (!(info instanceof Error)) {
    if (!info.isDirectory()) throw new Error(`工作路径不是目录：${cwd}`);
    return;
  }
  if (info.code === 'ENOENT') throw new Error(`工作路径不存在：${cwd}`);
  throw new Error(`工作路径不可访问：${cwd}（${info.code ?? info.message}）`);
}
