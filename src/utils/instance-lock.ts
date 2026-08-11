import { randomUUID } from 'node:crypto';
import { link, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { INSTANCE_LOCK_INVALID_GRACE_MS } from '../config.js';
import { basename, dirname, join } from 'node:path';

export type InstanceLock = { release: () => Promise<void> };

/** 先完整写入候选文件，再以硬链接原子发布，避免其他进程观察到半写入的 PID。 */
export async function acquireInstanceLock(file: string, attempt = 0): Promise<InstanceLock> {
  if (attempt === 0) await cleanupLockCandidates(file);
  const candidate = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(candidate, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
  const owner = await stat(candidate);
  let acquired = false;
  try {
    await link(candidate, file);
    acquired = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  } finally {
    await unlink(candidate).catch(() => undefined);
  }
  if (acquired) {
    return {
      release: async () => {
        if (await isSameFile(file, owner.dev, owner.ino)) await unlink(file).catch(() => undefined);
      },
    };
  }

  if (attempt >= 3) throw new Error(`实例锁 ${file} 无法清理（已重试 ${attempt} 次），拒绝启动`);
  const existing = await stat(file).catch(() => undefined);
  if (!existing) return acquireInstanceLock(file, attempt + 1);

  // 新实现不会产生空锁。旧版遗留的无效锁仅在超过宽限期后清理，避免与仍在执行 open → writeFile 的旧进程竞争。
  let pid: number | undefined;
  try {
    const raw = (await readFile(file, 'utf8')).trim();
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0 && String(parsed) === raw) pid = parsed;
  } catch { /* 保持 pid 为 undefined，由下方按锁龄处理 */ }
  if (pid === undefined) {
    if (Date.now() - existing.mtimeMs < INSTANCE_LOCK_INVALID_GRACE_MS) {
      throw new Error(`实例锁 ${file} 正在初始化或内容无效，拒绝启动`);
    }
    if (await isSameFile(file, existing.dev, existing.ino)) await unlink(file).catch(() => undefined);
    return acquireInstanceLock(file, attempt + 1);
  }
  try {
    process.kill(pid, 0);
  } catch (probeError) {
    if ((probeError as NodeJS.ErrnoException).code === 'ESRCH') {
      if (await isSameFile(file, existing.dev, existing.ino)) await unlink(file).catch(() => undefined);
      return acquireInstanceLock(file, attempt + 1);
    }
    throw probeError; // EPERM 等：无法探活，视为仍在运行
  }
  throw new Error(`Another lark-agent-os instance is already running (pid ${pid})`);
}

async function isSameFile(file: string, dev: number, ino: number): Promise<boolean> {
  const current = await stat(file).catch(() => undefined);
  return Boolean(current && current.dev === dev && current.ino === ino);
}

async function cleanupLockCandidates(file: string): Promise<void> {
  const directory = dirname(file);
  const prefix = `${basename(file)}.`;
  const names = await readdir(directory).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const candidate = join(directory, name);
    const pidText = name.slice(prefix.length, -'.tmp'.length).split('.')[0];
    const pid = Number.parseInt(pidText, 10);
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') continue;
      }
    } else {
      const info = await stat(candidate).catch(() => undefined);
      if (!info || Date.now() - info.mtimeMs < INSTANCE_LOCK_INVALID_GRACE_MS) continue;
    }
    await unlink(candidate).catch(() => undefined);
  }
}
