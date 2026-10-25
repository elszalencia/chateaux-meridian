// One log line format for the whole process: timestamp, the anchor's name, message. The name is in
// every line on purpose: when the sender's and the receiver's logs are read side by side it must be
// obvious which counterparty is talking.

import { RECEIVER_NAME } from './config.ts';

export function log(message: string): void {
  console.log(`${new Date().toISOString()} [${RECEIVER_NAME}] ${message}`);
}

export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
