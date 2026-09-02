import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const htmlSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const stylesSource = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');

const mediaMarkup = htmlSource.match(/<div class="lightbox-media">([\s\S]*?)<\/div>/)?.[1] || '';
assert.match(mediaMarkup, /<button class="lightbox-close"[^>]*data-lightbox-close[^>]*><\/button>/);
assert.match(
  mediaMarkup,
  /<button class="lightbox-nav prev"[^>]*data-lightbox-prev[^>]*>[\s\S]*?<svg class="lightbox-nav-icon"[^>]*>[\s\S]*?<\/svg>\s*<\/button>/,
  'The previous button must use one measurable, centered SVG icon.',
);
assert.match(
  mediaMarkup,
  /<button class="lightbox-nav next"[^>]*data-lightbox-next[^>]*>[\s\S]*?<svg class="lightbox-nav-icon"[^>]*>[\s\S]*?<\/svg>\s*<\/button>/,
  'The next button must use one measurable, centered SVG icon.',
);
assert.doesNotMatch(mediaMarkup, /[‹›]/, 'Legacy text glyphs must not create an extra grid row.');
assert.match(mediaMarkup, /<path d="M6\.5 1\.5 1\.5 6l5 4\.5" \/>/, 'The previous glyph must be symmetric around x=4 and y=6.');
assert.match(mediaMarkup, /<path d="M1\.5 1\.5 6\.5 6l-5 4\.5" \/>/, 'The next glyph must be symmetric around x=4 and y=6.');
assert.ok(
  mediaMarkup.indexOf('lightbox-close') < mediaMarkup.indexOf('data-lightbox-image'),
  'The close control must remain the first control inside the visible media panel.',
);
assert.doesNotMatch(
  htmlSource,
  /<div class="lightbox-dialog"[^>]*>\s*<button class="lightbox-close"/,
  'The close control must not float against the transparent lightbox dialog.',
);

assert.match(
  stylesSource,
  /\.modal-close\s*\{[^}]*width:\s*48px[^}]*height:\s*48px/s,
  'The regular content modal close button must remain unchanged.',
);
assert.match(
  stylesSource,
  /\.lightbox-close\s*\{[^}]*right:\s*12px[^}]*top:\s*12px[^}]*width:\s*34px[^}]*height:\s*34px/s,
  'The desktop Gallery close control must be compact and equally inset from the media corner.',
);
assert.match(
  stylesSource,
  /\.lightbox-close::before,\s*\.lightbox-close::after\s*\{[^}]*left:\s*50%[^}]*top:\s*50%[^}]*width:\s*13px[^}]*height:\s*1\.5px/s,
  'The thin close glyph must be constructed around the exact control center.',
);
assert.match(stylesSource, /\.lightbox-close::before\s*\{[^}]*translate\(-50%,\s*-50%\)[^}]*rotate\(45deg\)/s);
assert.match(stylesSource, /\.lightbox-close::after\s*\{[^}]*translate\(-50%,\s*-50%\)[^}]*rotate\(-45deg\)/s);

assert.match(
  stylesSource,
  /\.lightbox-nav\s*\{[^}]*inset-block:\s*0[^}]*width:\s*36px[^}]*height:\s*36px[^}]*margin-block:\s*auto/s,
  'Both arrows must center automatically against the media block rather than a viewport offset.',
);
assert.match(
  stylesSource,
  /\.lightbox-nav-icon\s*\{[^}]*width:\s*8px[^}]*height:\s*12px[^}]*display:\s*block[^}]*fill:\s*none[^}]*stroke:\s*currentColor[^}]*stroke-width:\s*1\.5/s,
  'The centered SVG arrow must stay visually secondary and thin.',
);
assert.doesNotMatch(stylesSource, /\.lightbox-nav::before\s*\{/);
assert.match(
  stylesSource,
  /@media \(max-width:\s*620px\)[\s\S]*?\.lightbox-close\s*\{[^}]*width:\s*32px[^}]*height:\s*32px[^}]*\}[\s\S]*?\.lightbox-nav\s*\{[^}]*width:\s*36px[^}]*height:\s*36px/s,
  'Mobile controls must remain compact without changing the lightbox layout.',
);

assert.match(appSource, /overlay\.querySelector\('\.lightbox-close'\)/);
assert.match(appSource, /event\.target\.closest\('\[data-lightbox-close\]'\)/);
assert.match(appSource, /\[data-lightbox-prev\][^\n]*nextLightbox\(-1\)/);
assert.match(appSource, /\[data-lightbox-next\][^\n]*nextLightbox\(1\)/);

console.log('Gallery lightbox control size, placement, and interaction contract passed.');
