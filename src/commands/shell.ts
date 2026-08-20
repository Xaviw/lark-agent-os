import { spawn, type ChildProcess } from 'node:child_process';
import type { AppContext } from '../app-context.js';
import { COMMAND_CARD_OUTPUT_LIMIT, COMMAND_CARD_UPDATE_INTERVAL_MS, COMMAND_OUTPUT_LIMIT } from '../config.js';
import type { CommandTask } from '../types.js';
import { commandOutputMarkdown, elapsedSince } from '../utils/format.js';
import { createCardUpdater, createThrottledUpdate, updateCardWithRetry } from '../utils/card-update.js';
import { commandFinalCard, commandRunningCard, commandStartingCard } from '../cards.js';
import { sendChat } from '../lark/chat-lifecycle.js';

/**
 * Windows cmd 内建命令（echo / dir / if 等）输出到管道或文件时按系统 ANSI 代码页（中文系统 = GBK）编码，
 * `chcp 65001` 只改变控制台代码页，对非控制台输出**无效**；外部现代工具（node / git 等）则多为 UTF-8。
 * 混合流无法用单一解码还原，故按行判定：UTF-8 严格解码成功且不含「中文输出中几乎不可能出现的异常
 * Unicode 区块」→ 视为 UTF-8；否则按 GBK 兜底重解。合法 UTF-8 输出（含 emoji、Latin-1 符号）不受影响。
 * 仅 Windows 使用（POSIX 输出恒按 UTF-8 透传，见 createOutputDecoder）。
 * 已知局限：GBK 双字节被误读为合法 UTF-8 且未命中异常区块的稀有组合，或 Windows 上真实输出含泰文/藏文等
 * 异常区块字符的 UTF-8 文本，仍可能误判（前者保持乱码=旧行为，后者罕见）。
 */
const SUSPICIOUS_BLOCKS = /[\u0370-\u03FF\u0400-\u04FF\u0530-\u058F\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0B00-\u0B7F\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F\u0D80-\u0DFF\u0E00-\u0E7F\u0E80-\u0EFF\u0F00-\u0FFF\u1000-\u109F\u10A0-\u10FF\u1100-\u11FF\u1200-\u137F\u13A0-\u13FF\u1400-\u167F\u1700-\u171F\u1780-\u17FF\u1800-\u18AF\u1A00-\u1A1F\u2800-\u28FF\u2C80-\u2CFF\uAC00-\uD7AF\uE000-\uF8FF\uF900-\uFAFF]/;

/** 单行字节解码（纯函数）：UTF-8 优先，异常区块或非法序列时 GBK 兜底 */
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });
const GBK_DECODER = new TextDecoder('gbk');

export function decodeCommandLine(line: Buffer): string {
  try {
    const utf8 = UTF8_FATAL.decode(line);
    if (!SUSPICIOUS_BLOCKS.test(utf8)) return utf8;
    return GBK_DECODER.decode(line);
  } catch {
    return GBK_DECODER.decode(line);
  }
}

/** 把含 \n 的完整字节段按行解码（保留 \r\n / \n 分隔符） */
function decodeLines(complete: Buffer): string {
  let text = '';
  let start = 0;
  for (let i = 0; i < complete.length; i++) {
    if (complete[i] !== 0x0a) continue;
    const hasCr = i > start && complete[i - 1] === 0x0d;
    text += decodeCommandLine(complete.subarray(start, hasCr ? i - 1 : i)) + (hasCr ? '\r\n' : '\n');
    start = i + 1;
  }
  return text;
}

/** pending 缓冲上限（字节）：无换行超长输出的内存保护，取展示上限 2 倍以尽量保持整行完整性 */
const MAX_PENDING_BYTES = COMMAND_OUTPUT_LIMIT * 2;
/** 强制解码时保留的尾部字节：覆盖最长多字节序列（UTF-8 4 字节），避免切断后解码错位 */
const TAIL_KEEP_BYTES = 4;

/**
 * 流式输出解码器：按 \n 切行（保留 \r\n / \n 分隔符），跨 chunk 缓冲不完整行与尾字节；flush 处理命令结束时的残留。
 * 仅 Windows 启用双解码（cmd 内建输出按 ACP=GBK、外部工具 UTF-8，逐行判定）；POSIX 输出恒为 UTF-8，直接透传
 * （避免泰文/藏文等合法输出被误判 GBK）。无换行的超长输出有缓冲上限保护（超出部分强制解码丢弃）。
 * platform 参数化便于独立验证（默认取运行平台）。
 */
export function createOutputDecoder(platform: NodeJS.Platform = process.platform): { push(chunk: Buffer): string; flush(): string } {
  if (platform !== 'win32') {
    return { push: (chunk: Buffer): string => chunk.toString('utf8'), flush: (): string => '' };
  }
  let pending: Buffer = Buffer.alloc(0);
  const push = (chunk: Buffer): string => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    const lastNl = pending.lastIndexOf(0x0a);
    if (lastNl >= 0) {
      const complete = pending.subarray(0, lastNl + 1);
      pending = pending.subarray(lastNl + 1);
      return decodeLines(complete);
    }
    // 无换行超长输出保护：强制解码超出部分（GBK 双字节切断处显示替换符可接受），保留尾部少量字节继续缓冲
    if (pending.length > MAX_PENDING_BYTES) {
      const overflow = pending.subarray(0, pending.length - TAIL_KEEP_BYTES);
      pending = pending.subarray(pending.length - TAIL_KEEP_BYTES);
      return decodeCommandLine(overflow);
    }
    return '';
  };
  const flush = (): string => {
    const rest = pending;
    pending = Buffer.alloc(0);
    if (!rest.length) return '';
    const hasCr = rest[rest.length - 1] === 0x0d;
    return decodeCommandLine(hasCr ? rest.subarray(0, -1) : rest);
  };
  return { push, flush };
}

/**
 * 平台感知的 shell 解析（纯函数，便于独立验证）：
 * - Windows：固定 cmd.exe（/d 禁 AutoRun、/s 剥离首尾引号、/c 执行命令），减少回退成本；命令前自动前置
 *   `chcp 65001 >nul &&`——注意：chcp 只改控制台代码页，对 cmd 内建命令的管道/文件输出**无效**
 *   （其输出恒按系统 ANSI 代码页，中文系统 = GBK），保留仅为兼容；内建命令中文乱码由 createOutputDecoder 的
 *   逐行双解码（UTF-8 优先 + GBK 兜底）解决，外部现代工具（git、node 等）自选 UTF-8 不受影响；
 * - macOS / Linux 等 POSIX：沿用 $SHELL（如 /bin/zsh），缺省 /bin/sh（-lc 登录 shell 执行）。
 * 注：Windows 回退 cmd.exe 后 POSIX 命令（ls 等）不可用，需使用 cmd 语法（dir 等；跨盘 cd 需 /d）。
 * 如变更 Windows shell 策略（如改用 PowerShell），需同步更新 commandFormCard 的 Windows 提示文案（src/cards.ts）。
 */
export function resolveShell(): { shell: string; args: string[]; commandPrefix: string } {
  if (process.platform === 'win32') {
    return { shell: 'cmd.exe', args: ['/d', '/s', '/c'], commandPrefix: 'chcp 65001 >nul && ' };
  }
  return { shell: process.env.SHELL?.trim() || '/bin/sh', args: ['-lc'], commandPrefix: '' };
}

export async function startShellCommand(
  ctx: AppContext,
  chatId: string,
  cwd: string,
  command: string,
  taskId: string,
  timeoutSeconds?: number,
  background = false,
  replyTo?: string,
): Promise<void> {
  const sent = await sendChat(ctx, chatId, { card: commandStartingCard(command, cwd, timeoutSeconds) }, replyTo ? { replyTo } : undefined);
  await runShellCommand(ctx, chatId, cwd, command, taskId, sent.messageId, timeoutSeconds, background);
}

export async function runShellCommand(
  ctx: AppContext,
  chatId: string,
  cwd: string,
  command: string,
  taskId: string,
  messageId: string,
  timeoutSeconds?: number,
  background = false,
): Promise<void> {
  const { shell, args, commandPrefix } = resolveShell();
  let child: ChildProcess;
  try {
    child = spawn(shell, [...args, `${commandPrefix}${command}`], {
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // 默认转义会把 `"` 传给 cmd：参数位置可解析，但重定向目标（`> "path"`）不认转义而报「语法不正确」；
      // verbatim 原样传引号，与 cmd 解析规则一致（POSIX 上该选项被忽略）。
      windowsVerbatimArguments: true,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await updateCardWithRetry(ctx, chatId, messageId, commandFinalCard(`命令启动失败：${reason}`, commandOutputMarkdown(command, '', '', COMMAND_CARD_OUTPUT_LIMIT)), 'command spawn failure');
    return;
  }
  // 后台（常驻）模式：忽略超时秒数；spawn 成功后立即完成本次任务卡，进程注册到 backgroundTasks（不进入 commandTasks，输出丢弃）
  if (background) {
    ctx.backgroundTasks.set(taskId, { id: taskId, command, cwd, startedAt: Date.now(), child, terminate: () => terminateProcessGroup(child) });
    // 进程自然退出 / spawn 后错误时自动清理条目（避免列表展示陈旧任务）并记录日志（避免未处理 error 事件崩溃）
    child.once('error', (error) => {
      if (ctx.backgroundTasks.get(taskId)?.child === child) ctx.backgroundTasks.delete(taskId);
      console.warn(`[background task] ${taskId}:`, error);
    });
    child.once('close', () => {
      if (ctx.backgroundTasks.get(taskId)?.child === child) ctx.backgroundTasks.delete(taskId);
    });
    child.stdout?.resume();
    child.stderr?.resume();
    await updateCardWithRetry(ctx, chatId, messageId, commandFinalCard('后台任务已启动', commandOutputMarkdown(command, '', '', COMMAND_CARD_OUTPUT_LIMIT)), 'background start status');
    return;
  }
  let stdout = '';
  let stderr = '';
  const startedAt = Date.now();
  const append = (current: string, addition: string): string => `${current}${addition}`.slice(-COMMAND_OUTPUT_LIMIT);
  const task: CommandTask = {
    child, chatId, command, cwd, stopped: false, timedOut: false, timeoutSeconds, startedAt, stdout: '', stderr: '', terminate: () => terminateProcessGroup(child),
  };
  // 逐行双解码（cmd 内建 GBK / 外部工具 UTF-8 混合流）：stdout / stderr 各自独立缓冲
  const decodeOut = createOutputDecoder();
  const decodeErr = createOutputDecoder();
  // 流式节流：stdout/stderr 触发 750ms 节流原位更新执行中卡片（stdout/stderr 原样展示；无「查看输出」按钮，仅「停止」）
  const throttled = createThrottledUpdate(() => {
    if (task.updater) void task.updater.update(commandRunningCard(taskId, command, cwd, timeoutSeconds, commandOutputMarkdown(command, stdout, stderr, COMMAND_CARD_OUTPUT_LIMIT)))
      .catch((error) => console.warn('[command output status]', error));
  }, COMMAND_CARD_UPDATE_INTERVAL_MS);
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout = append(stdout, decodeOut.push(chunk));
    task.stdout = stdout;
    throttled.trigger();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = append(stderr, decodeErr.push(chunk));
    task.stderr = stderr;
    throttled.trigger();
  });
  const resultPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
    child.once('error', (error) => resolve({ code: null, signal: null, error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  task.messageId = messageId;
  task.updater = createCardUpdater(ctx, chatId, messageId, 'command status');
  ctx.commandTasks.set(taskId, task);
  void task.updater.update(commandRunningCard(taskId, command, cwd, timeoutSeconds)).catch((error) => console.warn('[command start status]', error));
  const timeout = timeoutSeconds
    ? setTimeout(() => {
      task.timedOut = true;
      if (task.updater) void task.updater
        .finish(commandFinalCard(`命令超时（${timeoutSeconds} 秒）`, `${commandOutputMarkdown(task.command, task.stdout, task.stderr, COMMAND_CARD_OUTPUT_LIMIT)}\n\n命令超时（${timeoutSeconds} 秒）并已停止。`, elapsedSince(task.startedAt)))
        .catch((error) => console.warn('[command timeout status]', error));
      terminateProcessGroup(child);
    }, timeoutSeconds * 1_000)
    : undefined;

  const result = await resultPromise;
  // 命令结束：flush 未换行的尾字节（无新行时流式卡不触发，最终卡需包含全部输出）
  stdout = append(stdout, decodeOut.flush());
  stderr = append(stderr, decodeErr.flush());
  throttled.cancel();
  if (timeout) clearTimeout(timeout);
  ctx.commandTasks.delete(taskId);

  const statusText = task.timedOut
    ? `命令超时（${timeoutSeconds} 秒）并已停止。`
    : task.stopped
      ? '命令已手动停止。'
      : result.error
        ? `命令启动失败：${result.error.message}`
        : result.code === 0
          ? '命令执行完成。'
          : `命令执行失败（退出码 ${result.code ?? 'unknown'}${result.signal ? `，信号 ${result.signal}` : ''}）。`;
  // 最终卡 = 已流式显示的累计输出 + 追加状态消息
  await task.updater!.finish(commandFinalCard(statusText, `${commandOutputMarkdown(command, stdout, stderr, COMMAND_CARD_OUTPUT_LIMIT)}\n\n${statusText}`, elapsedSince(startedAt)));
}

/** 进程组终止：SIGTERM → 5s 后未退出 SIGKILL（Windows 退化为单进程 kill）；close 后不再兜底 */
export function terminateProcessGroup(child: ChildProcess): void {
  if (child.pid && process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    setTimeout(() => {
      if (child.exitCode === null && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    }, 5_000).unref();
    return;
  }
  child.kill('SIGTERM');
}
