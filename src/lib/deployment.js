/*
 * deployment — which backend this build serves. The same code ships as two Vercel projects:
 *
 *   default                      aiHealth Imaging for the AIHMC EMR: the EMR's Supabase project,
 *                                this app's CBCT viewer, shares via /api/imaging-share-resolve.
 *   VITE_IMAGING_BACKEND=kyour   the kyour imaging cloud: kyour's Supabase project and kyour's
 *                                CBCT viewer (MPR/3D/pano/implant/TMJ/ceph, AI read with AI
 *                                tokens), partner launch links (Dental Lab OS) and shares via
 *                                kyour's imaging-partner edge function.
 */
export const KYOUR_BACKEND = import.meta.env.VITE_IMAGING_BACKEND === 'kyour';
