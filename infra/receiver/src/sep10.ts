// SEP-10 web authentication with the SDK's WebAuth helpers. The challenge binds the home domain
// `host:port` and the same web auth domain; verification prefers the client account's real signers
// and medium threshold from Horizon and falls back to the master key when the account does not exist
// on the ledger, as the SEP allows. The JWT `jti` is the challenge hash, so one challenge yields one
// token. client_domain attribution is not supported: the parameter is accepted and ignored, which
// the SEP permits for servers without that feature.

import { Keypair, MuxedAccount, WebAuth } from '@stellar/stellar-sdk';
import { HttpError, type Req } from './http.ts';
import { signJwt, verifyJwt } from './jwt.ts';
import { messageOf } from './log.ts';

export interface AccountSigners {
  signers: { key: string; weight: number; type: string }[];
  /** Medium threshold; 0 on a fresh account, in which case any valid master signature passes. */
  threshold: number;
}

export interface Sep10Options {
  serverKeypair: Keypair;
  homeDomain: string;
  webAuthDomain: string;
  networkPassphrase: string;
  webAuthEndpoint: string;
  jwtSecret: string;
  /** Signers and medium threshold of an account, or null when it does not exist on the ledger. */
  loadSigners: (account: string) => Promise<AccountSigners | null>;
}

export interface Auth {
  sub: string;
  account: string;
  memo: string | null;
}

export const CHALLENGE_TIMEOUT_S = 300;
export const TOKEN_TTL_S = 24 * 60 * 60;

/** The G address behind a muxed M address; G addresses pass through. */
export function baseAccount(account: string): string {
  return account.startsWith('M') ? MuxedAccount.fromAddress(account, '0').baseAccount().accountId() : account;
}

export function buildChallenge(opts: Sep10Options, account: string, memo: string | null, homeDomain: string | null): { transaction: string; network_passphrase: string } {
  if (!/^G[A-Z2-7]{55}$/.test(account) && !/^M[A-Z2-7]{68}$/.test(account)) throw new HttpError(400, { error: 'account is not a Stellar account id' });
  if (memo !== null) {
    if (account.startsWith('M')) throw new HttpError(400, { error: 'memo cannot be combined with a muxed account' });
    if (!/^\d+$/.test(memo)) throw new HttpError(400, { error: 'memo must be an unsigned 64-bit integer' });
  }
  if (homeDomain && homeDomain !== opts.homeDomain) throw new HttpError(400, { error: `home_domain ${homeDomain} is not served by this anchor` });
  const transaction = WebAuth.buildChallengeTx(opts.serverKeypair, account, opts.homeDomain, CHALLENGE_TIMEOUT_S, opts.networkPassphrase, opts.webAuthDomain, memo);
  return { transaction, network_passphrase: opts.networkPassphrase };
}

export async function verifyChallenge(opts: Sep10Options, challengeXdr: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<{ token: string }> {
  const server = opts.serverKeypair.publicKey();
  let read: ReturnType<typeof WebAuth.readChallengeTx>;
  try {
    read = WebAuth.readChallengeTx(challengeXdr, server, opts.networkPassphrase, opts.homeDomain, opts.webAuthDomain);
  } catch (e) {
    throw new HttpError(400, { error: `invalid challenge: ${messageOf(e)}` });
  }
  const client = read.clientAccountID;
  let loaded: AccountSigners | null;
  try {
    loaded = await opts.loadSigners(baseAccount(client));
  } catch (e) {
    throw new HttpError(503, { error: `could not load account ${client} from Horizon: ${messageOf(e)}` });
  }
  try {
    if (loaded) {
      WebAuth.verifyChallengeTxThreshold(challengeXdr, server, opts.networkPassphrase, Math.max(1, loaded.threshold), loaded.signers, opts.homeDomain, opts.webAuthDomain);
    } else {
      WebAuth.verifyChallengeTxSigners(challengeXdr, server, opts.networkPassphrase, [baseAccount(client)], opts.homeDomain, opts.webAuthDomain);
    }
  } catch (e) {
    throw new HttpError(401, { error: `challenge not signed by the account: ${messageOf(e)}` });
  }
  const jti = Buffer.from(read.tx.hash()).toString('hex');
  const sub = read.memo ? `${client}:${read.memo}` : client;
  const token = signJwt({ iss: opts.webAuthEndpoint, sub, iat: nowSeconds, exp: nowSeconds + TOKEN_TTL_S, jti }, opts.jwtSecret);
  return { token };
}

/** The SEP-10 identity behind `Authorization: Bearer`; 401 when missing, invalid or expired. */
export function requireAuth(req: Req, jwtSecret: string): Auth {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  const claims = m ? verifyJwt(m[1]!, jwtSecret) : null;
  if (!claims) throw new HttpError(401, { error: 'missing or invalid SEP-10 token' });
  const [account, memo] = claims.sub.split(':');
  return { sub: claims.sub, account: account ?? claims.sub, memo: memo ?? null };
}
