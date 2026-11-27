/**
 * Mascot — a bumblebee in the spirit of the Honey Flowers logo (round fuzzy body, black and yellow
 * bands, an amber tail, translucent wings). The vector bee below is a PLACEHOLDER until our
 * illustrator (Мираслава) delivers the art.
 *
 * Swapping the art — no code changes: drop files into apps/miniapp/src/assets/mascot/ and rebuild:
 *   flying.(svg|png|webp)       — in flight: the bee over the honeycomb, onboarding
 *   sitting.(svg|png|webp)      — sitting: the level badge, quiet screens
 *   celebrating.(svg|png|webp)  — celebrating: gifts, a new level, the full card
 * Square canvas, transparent background, the bee centred, ~512×512 px (PNG/WebP) or any SVG.
 * A missing pose falls back to `flying`, then to the vector placeholder. See the folder's README.md.
 */

export type MascotPose = 'flying' | 'sitting' | 'celebrating';

// Bundled at build time (Vite): every image in the folder, by file name.
const files = import.meta.glob('../assets/mascot/*.{svg,png,webp}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const ART: Partial<Record<MascotPose, string>> = {};
for (const [path, url] of Object.entries(files)) {
  const pose = /\/(flying|sitting|celebrating)\.(svg|png|webp)$/.exec(path)?.[1] as MascotPose | undefined;
  if (pose) ART[pose] = url;
}
/** True when the illustrator's art is in the folder (any pose). */
export const hasMascotArt = Object.keys(ART).length > 0;

const WINGS_UP = `<ellipse class="wing" cx="-4" cy="-13" rx="7.5" ry="11" transform="rotate(-28 -4 -13)"/><ellipse class="wing b" cx="6" cy="-13" rx="6.5" ry="10" transform="rotate(22 6 -13)"/>`;
const WINGS_REST = `<ellipse class="wing rest" cx="-6" cy="-9" rx="10" ry="5.5" transform="rotate(-18 -6 -9)"/><ellipse class="wing rest b" cx="-2" cy="-10" rx="9" ry="5" transform="rotate(-6 -2 -10)"/>`;
// Body: ellipse rx 14, ry 11 at (0, 2); bands follow its outline (elliptical arcs).
const BODY = `<ellipse class="bee-fuzz" cx="0" cy="2" rx="15.2" ry="12.2"/>
  <ellipse class="bee-body" cx="0" cy="2" rx="14" ry="11"/>
  <path class="bee-tail" d="M-10 -5.7A14 11 0 0 0 -10 9.7Z"/>
  <path class="bee-band" d="M-7 -7.5A14 11 0 0 1 -2 -8.9L-2 12.9A14 11 0 0 1 -7 11.5Z"/>
  <path class="bee-band" d="M4 -8.5A14 11 0 0 1 8 -7L8 11A14 11 0 0 1 4 12.5Z"/>
  <path class="bee-sting" d="M-14 2.2l-4 1.3 4 1.3"/>
  <circle class="bee-head" cx="15" cy="0" r="6.8"/><circle class="bee-eye" cx="17.6" cy="-1.6" r="1.7"/>
  <path class="bee-ant" d="M16 -6.2q1.5-5 5.5-6.3M13.4 -6.4q-.2-5 2.6-7.6"/>`;
const LEGS = `<path class="bee-leg" d="M-4 12.5l-1.5 4M1 13l0 4.2M6 12.5l1.5 4"/>`;
const SPARKS = `<path class="bee-spark" d="M-22 -16l1.6 3.4 3.4 1.6-3.4 1.6-1.6 3.4-1.6-3.4-3.4-1.6 3.4-1.6z"/><path class="bee-spark p" d="M22 -20l1.2 2.6 2.6 1.2-2.6 1.2-1.2 2.6-1.2-2.6-2.6-1.2 2.6-1.2z"/><circle class="bee-spark" cx="25" cy="8" r="1.6"/><circle class="bee-spark p" cx="-24" cy="6" r="1.3"/>`;

function vector(pose: MascotPose): string {
  if (pose === 'sitting') return `${WINGS_REST}${BODY}${LEGS}`;
  if (pose === 'celebrating') return `${SPARKS}${WINGS_UP}${BODY}<path class="bee-leg" d="M-2 12.8l-2.5 3.5M5 12.6l2.6 3.4"/>`;
  return `${WINGS_UP}${BODY}`;
}

/** The mascot as SVG markup centred at (0, 0), ~40 px wide at scale 1 — for use INSIDE an <svg>. */
export function mascotG(pose: MascotPose = 'flying', scale = 1): string {
  const url = ART[pose] ?? ART.flying;
  if (url) return `<g transform="scale(${scale})"><image href="${url}" x="-22" y="-22" width="44" height="44" preserveAspectRatio="xMidYMid meet"/></g>`;
  return `<g class="bumble ${pose}" transform="scale(${scale})">${vector(pose)}</g>`;
}

/** A standalone <svg> with the mascot (onboarding, empty states). */
export function mascotSvg(pose: MascotPose = 'flying', scale = 1, cls = ''): string {
  const w = Math.round(64 * scale);
  return `<svg viewBox="-30 -28 60 50" width="${w}" aria-hidden="true"><g class="${cls}">${mascotG(pose, 1)}</g></svg>`;
}
