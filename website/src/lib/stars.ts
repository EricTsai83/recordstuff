/**
 * Deterministic star field for the hero scene. A seeded generator keeps the
 * build reproducible while the distribution looks natural: a dense diagonal
 * band (the Milky Way) over a sparse, clumpy background, sizes on a power law,
 * a few bright stars with four-point sparkle.
 */
export interface Star {
  x: number;
  y: number;
  r: number;
  o: number;
  bright: boolean;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Coordinates go into the page's SVG: two decimals are finer than a pixel, and float noise only adds bytes. */
const round = (value: number, places = 2): number => Math.round(value * 10 ** places) / 10 ** places;

export function generateStars(options: { seed?: number; width: number; skyBottom: number }): Star[] {
  const { seed = 20260920, width, skyBottom } = options;
  const rnd = mulberry32(seed);
  const stars: Star[] = [];
  // Milky Way axis: from lower-left to upper-right of the sky region.
  const axis = (x: number) => skyBottom * 0.85 - (x / width) * skyBottom * 0.55;
  // 170 draws; those outside the sky are skipped.
  for (let i = 0; i < 170; i += 1) {
    const inBand = rnd() < 0.55;
    const x = rnd() * width;
    let y: number;
    if (inBand) {
      // Gaussian-ish spread around the band axis.
      const spread = (rnd() + rnd() + rnd() - 1.5) * 90;
      y = axis(x) + spread;
    } else {
      y = rnd() * skyBottom;
    }
    if (y < 60 || y > skyBottom) continue;
    // Power-law radius: many tiny stars, few large.
    const u = rnd();
    const r = 0.35 + Math.pow(u, 3) * 1.9;
    const bright = r > 1.7 && rnd() < 0.6;
    const o = inBand ? 0.35 + rnd() * 0.5 : 0.25 + rnd() * 0.6;
    stars.push({ x: round(x, 1), y: round(y, 1), r: round(r), o: round(o), bright });
  }
  return stars;
}

export function starsToSvg(stars: Star[]): string {
  return stars
    .map((s) => {
      const core = `<circle cx="${s.x}" cy="${s.y}" r="${s.r}" class="st" style="--o:${s.o}"/>`;
      if (!s.bright) return core;
      const len = s.r * 3.2;
      return `${core}<path d="M${round(s.x - len)} ${s.y}H${round(s.x + len)}M${s.x} ${round(s.y - len)}V${round(s.y + len)}" class="st-spark" style="--o:${s.o}"/>`;
    })
    .join("");
}
