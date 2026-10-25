// MockOnRampProvider: simulates the ACH debit from the buyer's US bank account that Stage 3 replaces
// with a SEP-24 deposit on the SDF test anchor. Completes immediately after a realistic delay.

import type { OnRampProvider, OnRampStatus } from './interfaces';
import { MockRuntime, shortId } from './mockRuntime';

export class MockOnRampProvider implements OnRampProvider {
  readonly name = 'ACH (simulado)';
  private readonly deposits = new Map<string, OnRampStatus>();

  constructor(private readonly runtime: MockRuntime) {}

  async initiateDeposit(args: { buyerId: string; usdAmount: number; memo: string }): Promise<{ depositId: string; status: OnRampStatus }> {
    await this.runtime.call('onRamp.initiateDeposit');
    const depositId = shortId('ach', `${args.buyerId}:${args.memo}:${args.usdAmount}:${Date.now()}`);
    this.deposits.set(depositId, 'completed');
    return { depositId, status: 'completed' };
  }

  async status(depositId: string): Promise<OnRampStatus> {
    await this.runtime.call('onRamp.status', 0.3);
    return this.deposits.get(depositId) ?? 'error';
  }
}
