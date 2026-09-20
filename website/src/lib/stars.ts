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

export function generateStars(options: { seed?: number; count?: number; width: number; skyBottom: number }): Star[] {
  const { seed = 20260920, count = 170, width, skyBottom } = options;
  const rnd = mulberry32(seed);
  const stars: Star[] = [];
  // Milky Way axis: from lower-left to upper-right of the sky region.
  const axis = (x: number) => skyBottom * 0.85 - (x / width) * skyBottom * 0.55;
  for (let i = 0; i < count; i += 1) {
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
    stars.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, r: Math.round(r * 100) / 100, o: Math.round(o * 100) / 100, bright });
  }
  return stars;
}

export function starsToSvg(stars: Star[], className = "st"): string {
  return stars
    .map((s) => {
      const core = `<circle cx="${s.x}" cy="${s.y}" r="${s.r}" class="${className}" style="--o:${s.o};--tw:${((s.x * 7 + s.y * 13) % 30) / 10}s"/>`;
      if (!s.bright) return core;
      const len = s.r * 3.2;
      return `${core}<path d="M${s.x - len} ${s.y}H${s.x + len}M${s.x} ${s.y - len}V${s.y + len}" class="${className}-spark" style="--o:${s.o}"/>`;
    })
    .join("");
}
