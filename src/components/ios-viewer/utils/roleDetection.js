/*
 * roleDetection — figure out whether a 3D scan file is the upper jaw,
 * lower jaw, or an occlusion/bite scan based on its filename.
 *
 * Standard intraoral scanner output (Trios, iTero, Medit, Carestream,
 * exocad, 3Shape) ships per case as 3-5 STL/PLY/OBJ files. Naming is
 * inconsistent across vendors but a few patterns dominate:
 *
 *   upper:    upperjaw.stl, upper-jaw.stl, maxilla.stl, max.stl, U.stl,
 *             upperarch.stl, upper_arch.stl, maxillar.stl, top.stl
 *   lower:    lowerjaw.stl, lower-jaw.stl, mandible.stl, mand.stl, L.stl,
 *             lowerarch.stl, lower_arch.stl, mandibular.stl, bottom.stl
 *   occ/bite: occlusion.stl, occlusion1.stl, bite.stl, bite_left.stl,
 *             bite-r.stl, in_occlusion.stl, registered.stl
 *
 * Returns one of: 'maxilla' | 'mandible' | 'occlusion' | 'unknown'.
 */

const PATTERNS = [
  { role: 'maxilla',   regex: /(upper|maxill|max[\W_]|^max\.|\bmax_|\bU\b|\bU[\W_]|^U\.|top[\W_]|^top\.)/i },
  { role: 'mandible',  regex: /(lower|mandib|mand[\W_]|^mand\.|\bmand_|\bL\b|\bL[\W_]|^L\.|bottom[\W_]|^bottom\.)/i },
  { role: 'occlusion', regex: /(occlu|bite|registered|in[\W_]?occ|^occ\.|^bite\.)/i },
];

/**
 * Detect the role of a scan file from its filename.
 * @param {string} filename
 * @returns {'maxilla' | 'mandible' | 'occlusion' | 'unknown'}
 */
export function detectScanRole(filename) {
  if (!filename) return 'unknown';
  const base = filename.split(/[\\/]/).pop() || '';
  // Check occlusion FIRST so "in_occlusion_upper.stl" -> occlusion not maxilla
  if (PATTERNS[2].regex.test(base)) return 'occlusion';
  if (PATTERNS[0].regex.test(base)) return 'maxilla';
  if (PATTERNS[1].regex.test(base)) return 'mandible';
  return 'unknown';
}

/**
 * Visual styling per role. Used by MultiMeshModel to color and tone the
 * meshes so upper / lower / occlusion are distinguishable when overlaid.
 *
 * Colors picked to read like real teeth:
 *   - maxilla:   warm cream (slightly more pigmented, like upper teeth tend to read)
 *   - mandible:  cool ivory (slightly cooler/lighter, distinguishes from upper at a glance)
 *   - occlusion: neutral champagne (so it doesn't fight upper or lower)
 *   - unknown:   safe greige
 */
export const ROLE_STYLE = {
  // Upper warm, lower cool — deliberately distinct hues so that when the two
  // arches are loaded in occlusion (their native, co-registered position) the
  // bite line between them is actually visible instead of one fused blob.
  maxilla:   { color: '#E8D5B5', emissiveIntensity: 0.02, roughness: 0.55, label: 'Upper jaw' },
  mandible:  { color: '#BFD7E8', emissiveIntensity: 0.02, roughness: 0.55, label: 'Lower jaw' },
  occlusion: { color: '#D9CDB8', emissiveIntensity: 0.02, roughness: 0.6,  label: 'Occlusion' },
  unknown:   { color: '#D8CFC1', emissiveIntensity: 0.02, roughness: 0.6,  label: '3D scan' },
};

/**
 * Distinct colors for meshes whose role can't be read from the filename
 * (e.g. Fussen DentalFlex exports named TextureMesh<N>_<M>.obj). The scanner
 * exports every segment of a case in ONE shared coordinate frame, so they load
 * already registered to each other — but if they all render in the same color
 * you can't tell the arches apart or see where they meet. Giving each mesh its
 * own color makes the registered case readable without inventing clinical
 * roles (we deliberately do NOT guess maxilla vs mandible from geometry).
 *
 * Warm/cool alternating so the two most common arches read as clearly
 * different; soft, tooth-plausible tones throughout.
 */
export const UNKNOWN_PALETTE = [
  '#E8D5B5', // warm cream
  '#BFD7E8', // cool blue-ivory
  '#E6C7A8', // peach
  '#C9E0C4', // sage
  '#E2C6DE', // mauve
  '#D7D2BC', // olive-ivory
];

/**
 * Map role -> which viewerSettings visibility/opacity flag controls it.
 * Wires the per-mesh render to the existing toggle UI without needing
 * to add new state shape.
 */
export const ROLE_TO_SETTING = {
  maxilla:   { visible: 'maxillaVisible',   opacity: 'maxillaOpacity'   },
  mandible:  { visible: 'mandibleVisible',  opacity: 'mandibleOpacity'  },
  occlusion: { visible: 'occlusionVisible', opacity: 'occlusionOpacity' },
  // Unknown uses the maxilla toggle as a sensible default (one mesh, one toggle).
  unknown:   { visible: 'maxillaVisible',   opacity: 'maxillaOpacity'   },
};
