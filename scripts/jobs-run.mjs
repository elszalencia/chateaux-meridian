// `npm run jobs:run -- <name>`: manual trigger of a server job (POST /jobs/<name>/run on the
// running testnet server) and a readable print of the run. Without a name it lists the jobs.
//   npm run jobs:run -- ttl-keeper

const SERVER = process.env.SERVER_URL || 'http://localhost:8787';
const name = process.argv[2];

async function main() {
  if (!name) {
    const res = await fetch(`${SERVER}/jobs`);
    const { jobs } = await res.json();
    for (const j of jobs) console.log(`${j.name.padEnd(22)} ${JSON.stringify(j.schedule).padEnd(10)} last: ${j.lastRun ? `${j.lastRun.startedAt} ${j.lastRun.summary}` : 'never'}`);
    console.log('\nRun one with: npm run jobs:run -- <name>');
    return;
  }
  const res = await fetch(`${SERVER}/jobs/${encodeURIComponent(name)}/run`, { method: 'POST' });
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  const run = body.run;
  console.log(`${run.name}: ${run.ok ? 'ok' : 'FAILED'} in ${run.ms} ms — ${run.ok ? run.summary : run.error}`);
  for (const w of run.warnings) console.log(`  WARNING ${w}`);
  if (Array.isArray(run.details)) for (const d of run.details) console.log(`  ${JSON.stringify(d)}`);
  if (!run.ok) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`jobs:run failed: ${e instanceof Error ? e.message : e} (is the server running on ${SERVER}?)`);
  process.exit(1);
});
