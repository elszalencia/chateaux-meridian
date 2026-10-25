// A small job runner: `register(name, schedule, fn)`, timers started by `start()`, and `run(name)`
// for a manual trigger (the server exposes it as POST /jobs/<name>/run). A job never runs twice at
// the same time: a trigger while it is running waits for that run and returns its result. The last
// runs of every job are kept in memory for /jobs and for the logs.

export type JobSchedule = 'daily' | 'hourly' | { everyMs: number };

export interface JobContext {
  /** 'schedule' for timer runs, 'manual' for triggers. */
  trigger: 'schedule' | 'manual';
  log: (msg: string) => void;
}

/** A job returns a short summary (shown in /jobs) plus any warnings it raised. */
export interface JobResult {
  summary: string;
  warnings?: string[];
  details?: unknown;
}

export type JobFn = (ctx: JobContext) => Promise<JobResult>;

export interface JobRun {
  name: string;
  trigger: JobContext['trigger'];
  startedAt: string;
  ms: number;
  ok: boolean;
  summary: string;
  warnings: string[];
  error?: string;
  details?: unknown;
}

interface Job {
  name: string;
  schedule: JobSchedule;
  fn: JobFn;
  timer: ReturnType<typeof setInterval> | null;
  running: Promise<JobRun> | null;
  runs: JobRun[];
}

const HISTORY = 20;

export function scheduleMs(s: JobSchedule): number {
  if (s === 'daily') return 24 * 60 * 60 * 1000;
  if (s === 'hourly') return 60 * 60 * 1000;
  return s.everyMs;
}

export class JobRegistry {
  private readonly jobs = new Map<string, Job>();
  private started = false;

  constructor(private readonly log: (msg: string) => void = () => undefined) {}

  register(name: string, schedule: JobSchedule, fn: JobFn): void {
    if (this.jobs.has(name)) throw new Error(`job ${name} is already registered`);
    const job: Job = { name, schedule, fn, timer: null, running: null, runs: [] };
    this.jobs.set(name, job);
    if (this.started) this.arm(job);
  }

  has(name: string): boolean {
    return this.jobs.has(name);
  }

  names(): string[] {
    return [...this.jobs.keys()];
  }

  /** Runs a job now. Unknown names throw; a failing job resolves with `ok: false`. */
  run(name: string, trigger: JobContext['trigger'] = 'manual'): Promise<JobRun> {
    const job = this.jobs.get(name);
    if (!job) return Promise.reject(new Error(`unknown job ${name}; registered: ${this.names().join(', ') || 'none'}`));
    if (!job.running) job.running = this.execute(job, trigger).finally(() => (job.running = null));
    return job.running;
  }

  private async execute(job: Job, trigger: JobContext['trigger']): Promise<JobRun> {
    const t0 = Date.now();
    const startedAt = new Date(t0).toISOString();
    const log = (msg: string) => this.log(`[job ${job.name}] ${msg}`);
    let run: JobRun;
    try {
      const r = await job.fn({ trigger, log });
      run = { name: job.name, trigger, startedAt, ms: Date.now() - t0, ok: true, summary: r.summary, warnings: r.warnings ?? [], details: r.details };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      run = { name: job.name, trigger, startedAt, ms: Date.now() - t0, ok: false, summary: 'failed', warnings: [], error };
    }
    for (const w of run.warnings) log(`WARNING ${w}`);
    log(run.ok ? `${run.summary} (${run.ms} ms, ${trigger})` : `failed after ${run.ms} ms: ${run.error}`);
    job.runs.unshift(run);
    job.runs.length = Math.min(job.runs.length, HISTORY);
    return run;
  }

  private arm(job: Job): void {
    job.timer = setInterval(() => void this.run(job.name, 'schedule'), scheduleMs(job.schedule));
    job.timer.unref?.();
  }

  /** Arms every job's timer. The first scheduled run comes one period after start. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const job of this.jobs.values()) this.arm(job);
  }

  stop(): void {
    this.started = false;
    for (const job of this.jobs.values()) {
      if (job.timer) clearInterval(job.timer);
      job.timer = null;
    }
  }

  status(): { name: string; schedule: JobSchedule; running: boolean; lastRun: JobRun | null; runs: number }[] {
    return [...this.jobs.values()].map((j) => ({ name: j.name, schedule: j.schedule, running: j.running != null, lastRun: j.runs[0] ?? null, runs: j.runs.length }));
  }

  history(name: string): JobRun[] {
    return [...(this.jobs.get(name)?.runs ?? [])];
  }
}
