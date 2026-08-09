import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ChatBinding, State } from './types.js';

export class StateStore {
  private state: State = {};
  private readonly file: string;
  private flushQueue: Promise<void> = Promise.resolve();

  constructor(root: string) {
    this.file = join(root, 'state.json');
  }

  async load(): Promise<void> {
    try {
      this.state = JSON.parse(await readFile(this.file, 'utf8')) as State;
      // The previous version bound one session per chat. Treat that path as
      // historical data so the next Feishu message goes through the chooser.
      for (const binding of Object.values(this.state) as Array<ChatBinding & { sessionFile?: string }>) delete binding.sessionFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  get(chatId: string): ChatBinding | undefined {
    return this.state[chatId];
  }

  all(): State {
    return { ...this.state };
  }

  set(chatId: string, binding: ChatBinding): void {
    this.state[chatId] = binding;
  }

  update(chatId: string, patch: Partial<ChatBinding>): ChatBinding | undefined {
    const current = this.state[chatId];
    if (!current) return undefined;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.state[chatId] = next;
    return next;
  }

  flush(): Promise<void> {
    const write = this.flushQueue.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, this.file);
    });
    this.flushQueue = write.catch(() => undefined);
    return write;
  }
}
