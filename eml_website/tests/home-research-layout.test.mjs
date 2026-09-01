import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const stylesSource = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

assert.doesNotMatch(
  appSource,
  /<button class="link-more"[^>]*>View More/,
  'Home research cards must not render individual View More buttons.',
);
assert.match(
  stylesSource,
  /\.research-card-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)[^}]*grid-auto-rows:\s*1fr[^}]*gap:\s*18px[^}]*padding-top:\s*31px/s,
  'The desktop home research cards must use an equal two-column, two-row grid aligned with the heading.',
);
assert.match(
  stylesSource,
  /@media \(max-width:\s*1120px\)\s*\{[\s\S]*?\.research-card-grid\s*\{[^}]*width:\s*min\(100%,\s*560px\)[^}]*grid-template-columns:\s*repeat\(2,/,
  'The stacked tablet layout must retain two columns without oversized cards.',
);
assert.match(
  stylesSource,
  /@media \(max-width:\s*620px\)\s*\{[\s\S]*?\.research-card-grid\s*\{[^}]*width:\s*min\(100%,\s*420px\)[^}]*grid-template-columns:\s*1fr/,
  'The mobile layout must collapse the research cards to one safe column.',
);

console.log('Home research layout contract passed.');
