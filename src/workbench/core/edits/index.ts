/*
 * Edit dispatcher. Every operation is a pure function of (parent mesh,
 * params) -> new mesh, so re-running it reproduces the same output hash.
 */
import type { MeshData } from '../types';
import { isRigid } from '../mat4';
import { transformMesh } from '../meshData';
import type { SpatialMesh } from '../spatial';
import { trimByLasso, trimByPlane, type EditOutput, type LassoTrimParams, type PlaneTrimParams } from './trim';
import { fillHoles, type FillHolesParams } from './fillHoles';
import { decimate, type DecimateParams } from './decimate';
import { smoothMesh, type SmoothParams } from './smooth';

export type EditRequest =
  | { op: 'trim-plane'; params: PlaneTrimParams }
  | { op: 'trim-lasso'; params: LassoTrimParams }
  | { op: 'fill-holes'; params: FillHolesParams }
  | { op: 'decimate'; params: DecimateParams }
  | { op: 'smooth'; params: SmoothParams }
  | { op: 'apply-transform'; params: { matrix: number[]; acceptedBy: string; acceptedAt: string } };

export function applyEdit(mesh: MeshData, req: EditRequest, spatial?: SpatialMesh | null): EditOutput {
  switch (req.op) {
    case 'trim-plane': return trimByPlane(mesh, req.params);
    case 'trim-lasso': return trimByLasso(mesh, req.params, spatial);
    case 'fill-holes': return fillHoles(mesh, req.params);
    case 'decimate': return decimate(mesh, req.params);
    case 'smooth': return smoothMesh(mesh, req.params);
    case 'apply-transform': {
      if (!isRigid(req.params.matrix)) throw new Error('Only rigid (accepted alignment) transforms can be applied.');
      if (!req.params.acceptedBy) throw new Error('An alignment must be accepted by a named person before it is applied.');
      return { mesh: transformMesh(mesh, req.params.matrix), stats: { triangles: mesh.indices.length / 3 } };
    }
    default: {
      const never: never = req;
      throw new Error(`Unknown edit ${(never as { op: string }).op}`);
    }
  }
}

export type { EditOutput } from './trim';
