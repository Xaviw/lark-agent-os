import { spawn, type ChildProcess } from 'node:child_process';
import type { AppContext } from '../app-context.js';
import { COMMAND_CARD_OUTPUT_LIMIT, COMMAND_CARD_UPDATE_INTERVAL_MS, COMMAND_OUTPUT_LIMIT } from '../config.js';
import type { CommandTask } from '../types.js';
import { commandOutputMarkdown, elapsedSince } from '../utils/format.js';
import { createCardUpdater, createThrottledUpdate } from '../utils/card-update.js';
import { commandFinalCard, commandRunningCard, commandStartingCard } from '../cards.js';

export async function startShellCommand(
  ctx: AppContext,
  chatId: string,
  cwd: string,
  command: string,
  taskId: string,
  timeoutSeconds?: number,
  background = false,
): Promise<void> {
  const sent = await ctx.lark.send(chatId, { card: commandStartingCard(command, cwd, timeoutSeconds) });
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
  const shell = process.env.SHELL?.trim() || '/bin/sh';
  let child: ChildProcess;
  try {
    child = spawn(shell, ['-lc', command], {
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await ctx.lark.updateCard(messageId, commandFinalCard(`命令启动失败：${reason}`, commandOutputMarkdown(command, '', '', COMMAND_CARD_OUTPUT_LIMIT)));
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
    await ctx.lark.updateCard(messageId, commandFinalCard('后台任务已启动', commandOutputMarkdown(command, '', '', COMMAND_CARD_OUTPUT_LIMIT)));
    return;
  }
  let stdout = '';
  let stderr = '';
  const startedAt = Date.now();
  const append = (current: string, chunk: Buffer): string => `${current}${chunk.toString('utf8')}`.slice(-COMMAND_OUTPUT_LIMIT);
  const task: CommandTask = {
    child, chatId, command, cwd, stopped: false, timedOut: false, timeoutSeconds, startedAt, stdout: '', stderr: '', terminate: () => terminateProcessGroup(child),
  };
  // 流式节流：stdout/stderr 触发 750ms 节流原位更新执行中卡片（stdout/stderr 原样展示；无「查看输出」按钮，仅「停止」）
  const throttled = createThrottledUpdate(() => {
    if (task.updater) void task.updater.update(commandRunningCard(taskId, command, cwd, timeoutSeconds, commandOutputMarkdown(command, stdout, stderr, COMMAND_CARD_OUTPUT_LIMIT)))
      .catch((error) => console.warn('[command output status]', error));
  }, COMMAND_CARD_UPDATE_INTERVAL_MS);
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout = append(stdout, chunk);
    task.stdout = stdout;
    throttled.trigger();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = append(stderr, chunk);
    task.stderr = stderr;
    throttled.trigger();
  });
  const resultPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
    child.once('error', (error) => resolve({ code: null, signal: null, error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  task.messageId = messageId;
  task.updater = createCardUpdater(ctx.lark, messageId, 'command status');
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
