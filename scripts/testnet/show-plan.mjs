// Prints a plan's on-chain state as a Markdown table (read-only get_status by simulation).
// Usage: node scripts/testnet/show-plan.mjs <co|sv> <planId>
// On the El Salvador instance the `cop_due` field holds USD cents.
import { nativeToScVal } from '@stellar/stellar-sdk';
import { read } from './lib.mjs';

const CONTRACTS = {
  co: 'CDSXCY3KS7THFGIWZNYNMPHIERITXW4YFI6AD3I64R75ZYVNQDLLTFZV',
  sv: 'CCNWBC5NN5EEWRLTAQ72URIOJ4MDLIAZCIQ3VIL7BUYPPLBPZOTI22MF',
};
const STATUS = ['Open', 'Locked', 'Released', 'Broken', 'Missed', 'Waived'];
const STATE = ['Active', 'Delinquent', 'Defaulted', 'OnHold', 'Cancelled', 'Completed'];
const READER = 'GD2DR6MYUWTWB57YXKNY6VK43VOLHPXUBUEKT7MZ5AP5JC3VOOVAHEKH'; // any funded account; simulation only

const [corridor, id] = process.argv.slice(2);
if (!CONTRACTS[corridor] || !id) { console.error('usage: show-plan.mjs <co|sv> <planId>'); process.exit(2); }
const r = await read(CONTRACTS[corridor], 'get_status', [nativeToScVal(Number(id), { type: 'u32' })], READER);
if (r.error) { console.error(r.error); process.exit(1); }
const { plan, installments, governance: g } = r.value;
const usd = (stroops) => (stroops == null ? '-' : `${(Number(stroops) / 1e7).toFixed(2)}`);
const day = (ts) => new Date(Number(ts) * 1000).toISOString().slice(0, 10);
const amt = (v) => (corridor === 'sv' ? `USD ${(Number(v) / 100).toFixed(2)} (${v} cents)` : `COP ${Number(v).toLocaleString('en-US')}`);

console.log(`Plan ${id} · ${corridor === 'co' ? 'Colombia' : 'El Salvador'} · ${CONTRACTS[corridor]}`);
console.log(`buyer ${plan.buyer} · state ${STATE[Number(g.state)] ?? g.state} · balance USD ${usd(plan.balance_usdc)} · deposited ${usd(g.total_deposited)} · released ${usd(g.total_released)}`);
console.log('');
console.log('| idx | due (UTC) | amount (cop_due field) | status | locked rate | usd_due | lock expiry |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const i of installments) {
  console.log(`| ${i.idx} | ${day(i.due_ts)} | ${amt(i.cop_due)} | ${STATUS[Number(i.status)] ?? i.status} | ${i.locked_rate == null ? '-' : (Number(i.locked_rate) / 1e7).toFixed(3)} | ${usd(i.usd_due)} | ${i.lock_expiry_ts == null ? '-' : day(i.lock_expiry_ts)} |`);
}
