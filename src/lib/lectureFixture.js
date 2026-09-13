// Only these fixed, reviewed public meshes may bypass clinical authentication.
// Ignore study, path, id and share selectors in this mode.
export const LECTURE_FILES = Object.freeze([
  Object.freeze({ url: '/lecture/teaching-upper.stl', fileName: 'Upper.stl', fileType: 'stl', matrix: [-1,0,0,0, 0,0,1,0, 0,1,0,0, 0,0,0,1] }),
  Object.freeze({ url: '/lecture/teaching-lower.stl', fileName: 'Lower.stl', fileType: 'stl', matrix: [-1,0,0,0, 0,0,1,0, 0,1,0,0, 0,0,0,1] }),
]);

export function isLectureFixture(params) {
  return params.get('lecture') === '1';
}
