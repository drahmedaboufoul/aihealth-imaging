/// <reference lib="webworker" />
/*
 * Geometry worker: parsing, BVH, ICP, deviation, contacts, edits and
 * exports run here so the main thread keeps rendering at full rate.
 * It makes no network requests; scans arrive as ArrayBuffers from the page.
 */
import { GeometryStore, handleRequest, transferablesOf } from './handlers';
import type { WorkerEnvelope, WorkerRequest } from './protocol';

const store = new GeometryStore();
const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (event: MessageEvent<{ id: number; req: WorkerRequest }>) => {
  const { id, req } = event.data;
  const post = (msg: WorkerEnvelope, transfer: Transferable[] = []) => ctx.postMessage(msg, transfer);
  try {
    const result = await handleRequest(store, req as never, (stage, fraction) => post({ id, type: 'progress', stage, fraction }));
    post({ id, type: 'result', result }, transferablesOf(result));
  } catch (err) {
    post({ id, type: 'error', error: err instanceof Error ? err.message : 'Geometry worker error' });
  }
};
