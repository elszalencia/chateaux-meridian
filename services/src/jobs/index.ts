// The jobs the testnet server runs, registered in one place.
//
// Registration point for the adverse-events job: the policy engine (services/src/policy) supplies
// a `JobFn` that runs the daily delinquency pass (mark missed after grace, defaults, holds). Pass it
// as `adverseEventsDaily` and it is registered as ADVERSE_EVENTS_JOB on the daily schedule with a
// manual trigger, next to the TTL keeper. Without it the server runs the TTL keeper only.

import { JobRegistry, type JobFn } from './registry';
import { TTL_KEEPER_JOB, ttlKeeperJob, type TtlKeeperDeps } from './ttlKeeper';

export const ADVERSE_EVENTS_JOB = 'adverse-events-daily';

export interface DefaultJobs {
  ttlKeeper: TtlKeeperDeps;
  adverseEventsDaily?: JobFn;
}

export function registerDefaultJobs(registry: JobRegistry, jobs: DefaultJobs): JobRegistry {
  registry.register(TTL_KEEPER_JOB, 'daily', ttlKeeperJob(jobs.ttlKeeper));
  if (jobs.adverseEventsDaily) registry.register(ADVERSE_EVENTS_JOB, 'daily', jobs.adverseEventsDaily);
  return registry;
}

export * from './registry';
export * from './ttlKeeper';
