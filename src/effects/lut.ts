/**
 * `.cube` LUT parser.
 *
 * Reads the Adobe/IRIDAS Cube format that every camera vendor ships its
 * LOG→Rec.709 conversions in (and that every grading tool exports). Both the 3D
 * form (`LUT_3D_SIZE`) and the 1D form (`LUT_1D_SIZE`) are accepted; a 1D table
 * is expanded to the equivalent 3D table on the way out, so the renderer only
 * ever samples a `sampler3D` and has one code path.
 *
 * The parser is deliberately lenient about the lines it does not need (`TITLE`,
 * `DOMAIN_MIN/MAX`, comments, blank lines) and strict about the ones it does: a
 * size it cannot find, or a data-point count that does not match the declared
 * size, is a hard error, because a half-read LUT would grade every frame wrong
 * without ever saying why. Domain is assumed 0..1 (the near-universal case);
 * declared domains are read past rather than remapped.
 */

/** A parsed LUT ready to become a `Lut`: a full N³ table of RGB triplets in 0..1. */
export interface ParsedCube {
  size: number;
  /** N³×3 floats, red fastest: entry (r,g,b) at (r + g*N + b*N*N)*3. */
  data: number[];
}

/** Thrown when a file is not a LUT we can use. The message is a translation key. */
export class LutParseError extends Error {
  constructor(readonly key: string) {
    super(key);
    this.name = 'LutParseError';
  }
}

/** Cube sizes we accept: below 2 is meaningless, above 128 is not a real LUT. */
const MIN_SIZE = 2;
const MAX_SIZE = 128;

export function parseCube(text: string): ParsedCube {
  let size3d = 0;
  let size1d = 0;
  // Data points as flat RGB triplets, in file order.
  const data: number[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const tokens = line.split(/\s+/);
    const head = tokens[0]!.toUpperCase();

    if (head === 'LUT_3D_SIZE') {
      size3d = Number(tokens[1]);
      continue;
    }
    if (head === 'LUT_1D_SIZE') {
      size1d = Number(tokens[1]);
      continue;
    }
    // Header keywords we don't act on (TITLE, DOMAIN_MIN, DOMAIN_MAX, LUT_3D_INPUT_RANGE…).
    // A keyword line's first token is non-numeric, which also skips it here.
    if (Number.isNaN(Number(head))) continue;

    // A data row: exactly three floats. Anything else is malformed.
    if (tokens.length < 3) throw new LutParseError('errors.lut.invalid');
    const r = Number(tokens[0]);
    const g = Number(tokens[1]);
    const b = Number(tokens[2]);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
      throw new LutParseError('errors.lut.invalid');
    }
    // Clamp defensively: a few LUTs carry out-of-range extrapolation points, and
    // the 8-bit texture the renderer builds cannot hold them anyway.
    data.push(clamp01(r), clamp01(g), clamp01(b));
  }

  if (size3d) {
    if (!inRange(size3d)) throw new LutParseError('errors.lut.invalid');
    if (data.length !== size3d * size3d * size3d * 3) {
      throw new LutParseError('errors.lut.invalid');
    }
    return { size: size3d, data };
  }

  if (size1d) {
    if (!inRange(size1d)) throw new LutParseError('errors.lut.invalid');
    if (data.length !== size1d * 3) throw new LutParseError('errors.lut.invalid');
    return { size: size1d, data: expand1dTo3d(size1d, data) };
  }

  throw new LutParseError('errors.lut.invalid');
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function inRange(n: number): boolean {
  return Number.isInteger(n) && n >= MIN_SIZE && n <= MAX_SIZE;
}

/**
 * Expand a 1D LUT (a per-channel response curve) into the 3D table the renderer
 * samples. Row i of a 1D `.cube` is the output triplet for input level i, read
 * per channel — so the red output at grid point (r,g,b) is the curve's red
 * column at r, the green at g, the blue at b. The result is a separable 3D LUT.
 */
function expand1dTo3d(n: number, curve: number[]): number[] {
  const out = new Array<number>(n * n * n * 3);
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const i = (r + g * n + b * n * n) * 3;
        out[i] = curve[r * 3]!; // red curve at r
        out[i + 1] = curve[g * 3 + 1]!; // green curve at g
        out[i + 2] = curve[b * 3 + 2]!; // blue curve at b
      }
    }
  }
  return out;
}
