// `npm run reset`: rebuilds the demo seed in a fresh in-memory store, times the reset the same way
// the "Reiniciar demo" button does, and prints the step-1 state so the presenter can confirm it.
// Browser state lives in the tab's localStorage; use the button, or open http://localhost:5173/?reset=1.

import { createMockApi, PLAN_MARIA, PLAN_ROXANA } from '../services/src/index.ts';

const api = createMockApi({ minDelayMs: 0, maxDelayMs: 0 });
const { state, elapsedMs } = await api.reset();
const plan = await api.getPlan(PLAN_MARIA);
const states = plan.installments.slice(0, 10).map((i) => `M${i.number}:${i.cellState}`).join(' ');

console.log(`Casa Puente demo reset in ${elapsedMs} ms (limit: 10 000 ms)`);
console.log(`today: ${state.today} · pass-through: ${state.passThrough * 100}% · seed ${state.seedVersion}`);
console.log(`María / Oliva: ${states}`);
console.log(`next payment: USD ${plan.summary.nextUsd} due ${plan.summary.nextDueDate}`);
const sv = await api.getPlan(PLAN_ROXANA);
const svStates = sv.installments.slice(0, 8).map((i) => `M${i.number}:${i.cellState}`).join(' ');
console.log(`Roxana / Torre Cedros (El Salvador): ${svStates}`);
console.log(`next payment: USD ${sv.summary.nextUsd} due ${sv.summary.nextDueDate}`);
console.log('Browser tab: click "Reiniciar demo" or open http://localhost:5173/?reset=1');
