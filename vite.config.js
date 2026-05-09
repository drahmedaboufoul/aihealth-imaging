import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import path from 'path';

export default defineConfig({
  // wasm + topLevelAwait are needed for Cornerstone3D's @icr/polyseg-wasm
  // dependency (auto-loaded by @cornerstonejs/tools). Without them, Vite's
  // default build chokes on "ESM integration proposal for Wasm".
  plugins: [react(), wasm(), topLevelAwait()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // We don't use polygon segmentation. Aliasing @icr/polyseg-wasm to an
      // empty stub stops Vite's commonjs resolver from trying to bundle the
      // .wasm binary (which fails because rollup can't parse it as JS).
      // Cornerstone's tools work fine without polyseg loaded.
      '@icr/polyseg-wasm': path.resolve(__dirname, './src/lib/polyseg-stub.js'),
    },
  },
  server: { port: 5174 },
  // Cornerstone's image loader uses Web Workers; ensure Vite doesn't
  // try to inline them (would break on production builds).
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['@icr/polyseg-wasm'],
  },
});
