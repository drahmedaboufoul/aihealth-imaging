// Fussen OBJ exports can use byte RGB (0–255), while OBJLoader expects sRGB
// fractions (0–1). Normalise BEFORE the loader's sRGB-to-linear conversion;
// dividing its already-converted geometry colours would still be incorrect.
const VERTEX_RGB = /^([ \t]*v[ \t]+\S+[ \t]+\S+[ \t]+\S+[ \t]+)(\S+)([ \t]+)(\S+)([ \t]+)(\S+)([^\r\n]*)$/gm;

export function normalizeObjVertexColors(source) {
  let byteRange = false;
  let valid = true;
  for (const match of source.matchAll(VERTEX_RGB)) {
    const channels = [Number(match[2]), Number(match[4]), Number(match[6])];
    if (channels.some(v => !Number.isFinite(v) || v < 0 || v > 255)) { valid = false; break; }
    if (channels.some(v => v > 1)) byteRange = true;
  }
  // Preserve ordinary fractional-colour and uncoloured files byte-for-byte.
  // Do not guess a scale for an unknown colour encoding.
  if (!valid || !byteRange) return source;
  return source.replace(VERTEX_RGB, (_line, prefix, r, space1, g, space2, b, tail) =>
    `${prefix}${Number(r) / 255}${space1}${Number(g) / 255}${space2}${Number(b) / 255}${tail}`);
}
