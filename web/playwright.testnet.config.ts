// Playwright config for the testnet walk-through: a globalSetup that deploys and seeds the contract
// and starts (or reuses, after a /health mode check) the server on 8787, Vite in `--mode testnet` on
// 5174, and a 15-minute budget sized for real transactions.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: /demo-script\.testnet\.spec\.ts/,
  globalSetup: './e2e/testnet.global-setup.ts',
  globalTeardown: './e2e/testnet.global-teardown.ts',
  timeout: 900_000,
  globalTimeout: 900_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5174',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    actionTimeout: 60_000,
    locale: 'es-CO',
  },
  projects: [
    { name: 'desktop-testnet', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: 'npx vite --mode testnet --port 5174 --strictPort',
    url: 'http://localhost:5174',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
