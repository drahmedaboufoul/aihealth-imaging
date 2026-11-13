/*
 * In-memory version lineage for one scan slot.
 *
 * Rules (owner's brief):
 *   - the original (v0) is immutable and can never be replaced or removed;
 *   - every edit creates a NEW version with a parent link, the operation,
 *     its parameters, a SHA-256 of the output geometry and a SHA-256 of
 *     {op, params, parent output hash};
 *   - nothing here talks to a network or database. `toPersistable()` gives
 *     the plain records a later scan_versions table (M1) can store.
 */
import { canonicalJson, sha256OfText } from './hash';

export type EditOp =
  | 'original'
  | 'trim-plane'
  | 'trim-lasso'
  | 'fill-holes'
  | 'decimate'
  | 'smooth'
  | 'apply-transform';

export interface VersionRecord {
  /** Neutral id: `<slot>.v<index>` (no patient or file ids). */
  id: string;
  slot: string;
  index: number;
  parentId: string | null;
  op: EditOp;
  params: Record<string, unknown>;
  /** sha256(canonicalJson({op, params, parentOutputSha256})) */
  paramsSha256: string;
  /** sha256 of canonicalMeshParts(output) — see hash.ts */
  outputSha256: string;
  /** Original only: sha256 of the source file bytes as received. */
  sourceFileSha256?: string;
  vertices: number;
  triangles: number;
  createdAt: string;
  /** Operation statistics (holes filled, triangles removed, ...). */
  stats?: Record<string, number>;
}

export async function paramsHash(op: EditOp, params: Record<string, unknown>, parentOutputSha256: string | null): Promise<string> {
  return sha256OfText(canonicalJson({ op, params, parentOutputSha256 }));
}

export class VersionStore {
  private records: VersionRecord[] = [];
  constructor(readonly slot: string) {}

  get list(): readonly VersionRecord[] {
    return this.records;
  }

  get original(): VersionRecord | undefined {
    return this.records[0];
  }

  get(id: string): VersionRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  async addOriginal(input: { outputSha256: string; sourceFileSha256: string; vertices: number; triangles: number; params?: Record<string, unknown>; createdAt?: string }): Promise<VersionRecord> {
    if (this.records.length > 0) throw new Error('The original version already exists and is immutable.');
    const params = input.params ?? {};
    const record: VersionRecord = Object.freeze({
      id: `${this.slot}.v0`,
      slot: this.slot,
      index: 0,
      parentId: null,
      op: 'original' as const,
      params: Object.freeze({ ...params }),
      paramsSha256: await paramsHash('original', params, null),
      outputSha256: input.outputSha256,
      sourceFileSha256: input.sourceFileSha256,
      vertices: input.vertices,
      triangles: input.triangles,
      createdAt: input.createdAt ?? new Date().toISOString(),
    }) as VersionRecord;
    this.records.push(record);
    return record;
  }

  async addDerived(input: {
    parentId: string; op: Exclude<EditOp, 'original'>; params: Record<string, unknown>;
    outputSha256: string; vertices: number; triangles: number; stats?: Record<string, number>; createdAt?: string;
  }): Promise<VersionRecord> {
    const parent = this.get(input.parentId);
    if (!parent) throw new Error(`Unknown parent version ${input.parentId}`);
    const index = this.records.length;
    const record: VersionRecord = Object.freeze({
      id: `${this.slot}.v${index}`,
      slot: this.slot,
      index,
      parentId: parent.id,
      op: input.op,
      params: Object.freeze(JSON.parse(canonicalJson(input.params))),
      paramsSha256: await paramsHash(input.op, input.params, parent.outputSha256),
      outputSha256: input.outputSha256,
      vertices: input.vertices,
      triangles: input.triangles,
      createdAt: input.createdAt ?? new Date().toISOString(),
      stats: input.stats ? Object.freeze({ ...input.stats }) : undefined,
    }) as VersionRecord;
    this.records.push(record);
    return record;
  }

  /** Root-first chain of ids for a version. */
  lineage(id: string): string[] {
    const chain: string[] = [];
    let cur = this.get(id);
    const seen = new Set<string>();
    while (cur) {
      if (seen.has(cur.id)) throw new Error('Version lineage has a cycle.');
      seen.add(cur.id);
      chain.unshift(cur.id);
      cur = cur.parentId ? this.get(cur.parentId) : undefined;
    }
    return chain;
  }

  toPersistable(): VersionRecord[] {
    return this.records.map((r) => JSON.parse(JSON.stringify(r)));
  }
}

export interface LineageCheck { ok: boolean; problems: string[] }

/** Verify a set of records: one original, parents exist and precede, param hashes recompute. */
export async function verifyLineage(records: readonly VersionRecord[]): Promise<LineageCheck> {
  const problems: string[] = [];
  const byId = new Map(records.map((r) => [r.id, r]));
  const originals = records.filter((r) => r.op === 'original');
  if (originals.length !== 1) problems.push(`expected exactly one original, found ${originals.length}`);
  for (const r of records) {
    if (r.op === 'original') {
      if (r.parentId !== null) problems.push(`${r.id}: original must not have a parent`);
      if (!r.sourceFileSha256) problems.push(`${r.id}: original lacks the source file hash`);
      continue;
    }
    const parent = r.parentId ? byId.get(r.parentId) : undefined;
    if (!parent) { problems.push(`${r.id}: missing parent ${r.parentId}`); continue; }
    if (parent.index >= r.index) problems.push(`${r.id}: parent ${parent.id} is not older`);
    const expected = await paramsHash(r.op, r.params, parent.outputSha256);
    if (expected !== r.paramsSha256) problems.push(`${r.id}: parameter hash mismatch`);
    if (!/^[0-9a-f]{64}$/.test(r.outputSha256)) problems.push(`${r.id}: output hash is not SHA-256 hex`);
  }
  return { ok: problems.length === 0, problems };
}
