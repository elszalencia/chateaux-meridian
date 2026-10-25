// File store for the indexer: one append-only JSONL file per collection and one small JSON file per
// cursor, under `.data/` (gitignored). A row is written once per id: `put` of an id that is already
// there is a no-op, which is what makes replays after a crash or a restart harmless. A line torn by
// a crash mid-write is skipped on load (the row comes back on the next replay).

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class JsonlStore<T extends { id: string }> {
  private readonly rows = new Map<string, T>();
  readonly file: string;
  /** Lines that could not be parsed on load (a torn last line after a crash). */
  readonly skipped: number;

  constructor(dir: string, name: string) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${name}.jsonl`);
    let skipped = 0;
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as T;
          if (!this.rows.has(row.id)) this.rows.set(row.id, row);
        } catch {
          skipped += 1;
        }
      }
    }
    this.skipped = skipped;
  }

  has(id: string): boolean {
    return this.rows.has(id);
  }

  get(id: string): T | undefined {
    return this.rows.get(id);
  }

  /** Appends the row unless its id is already stored; returns whether it was written. */
  put(row: T): boolean {
    if (this.rows.has(row.id)) return false;
    // A newline first, so a row never joins a torn line left by a crash.
    appendFileSync(this.file, `\n${JSON.stringify(row)}`, 'utf8');
    this.rows.set(row.id, row);
    return true;
  }

  all(): T[] {
    return [...this.rows.values()];
  }

  get size(): number {
    return this.rows.size;
  }

  /** Lines in the file (one per written row); equals `size` when nothing was ever duplicated. */
  lineCount(): number {
    if (!existsSync(this.file)) return 0;
    return readFileSync(this.file, 'utf8').split('\n').filter((l) => l.trim()).length;
  }
}

/** A JSON value saved atomically (write to a temporary file, then rename over the old one). */
export class JsonFile<T> {
  readonly file: string;

  constructor(dir: string, name: string) {
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${name}.json`);
  }

  read(): T | null {
    if (!existsSync(this.file)) return null;
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  write(value: T): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }
}
