// Screenshots of stellar.expert pages for the two demo contracts and the story transactions.
// Output: docs/demo-runs/2026-10-26-testnet/screenshots/*.png (listed in screenshots.json).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { RUN_DIR, json } from './lib.mjs';

const ev = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../evidence/testnet-2026-10-26.json'), 'utf8'));
const DIR = resolve(RUN_DIR, 'screenshots');
mkdirSync(DIR, { recursive: true });
const STORY = ['create_plan_co_1001', 'deposit_co_1001', 'apply_lock_co_1001_quarterly', 'release_due_co_1001_M1', 'deposit_sv_2001', 'release_spot_sv_2001_M1'];
const targets = [
  { name: 'contract_colombia', url: ev.contracts.colombia.explorerUrl },
  { name: 'contract_el_salvador', url: ev.contracts.el_salvador.explorerUrl },
  ...STORY.map((s) => ev.transactions.find((t) => t.step === s)).map((t) => ({ name: t.step, url: t.explorerUrl, hash: t.txHash })),
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
const shots = [];
for (const t of targets) {
  await page.goto(t.url, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForTimeout(2_000);
  const text = await page.innerText('body');
  const key = t.hash ?? t.url.split('/').pop();
  const shown = text.includes(key) || text.includes(key.slice(0, 8));
  const file = `${t.name}.png`;
  await page.screenshot({ path: resolve(DIR, file), fullPage: false });
  shots.push({ file, url: t.url, idShownOnPage: shown });
  console.log(file, shown ? 'id shown' : 'ID NOT FOUND ON PAGE');
}
await browser.close();
writeFileSync(resolve(DIR, 'screenshots.json'), json({ takenAt: new Date().toISOString(), shots }) + '\n');
