/*
 * Non-serialisable workbench objects: the geometry worker client, the
 * per-version three.js geometries (with BVH for picking), version stores,
 * and the pane registry used for camera linking and PNG capture.
 */
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { GeometryEngine } from '../engine/engineClient';
import type { MeshPayload } from '../engine/protocol';
import { VersionStore } from '../core/versions';
import { SessionPersistence } from '../core/persistence';
import type { Slot } from './store';

export interface VersionGfx {
  key: string;
  /** natural appearance (file colours / texture) */
  natural: THREE.BufferGeometry;
  /** same buffers, with a separate colour attribute for analysis maps */
  mapped: THREE.BufferGeometry;
  mapColor: THREE.BufferAttribute;
  displayToTopo: Uint32Array | null;
  topoVertices: number;
  topoTriangles: number;
  hasColors: boolean;
  hasUvs: boolean;
  bvh: MeshBVH;
  texture: THREE.Texture | null;
}

let engine: GeometryEngine | null = null;
export function getEngine(): GeometryEngine {
  if (!engine) engine = new GeometryEngine();
  return engine;
}
export function resetEngine(): void {
  engine?.terminate();
  engine = null;
}

const gfx = new Map<string, VersionGfx>();
const versionStores = new Map<Slot, VersionStore>();
export const persistence = new SessionPersistence();

export function versionStore(slot: Slot): VersionStore {
  let s = versionStores.get(slot);
  if (!s) { s = new VersionStore(slot); versionStores.set(slot, s); }
  return s;
}

export function clearSlot(slot: Slot): void {
  for (const key of [...gfx.keys()]) if (key.startsWith(`${slot}.`)) {
    const g = gfx.get(key)!;
    g.natural.dispose(); g.mapped.dispose(); g.texture?.dispose();
    gfx.delete(key);
  }
  versionStores.delete(slot);
}

export function getGfx(key: string | null | undefined): VersionGfx | undefined {
  return key ? gfx.get(key) : undefined;
}

export function registerGfx(key: string, payload: MeshPayload): VersionGfx {
  const natural = new THREE.BufferGeometry();
  const pos = new THREE.BufferAttribute(payload.positions, 3);
  const nrm = new THREE.BufferAttribute(payload.normals, 3);
  const idx = new THREE.BufferAttribute(payload.indices, 1);
  natural.setAttribute('position', pos);
  natural.setAttribute('normal', nrm);
  natural.setIndex(idx);
  if (payload.colors) natural.setAttribute('color', new THREE.BufferAttribute(payload.colors, 3));
  if (payload.uvs) natural.setAttribute('uv', new THREE.BufferAttribute(payload.uvs, 2));
  const mapped = new THREE.BufferGeometry();
  mapped.setAttribute('position', pos);
  mapped.setAttribute('normal', nrm);
  mapped.setIndex(idx);
  const mapColor = new THREE.BufferAttribute(new Float32Array(payload.positions.length), 3);
  mapColor.setUsage(THREE.DynamicDrawUsage);
  mapped.setAttribute('color', mapColor);
  const bvh = MeshBVH.deserialize(
    { version: 1, roots: payload.bvh.roots, index: null, indirectBuffer: payload.bvh.indirectBuffer } as never,
    natural, { setIndex: false },
  );
  (natural as unknown as { boundsTree: MeshBVH }).boundsTree = bvh;
  (mapped as unknown as { boundsTree: MeshBVH }).boundsTree = bvh;
  natural.computeBoundingBox(); natural.computeBoundingSphere();
  mapped.boundingBox = natural.boundingBox; mapped.boundingSphere = natural.boundingSphere;
  const entry: VersionGfx = {
    key, natural, mapped, mapColor, displayToTopo: payload.displayToTopo,
    topoVertices: payload.topoVertices, topoTriangles: payload.topoTriangles,
    hasColors: !!payload.colors, hasUvs: !!payload.uvs, bvh, texture: null,
  };
  gfx.set(key, entry);
  return entry;
}

export function attachTexture(key: string, url: string, onReady: () => void): void {
  const entry = gfx.get(key);
  if (!entry || !entry.hasUvs) return;
  new THREE.TextureLoader().load(url, (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    entry.texture = tex;
    onReady();
  });
}

/* ---------------- panes: camera link + capture ---------------- */

export interface PaneHandle {
  id: 'left' | 'right';
  camera: THREE.OrthographicCamera;
  controls: { target: THREE.Vector3; update: () => void; addEventListener: (t: string, f: () => void) => void; removeEventListener: (t: string, f: () => void) => void };
  invalidate: () => void;
  capture: () => HTMLCanvasElement;
  canvas: HTMLCanvasElement;
  scene: THREE.Scene;
}

const panes = new Map<'left' | 'right', PaneHandle>();
let syncing = false;

export function registerPane(h: PaneHandle): () => void {
  panes.set(h.id, h);
  return () => { if (panes.get(h.id) === h) panes.delete(h.id); };
}

export function getPane(id: 'left' | 'right'): PaneHandle | undefined {
  return panes.get(id);
}

/**
 * Copy the view direction, up vector and zoom from `src` to the other pane,
 * keeping each pane's own orbit target (so upper/lower panes can each stay
 * centred on their own arch while rotating together).
 */
export function syncCameras(src: 'left' | 'right'): void {
  if (syncing) return;
  const a = panes.get(src);
  const b = panes.get(src === 'left' ? 'right' : 'left');
  if (!a || !b) return;
  syncing = true;
  try {
    const offset = a.camera.position.clone().sub(a.controls.target);
    b.camera.position.copy(b.controls.target).add(offset);
    b.camera.up.copy(a.camera.up);
    b.camera.zoom = a.camera.zoom;
    b.camera.lookAt(b.controls.target);
    b.camera.updateProjectionMatrix();
    b.controls.update();
    b.invalidate();
  } finally {
    syncing = false;
  }
}

/* ---------------- mesh objects per pane (for lasso projection) ---------------- */
const meshObjects = new Map<string, THREE.Mesh>();
export function setPaneMesh(pane: 'left' | 'right', slot: Slot, mesh: THREE.Mesh | null): void {
  const k = `${pane}:${slot}`;
  if (mesh) meshObjects.set(k, mesh);
  else meshObjects.delete(k);
}
export function paneMesh(pane: 'left' | 'right', slot: Slot): THREE.Mesh | undefined {
  return meshObjects.get(`${pane}:${slot}`);
}
