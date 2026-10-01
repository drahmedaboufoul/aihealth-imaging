// Only these fixed, reviewed public meshes may bypass clinical authentication.
// Ignore study, path, id and share selectors in this mode.
// One rigid pose for both arches preserves the captured bite registration.
const LECTURE_POSE = Object.freeze([
  -0.9037192701, -0.4281143995, -0.0030889856, 26.5299299491,
  -0.0038472411, 0.0009059831, 0.9999921889, -4.9558442969,
  -0.4281082569, 0.9037240951, -0.0024658137, -17.7561938222,
  0, 0, 0, 1,
]);
export const LECTURE_FILES = Object.freeze([
  Object.freeze({ url: '/lecture/teaching-color-upper.ply', fileName: 'Upper.ply', fileType: 'ply', matrix: LECTURE_POSE }),
  Object.freeze({ url: '/lecture/teaching-color-lower.ply', fileName: 'Lower.ply', fileType: 'ply', matrix: LECTURE_POSE }),
]);

export function isLectureFixture(params) {
  return params.get('lecture') === '1';
}
