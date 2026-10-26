/*
 * cbctCompute.worker.js — module Web Worker running the CBCT viewer's heavy
 * voxel compute (curved-MPR panoramic + cross-sections, auto-arch detection,
 * AI-view rendering) off the main thread. Constructed ONLY by
 * cbctComputeClient.js via the Vite module-worker syntax:
 *
 *   new Worker(new URL('./cbctCompute.worker.js', import.meta.url), { type: 'module' })
 *
 * Protocol:
 *   main → worker
 *     { type: 'volume', volumeKey, vol }               cache the volume snapshot
 *     { type: 'job', jobId, volumeKey, task, params }  run a compute task
 *   worker → main
 *     { type: 'progress', jobId, note }
 *     { type: 'done', jobId, result }                  image buffers TRANSFERRED
 *     { type: 'error', jobId, message }
 *
 * The worker holds ONE volume snapshot at a time (the viewer shows one study);
 * posting a new one replaces it, freeing the old snapshot for GC.
 */
import { executeCbctComputeTask, collectResultTransferables } from './cbctComputeTasks';

let current = null; // { volumeKey, vol }

self.onmessage = (event) => {
  const msg = event?.data || {};

  if (msg.type === 'volume') {
    current = { volumeKey: msg.volumeKey, vol: msg.vol };
    return;
  }

  if (msg.type !== 'job') return;
  const { jobId, volumeKey, task, params } = msg;
  try {
    if (!current || current.volumeKey !== volumeKey) {
      throw new Error('Volume snapshot not loaded in the compute worker');
    }
    const result = executeCbctComputeTask(task, current.vol, params, (note) => {
      self.postMessage({ type: 'progress', jobId, note });
    });
    self.postMessage({ type: 'done', jobId, result }, collectResultTransferables(result));
  } catch (e) {
    self.postMessage({ type: 'error', jobId, message: e?.message || String(e) });
  }
};
