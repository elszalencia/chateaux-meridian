/// <reference types="vitest/config" />
// Vite serves the web app and transpiles the linked @chateaux/services package from source,
// so the domain layer never needs its own build step in Stage 1.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// Testnet mode: the page calls the Node server (services/server) through /api; the server holds
// every key. SERVER_PORT matches the server's (default 8787).
const serverPort = Number(process.env.SERVER_PORT || 8787);
// PORT moves the dev server so parallel worktrees never share one (default 5173).
const port = Number(process.env.PORT || 5173);

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  // `.env.<mode>` files live at the repo root: `vite --mode testnet` reads `.env.testnet`, which
  // `npm run deploy:testnet` writes there. Only VITE_-prefixed variables reach the browser, and the
  // only one in that file is VITE_DEMO_MODE (`npm run check:bundle` enforces it).
  envDir: path.resolve(import.meta.dirname, '..'),
  resolve: {
    alias: {
      '@chateaux/services': path.resolve(import.meta.dirname, '../services/src/index.ts'),
    },
  },
  server: {
    port,
    strictPort: true,
    fs: { allow: [path.resolve(import.meta.dirname, '..')] },
    proxy: mode === 'testnet' ? { '/api': { target: `http://localhost:${serverPort}`, changeOrigin: true } } : undefined,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**'],
  },
}));
