/*
 * Main-thread client for the geometry worker: promise-based requests with
 * progress callbacks. One worker per workbench page.
 */
import type { WorkerEnvelope, WorkerRequest, WorkerResultMap } from './protocol';

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (stage: string, fraction: number) => void;
};

export class GeometryEngine {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker = new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module', name: 'ios-geometry' });
    this.worker.onmessage = (e: MessageEvent<WorkerEnvelope>) => {
      const msg = e.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.type === 'progress') { p.onProgress?.(msg.stage, msg.fraction); return; }
      this.pending.delete(msg.id);
      if (msg.type === 'result') p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    };
    this.worker.onerror = (e) => {
      const err = new Error(e.message || 'Geometry worker failed');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  request<K extends WorkerRequest['kind']>(
    req: Extract<WorkerRequest, { kind: K }>,
    opts: { transfer?: Transferable[]; onProgress?: (stage: string, fraction: number) => void } = {},
  ): Promise<WorkerResultMap[K]> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress: opts.onProgress });
      this.worker.postMessage({ id, req }, opts.transfer ?? []);
    });
  }

  terminate(): void {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('Workbench closed'));
    this.pending.clear();
  }
}
