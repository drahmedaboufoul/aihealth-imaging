import { defineConfig } from 'vitest/config';
import path from 'path';

// Standalone vitest config (instead of merging vite.config.js) because the
// app config pulls in wasm/top-level-await plugins that only matter for the
// Cornerstone bundle — tests cover pure logic and run in plain node.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{js,jsx,ts,tsx}'],
  },
});
