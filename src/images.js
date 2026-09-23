'use strict';
/** Illustrations used when a product has no photo of its own. One per jewellery category, served as SVG. */

const GOLD = 'url(#g)';
const DEFS = `<defs>
  <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f7e39a"/><stop offset=".5" stop-color="#d4a017"/><stop offset="1" stop-color="#9a6508"/></linearGradient>
  <radialGradient id="bg" cx=".5" cy=".4" r=".8"><stop offset="0" stop-color="#fffaf0"/><stop offset="1" stop-color="#f1e3c4"/></radialGradient>
  <linearGradient id="gem" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#9fd3ff"/></linearGradient>
</defs><rect width="200" height="200" rx="16" fill="url(#bg)"/>`;

// opts: { stroke, dash, offset } — the stroke is a single attribute so the SVG stays valid XML.
const line = (d, w = 8, { stroke = GOLD, dash, offset } = {}) =>
  `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ''}${offset ? ` stroke-dashoffset="${offset}"` : ''}/>`;
const drop = (x, y, s = 1) => `<path transform="translate(${x} ${y}) scale(${s})" d="M0 -22 C 16 -2 18 8 18 14 A18 18 0 0 1 -18 14 C -18 8 -16 -2 0 -22Z" fill="${GOLD}" stroke="#9a6508" stroke-width="2"/>
  <circle cx="${x}" cy="${y + 12 * s}" r="${6 * s}" fill="url(#gem)" stroke="#9a6508" stroke-width="1.5"/>`;
const gem = (x, y, r = 14) => `<polygon points="${x},${y - r} ${x + r},${y} ${x},${y + r} ${x - r},${y}" fill="url(#gem)" stroke="#9a6508" stroke-width="3"/>`;

const SHAPES = {
  ring: () => `<circle cx="100" cy="120" r="42" fill="none" stroke="${GOLD}" stroke-width="13"/>${gem(100, 66, 17)}`,
  necklace: () => line('M36 52 Q100 196 164 52', 9) + line('M36 52 Q100 196 164 52', 4, { stroke: '#fff6d6', dash: '1 11' }) + drop(100, 142, 0.8),
  bangle: () => `<ellipse cx="100" cy="104" rx="66" ry="52" fill="none" stroke="${GOLD}" stroke-width="14"/><ellipse cx="100" cy="104" rx="66" ry="52" fill="none" stroke="#fff6d6" stroke-width="3" stroke-dasharray="2 10" stroke-linecap="round"/>`,
  churi: () => [70, 92, 114, 136].map((cy, i) => `<ellipse cx="100" cy="${cy}" rx="${58 - i * 2}" ry="26" fill="none" stroke="${GOLD}" stroke-width="7"/>`).join(''),
  pendant: () => line('M52 36 Q100 96 148 36', 5) + drop(100, 124, 1.3),  earrings: () => [64, 136].map((x) => `<path d="M${x - 22} 78 A22 22 0 0 1 ${x + 22} 78Z" fill="${GOLD}" stroke="#9a6508" stroke-width="2"/>
    <path d="M${x - 24} 82 L${x} 150 L${x + 24} 82Z" fill="${GOLD}" opacity=".9" stroke="#9a6508" stroke-width="2"/>
    <circle cx="${x}" cy="60" r="6" fill="${GOLD}"/><circle cx="${x}" cy="154" r="6" fill="url(#gem)" stroke="#9a6508" stroke-width="1.5"/>`).join(''),
  chain: () => line('M28 70 Q100 178 172 70', 11, { dash: '17 5' }) + line('M28 70 Q100 178 172 70', 3, { stroke: '#fff6d6', dash: '17 5' }),
  bracelet: () => `<ellipse cx="100" cy="106" rx="70" ry="38" fill="none" stroke="${GOLD}" stroke-width="10" stroke-dasharray="15 5" stroke-linecap="round"/>${gem(100, 68, 11)}`,
  mangalsutra: () => line('M38 46 Q100 184 162 46', 8, { stroke: '#2b1b17', dash: '1 10' }) + line('M38 46 Q100 184 162 46', 3, { stroke: '#d4a017', dash: '1 40', offset: '-9' }) + drop(100, 140, 0.9),
  nosepin: () => `<circle cx="100" cy="100" r="34" fill="${GOLD}" stroke="#9a6508" stroke-width="3"/><circle cx="100" cy="100" r="15" fill="url(#gem)" stroke="#9a6508" stroke-width="2"/><path d="M100 134 q4 30 24 34" fill="none" stroke="${GOLD}" stroke-width="5" stroke-linecap="round"/>`,
};

const ALIASES = { 'nose-pin': 'nosepin', earring: 'earrings' };
const slugify = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-');

function categorySvg(slug) {
  const key = ALIASES[slug] || slug;
  const shape = (SHAPES[key] || SHAPES.ring)();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">${DEFS}${shape}</svg>`;
}

module.exports = { categorySvg, slugify };
