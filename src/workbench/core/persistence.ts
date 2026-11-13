/*
 * Persistence contract for the IOS workbench.
 *
 * v1 keeps everything in the browser session and offers JSON export/import
 * only (no network, no database). A later milestone (M1: scan_assets,
 * scan_versions, lab_case_* tables in the clinic project) implements this
 * same interface server-side; the workbench UI only talks to the interface.
 *
 * Hard rules carried by the types:
 *   - originals are referenced by their SHA-256, never rewritten;
 *   - derived versions carry parent, op, params and output SHA-256;
 *   - automatic results are drafts until `accepted` names a person.
 */
import type { VersionRecord } from './versions';
import type { MeasurementRecord, MeasurementsFile } from './measurements';
import type { Mat4 } from './types';
import { buildMeasurementsFile } from './measurements';

/** Opaque reference to a case/scan set. Never a patient name. */
export interface CaseRef {
  /** e.g. an imaging study id when opened from the clinic system, or "local". */
  kind: 'study' | 'local';
  id: string | null;
}

export interface Acceptance {
  acceptedBy: string;
  acceptedAt: string;
}

export interface AlignmentRecord {
  movingSlot: string;
  fixedSlot: string;
  /** moving-local -> fixed-local */
  matrix: Mat4;
  method: 'landmarks' | 'icp' | 'landmarks+icp';
  report: { rms: number; iterations?: number; converged?: boolean; landmarkRms?: number };
  status: 'draft' | 'accepted';
  accepted?: Acceptance;
  movingVersionSha256: string;
  fixedVersionSha256: string;
}

export interface ContactMapRecord {
  upperSlot: string;
  lowerSlot: string;
  thresholds: { contact: number; near: number; close: number };
  summary: Record<string, number>;
  status: 'draft' | 'accepted';
  accepted?: Acceptance;
  upperVersionSha256: string;
  lowerVersionSha256: string;
}

export interface WorkbenchPersistence {
  saveMeasurements(caseRef: CaseRef, measurements: MeasurementRecord[]): Promise<void>;
  loadMeasurements(caseRef: CaseRef): Promise<MeasurementRecord[]>;
  saveVersion(caseRef: CaseRef, record: VersionRecord): Promise<void>;
  saveAlignment(caseRef: CaseRef, record: AlignmentRecord): Promise<void>;
  saveContactMap(caseRef: CaseRef, record: ContactMapRecord): Promise<void>;
}

/** v1 implementation: in-memory for the life of the tab. */
export class SessionPersistence implements WorkbenchPersistence {
  private measurements = new Map<string, MeasurementRecord[]>();
  readonly versions: VersionRecord[] = [];
  readonly alignments: AlignmentRecord[] = [];
  readonly contactMaps: ContactMapRecord[] = [];

  private key(c: CaseRef): string {
    return `${c.kind}:${c.id ?? ''}`;
  }

  async saveMeasurements(caseRef: CaseRef, measurements: MeasurementRecord[]): Promise<void> {
    this.measurements.set(this.key(caseRef), measurements.map((m) => ({ ...m })));
  }

  async loadMeasurements(caseRef: CaseRef): Promise<MeasurementRecord[]> {
    return (this.measurements.get(this.key(caseRef)) ?? []).map((m) => ({ ...m }));
  }

  async saveVersion(_caseRef: CaseRef, record: VersionRecord): Promise<void> {
    if (!this.versions.some((v) => v.id === record.id && v.outputSha256 === record.outputSha256)) this.versions.push(record);
  }

  async saveAlignment(_caseRef: CaseRef, record: AlignmentRecord): Promise<void> {
    this.alignments.push(JSON.parse(JSON.stringify(record)));
  }

  async saveContactMap(_caseRef: CaseRef, record: ContactMapRecord): Promise<void> {
    this.contactMaps.push(JSON.parse(JSON.stringify(record)));
  }

  exportMeasurementsFile(caseRef: CaseRef, now?: Date): MeasurementsFile {
    return buildMeasurementsFile(this.measurements.get(this.key(caseRef)) ?? [], now);
  }
}
