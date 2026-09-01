import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const stylesSource = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

for (const pageTitle of ['Research', 'Members', 'Publications', 'Gallery', 'Contact']) {
  assert.match(
    appSource,
    new RegExp(`renderSubHero\\('${pageTitle}'`),
    `${pageTitle} must keep using the shared subpage banner component.`,
  );
}

assert.match(
  stylesSource,
  /\.sub-hero\s*\{[^}]*height:\s*420px[^}]*overflow:\s*hidden[^}]*isolation:\s*isolate/,
  'Every desktop and tablet subpage banner must use one fixed height and clip its visual layers.',
);
assert.match(
  stylesSource,
  /\.sub-hero::before\s*\{[^}]*background:\s*var\(--hero-image\)\s+center\s*\/\s*cover\s+no-repeat[^}]*-webkit-mask-image:\s*linear-gradient\([^}]*mask-image:\s*linear-gradient\(/,
  'The subpage banner image must preserve arbitrary image proportions and fade both edges without repetition.',
);
assert.match(
  stylesSource,
  /\.sub-hero::after\s*\{[^}]*linear-gradient\(90deg,[^}]*rgba\(6,17,30,\.70\)\s+100%\)/,
  'The overlay must blend the right edge into the shared dark banner background.',
);
assert.match(
  stylesSource,
  /\.sub-hero p:not\(\.section-kicker\)\s*\{[^}]*max-width:\s*min\(620px,\s*100%\)[^}]*line-height:\s*1\.6/,
  'Long descriptions must wrap within the fixed banner instead of increasing its width or height.',
);
assert.match(
  stylesSource,
  /@media \(max-width:\s*620px\)\s*\{[\s\S]*?\.sub-hero\s*\{[^}]*height:\s*390px/,
  'Every mobile subpage banner must use the same mobile fixed height.',
);

console.log('Subpage banner consistency contract passed.');
