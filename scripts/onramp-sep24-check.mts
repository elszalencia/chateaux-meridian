// `npx tsx scripts/onramp-sep24-check.mts`: live check of the SEP-24 on-ramp against the SDF test
// anchor. Creates a throwaway testnet account (friendbot), adds the Circle testnet USDC trustline,
// runs one 5 USD deposit through Sep24OnRampProvider and prints the SEP-24 id, status, amounts,
// elapsed time and the explorer link of the anchor's payment. No file or .env access.

import { Keypair } from '@stellar/stellar-sdk';
import { Submitter } from '../services/src/chain/submit.ts';
import { ensureFunded } from '../services/src/chain/deploy.ts';
import { TESTNET_PASSPHRASE, TESTNET_RPC_URL } from '../services/src/chain/env.ts';
import { Sep24OnRampProvider, ensureAnchorUsdcTrustline } from '../services/src/adapters/sep24OnRamp.ts';

const t0 = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

const buyer = Keypair.random();
const submitter = new Submitter({ rpcUrl: TESTNET_RPC_URL, networkPassphrase: TESTNET_PASSPHRASE });
log(`throwaway buyer ${buyer.publicKey()}`);
log(`friendbot: ${await ensureFunded(submitter, buyer.publicKey())}`);
const trust = await ensureAnchorUsdcTrustline(submitter, buyer, [buyer]);
log(`USDC trustline: ${trust.tx ? `created (tx ${trust.tx.txHash})` : 'already present'}`);

const onRamp = new Sep24OnRampProvider({ buyerSecret: () => buyer.secret(), log });
const r = await onRamp.initiateDeposit({ buyerId: 'buyer-check', usdAmount: 5, memo: 'onramp-sep24-check' });

console.log('');
console.log(`provider       ${onRamp.name}`);
console.log(`anchor         ${r.anchor}`);
console.log(`SEP-24 id      ${r.sep24Id}`);
console.log(`deposit id     ${r.depositId}`);
console.log(`status         ${r.status} (anchor: ${r.anchorStatus})`);
console.log(`amount in      ${r.amountIn} USD (requested ${r.requestedUsd}, deposited ${r.depositedUsd})`);
console.log(`amount out     ${r.amountOut} USDC`);
console.log(`elapsed        ${(r.elapsedMs / 1000).toFixed(1)} s`);
if (r.stellarTransactionId) console.log(`anchor payment https://stellar.expert/explorer/testnet/tx/${r.stellarTransactionId}`);
console.log(`status()       ${await onRamp.status(r.depositId)}`);
if (r.status !== 'completed') process.exit(1);
