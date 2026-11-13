/*
 * cbctComputeClient — main-thread handle on the CBCT compute worker
 * (cbctCompute.worker.js). Owns the worker lifecycle so the viewer only deals
 * in promises:
 *
 *   const client = createCbctComputeClient();
 *   const { pano } = await client.run('pano', { volumeKey, vol, volumeLoaded,
 *     params }, { onProgress });
 *   client.cancelAll();   // mode switch — drop in-flight jobs, free the CPU
 *   client.dispose();     // unmount — cancel + terminate
 *
 * Design points:
 *   - The worker is constructed LAZILY inside run(), never at module import —
 *     so importing this module (and the viewer) stays safe in jsdom/vitest,
 *     where `Worker` does not exist. In those environments (or if the worker
 *     crashes) run() falls back to the SAME task module synchronously on the
 *     main thread — identical outputs, just no offloading.
 *   - One job per task kind: a new 'pano' job supersedes the previous one
 *     (which rejects with CbctComputeCancelled and has its late worker
 *     messages dropped).
 *   - A running worker loop cannot be interrupted, so cancelAll()/dispose()
 *     terminate the worker when something is actually in flight; the next job
 *     boots a fresh worker and re-posts the volume snapshot.
 */
import { executeCbctComputeTask } from './cbctComputeTasks';

export class CbctComputeCancelled extends Error {
  constructor(message = 'CBCT compute cancelled') {
    super(message);
    this.name = 'CbctComputeCancelled';
  }
}

export const isComputeCancelled = (e) => e?.name === 'CbctComputeCancelled';

export function createCbctComputeClient() {
  let worker = null;
  let workerBroken = false; // boot/parse/crash failure → main-thread fallback
  let jobSeq = 0;
  const jobs = new Map(); // jobId -> { task, resolve, reject, onProgress }
  // Volume snapshot the worker currently holds. `reusable` is false while the
  // volume is still streaming: cornerstone writes incoming frames into the
  // SAME typed array in place, so a copied snapshot goes stale — every job
  // re-posts a fresh copy until the load completes (matching what the old
  // synchronous code saw when it read the live array at call time).
  let posted = null; // { volumeKey, scalarDataRef, reusable }

  const workerAvailable = () =>
    !workerBroken && typeof Worker !== 'undefined' && typeof URL !== 'undefined';

  function failAllJobs(err) {
    const pending = Array.from(jobs.values());
    jobs.clear();
    pending.forEach((job) => { try { job.reject(err); } catch (_) { /* ignore */ } });
  }

  function dropWorker() {
    if (worker) { try { worker.terminate(); } catch (_) { /* ignore */ } }
    worker = null;
    posted = null;
  }

  function ensureWorker() {
    if (worker) return worker;
    // Vite module-worker syntax — bundled/served by Vite, '@/lib' aliases work
    // inside the worker graph.
    worker = new Worker(new URL('./cbctCompute.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      const msg = event?.data || {};
      const job = jobs.get(msg.jobId);
      if (!job) return; // cancelled / superseded — drop late messages
      if (msg.type === 'progress') {
        try { job.onProgress?.(msg.note); } catch (_) { /* progress is best-effort */ }
        return;
      }
      jobs.delete(msg.jobId);
      if (msg.type === 'done') job.resolve(msg.result);
      else job.reject(new Error(msg.message || 'CBCT compute failed'));
    };
    worker.onerror = (event) => {
      // Worker script failed to load/parse or crashed — reject everything in
      // flight and run future jobs synchronously so the feature still works.
      console.warn('[cbctComputeClient] worker error — falling back to main-thread compute:', event?.message || event);
      workerBroken = true;
      failAllJobs(new Error(event?.message || 'CBCT compute worker failed'));
      dropWorker();
    };
    return worker;
  }

  // ── transfer-vs-copy decision ─────────────────────────────────────────────
  // The volume's scalarData is a LIVE view over cornerstone's own volume
  // buffer: the streaming loader keeps writing frames into it and the WebGL
  // renderer keeps reading it. TRANSFERRING that buffer to the worker would
  // DETACH it under cornerstone (black viewports, broken tools), so the
  // original is never transferred. Instead:
  //   - SharedArrayBuffer-backed data (crossOriginIsolated deployments):
  //     post the view as-is — structured clone SHARES the memory. No copy,
  //     no detach, and the worker always sees the freshest voxels.
  //   - plain ArrayBuffer-backed data: COPY exactly the viewed region once
  //     (scalarData.slice() — same element type, so the arithmetic downstream
  //     is bit-identical) and transfer THE COPY's buffer, which is ours to
  //     give away. One memcpy on the main thread replaces seconds of
  //     main-thread voxel crunching.
  function packScalarData(scalarData) {
    if (typeof SharedArrayBuffer !== 'undefined' && scalarData?.buffer instanceof SharedArrayBuffer) {
      return { data: scalarData, transfer: [], shared: true };
    }
    const copy = scalarData.slice();
    return { data: copy, transfer: [copy.buffer], shared: false };
  }

  function postVolume(volumeKey, vol, volumeLoaded) {
    if (
      posted &&
      posted.volumeKey === volumeKey &&
      posted.scalarDataRef === vol.scalarData &&
      posted.reusable
    ) return; // the worker already holds a valid snapshot of this volume
    const { data, transfer, shared } = packScalarData(vol.scalarData);
    ensureWorker().postMessage({
      type: 'volume',
      volumeKey,
      vol: {
        dimensions: Array.from(vol.dimensions),
        spacing: Array.from(vol.spacing),
        origin: Array.from(vol.origin),
        direction: Array.from(vol.direction),
        scalarData: data,
      },
    }, transfer);
    // Shared views are always live; a copy is only reusable once streaming
    // finished (the data cannot change under it anymore).
    posted = { volumeKey, scalarDataRef: vol.scalarData, reusable: shared || Boolean(volumeLoaded) };
  }

  /**
   * Run a compute task (see cbctComputeTasks.js for tasks/params/results).
   * Supersedes any pending job of the same task kind — latest wins, the
   * predecessor rejects with CbctComputeCancelled.
   *
   * @param {string} task
   * @param {{ volumeKey:string, vol:Object, volumeLoaded?:boolean, params?:Object }} spec
   * @param {{ onProgress?:(note:string)=>void }} [handlers]
   * @returns {Promise<Object>}
   */
  function run(task, { volumeKey, vol, volumeLoaded = false, params = {} }, { onProgress } = {}) {
    for (const [id, job] of Array.from(jobs)) {
      if (job.task === task) {
        jobs.delete(id);
        job.reject(new CbctComputeCancelled('superseded by a newer job'));
      }
    }
    if (!workerAvailable()) {
      // Main-thread fallback: same shared task module, same outputs — just
      // synchronous, deferred one microtask so callers' busy state commits.
      return Promise.resolve().then(() =>
        executeCbctComputeTask(task, vol, params, (note) => { try { onProgress?.(note); } catch (_) { /* ignore */ } })
      );
    }
    return new Promise((resolve, reject) => {
      try {
        postVolume(volumeKey, vol, volumeLoaded);
        const jobId = ++jobSeq;
        jobs.set(jobId, { task, resolve, reject, onProgress });
        ensureWorker().postMessage({ type: 'job', jobId, volumeKey, task, params });
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * Cancel all pending jobs (they reject with CbctComputeCancelled). When a
   * job was actually in flight the worker is terminated too — a mid-loop
   * worker cannot be interrupted any other way; the next run() boots a fresh
   * worker and re-posts the volume snapshot.
   * @returns {boolean} whether anything was in flight
   */
  function cancelAll({ terminate = true } = {}) {
    const hadJobs = jobs.size > 0;
    failAllJobs(new CbctComputeCancelled());
    if (terminate && hadJobs) dropWorker();
    return hadJobs;
  }

  /** Unmount teardown: cancel everything and terminate the worker. */
  function dispose() {
    failAllJobs(new CbctComputeCancelled());
    dropWorker();
  }

  return { run, cancelAll, dispose };
}
