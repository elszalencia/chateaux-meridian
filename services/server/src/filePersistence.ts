// Persistence for the server's MemoryStore: the snapshot is written to `.data/server/snapshot.json`
// (atomically, at most every 250 ms), so a server restart keeps the demo state the way the browser's
// localStorage did when the demo ran in the page.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Persistence, Snapshot } from '../../src/index';

export class FilePersistence implements Persistence {
  readonly file: string;
  private pending: Snapshot | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'snapshot.json');
  }

  load(): Snapshot | null {
    if (!existsSync(this.file)) return null;
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Snapshot;
    } catch {
      return null;
    }
  }

  save(snapshot: Snapshot): void {
    this.pending = snapshot;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 250);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pending) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.pending), 'utf8');
    renameSync(tmp, this.file);
    this.pending = null;
  }

  clear(): void {
    this.pending = null;
    if (existsSync(this.file)) rmSync(this.file);
  }
}
