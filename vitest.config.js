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
    // The share-invite unit tests import the browser Supabase module even
    // though they exercise only pure helpers. Keep production startup
    // fail-closed while supplying inert values in the isolated test process.
    env: {
      VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
      VITE_SUPABASE_ANON_KEY: 'test-anon-key',
    },
  },
});
