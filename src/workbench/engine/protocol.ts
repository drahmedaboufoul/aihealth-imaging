/*
 * Messages between the workbench UI (main thread) and the geometry worker.
 * Mesh keys are the neutral version ids ("A.v0", "B.v3"). Nothing here is
 * ever sent over a network: the worker is same-origin and in-process.
 */
import type { IcpOptions, IcpResult } from '../core/icp';
import type { DeviationStats } from '../core/deviation';
import type { ContactResult, ContactThresholds } from '../core/contact';
import type { EditRequest } from '../core/edits';
import type { LassoSpec } from '../core/edits/trim';
import type { Plane, Vec3 } from '../core/types';
import type { Polyline3 } from '../core/section';

export interface MeshPayload {
  positions: Float32Array;
  indices: Uint32Array;
  normals: Float32Array;
  colors: Float32Array | null;
  uvs: Float32Array | null;
  /** display vertex -> topology vertex; null when display is the topology */
  displayToTopo: Uint32Array | null;
  /** serialised BVH over THIS display geometry (three-mesh-bvh, indirect) */
  bvh: { roots: ArrayBuffer[]; indirectBuffer: Uint32Array | null };
  /** topology vertex count (for overlay value arrays) */
  topoVertices: number;
  topoTriangles: number;
}

export interface LoadStats {
  sourceTriangles: number;
  triangles: number;
  vertices: number;
  degenerateDropped: number;
  boundaryEdges: number;
  closed: boolean;
  /** worker: SHA-256 of the source bytes */
  sourceHashMs: number;
  /** main thread: reading the file into memory (set by the page) */
  fileReadMs?: number;
  parseMs: number;
  weldMs: number;
  normalsMs: number;
  bvhMs: number;
  hashMs: number;
  topologyMs: number;
  payloadMs: number;
  totalMs: number;
}

export type WorkerRequest =
  /** `file` (a local File/Blob) is read inside the worker; `buffer` is used for fetched study files and tests. */
  | { kind: 'load'; key: string; name: string; format?: string; buffer?: ArrayBuffer; file?: Blob }
  | { kind: 'icp'; fixedKey: string; movingKey: string; initial: number[]; options?: IcpOptions }
  | { kind: 'deviation'; refKey: string; testKey: string; testToRef: number[]; maxDistance: number; invertSign?: boolean; bands: number[] }
  | { kind: 'contact'; upper: { key: string; matrix: number[] }; lower: { key: string; matrix: number[] }; thresholds: ContactThresholds; searchRadius?: number; invertSign?: boolean }
  | { kind: 'edit'; parentKey: string; key: string; request: EditRequest }
  | { kind: 'section'; items: { key: string; matrix: number[] }[]; plane: Plane }
  | { kind: 'surfacePath'; key: string; a: Vec3; b: Vec3; faceA?: number; faceB?: number }
  | { kind: 'area'; key: string; lasso: LassoSpec }
  | { kind: 'export'; key: string; format: 'stl' | 'ply' }
  | { kind: 'dispose'; key: string };

export interface LoadResult {
  key: string;
  mesh: MeshPayload;
  sourceSha256: string;
  outputSha256: string;
  /** PCA display orientation suggestion (column-major), or null when unsure */
  autoOrient: number[] | null;
  stats: LoadStats;
}

export interface EditResult {
  key: string;
  mesh: MeshPayload;
  outputSha256: string;
  stats: Record<string, number>;
}

export interface DeviationResultMsg {
  values: Float32Array;
  stats: DeviationStats;
  elapsedMs: number;
}

export type ContactResultMsg = ContactResult;

export interface SectionResult {
  /** per item, polylines in WORLD coordinates */
  items: { key: string; polylines: Polyline3[] }[];
}

export interface WorkerResultMap {
  load: LoadResult;
  icp: IcpResult;
  deviation: DeviationResultMsg;
  contact: ContactResultMsg;
  edit: EditResult;
  section: SectionResult;
  surfacePath: { length: number; graphLength: number; method: string; points: Vec3[] } | null;
  area: { area: number; triangles: number; mask: Uint8Array };
  export: { buffer: ArrayBuffer; sha256: string };
  dispose: { ok: true };
}

export type WorkerEnvelope =
  | { id: number; type: 'result'; result: unknown }
  | { id: number; type: 'error'; error: string }
  | { id: number; type: 'progress'; stage: string; fraction: number };
