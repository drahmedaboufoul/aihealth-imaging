import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import path from 'path';
import { REQUIRED_CLIENT_ENV, missingClientEnv } from './src/lib/config.js';

/**
 * M0 config guard. A production build without the client Supabase settings
 * would deploy a viewer that cannot start, so `vite build` fails instead (CI
 * passes inert dummy values). og:url / og:image come from
 * VITE_PUBLIC_VIEWER_URL and are omitted when it is unset.
 */
function viewerConfigGuard(env, { command, mode }) {
  const publicOrigin = (() => {
    try { return new URL(String(env.VITE_PUBLIC_VIEWER_URL || '').trim()).origin; } catch { return ''; }
  })();
  return {
    name: 'aihealth-viewer-config-guard',
    buildStart() {
      if (command !== 'build' || mode !== 'production') return;
      const missing = missingClientEnv(env);
      if (missing.length) {
        throw new Error(
          `[config] production build needs ${missing.join(', ')} `
          + `(required: ${REQUIRED_CLIENT_ENV.join(', ')}). See .env.example.`,
        );
      }
      if (!publicOrigin) {
        this.warn('VITE_PUBLIC_VIEWER_URL is not set: share links cannot be minted and og:url is omitted.');
      }
    },
    transformIndexHtml() {
      if (!publicOrigin) return [];
      return [
        { tag: 'meta', attrs: { property: 'og:url', content: `${publicOrigin}/` }, injectTo: 'head' },
        { tag: 'meta', attrs: { property: 'og:image', content: `${publicOrigin}/aihealth-mark.png` }, injectTo: 'head' },
        { tag: 'meta', attrs: { name: 'twitter:image', content: `${publicOrigin}/aihealth-mark.png` }, injectTo: 'head' },
      ];
    },
  };
}

export default defineConfig(({ command, mode }) => {
  // VITE_* from .env files and the process environment (Vercel / CI).
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    // wasm + topLevelAwait are needed for Cornerstone3D's @icr/polyseg-wasm
    // dependency (auto-loaded by @cornerstonejs/tools). Without them, Vite's
    // default build chokes on "ESM integration proposal for Wasm".
    plugins: [viewerConfigGuard(env, { command, mode }), react(), wasm(), topLevelAwait()],
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
      // dicom-image-loader must load its decode workers from source — the
      // pre-bundled deps dir doesn't contain the worker file, so dev-server
      // DICOM decoding 404s (production builds were unaffected). Its CJS
      // codec deps then need explicit pre-bundling for ESM interop.
      exclude: ['@icr/polyseg-wasm', '@cornerstonejs/dicom-image-loader'],
      include: [
        'dicom-parser',
        // Deep subpath imports used by dicom-image-loader's decode workers —
        // Emscripten CJS modules that need esbuild's ESM interop in dev.
        '@cornerstonejs/codec-charls/decodewasmjs',
        '@cornerstonejs/codec-libjpeg-turbo-8bit/decodewasmjs',
        '@cornerstonejs/codec-openjpeg/decodewasmjs',
        '@cornerstonejs/codec-openjph/wasmjs',
      ],
    },
  };
});
