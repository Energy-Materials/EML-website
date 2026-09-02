import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

import { validateContent } from '../tools/content-core.mjs';

const [appSource, adminSource, stylesSource, adminStylesSource, browserSchemaSource, canonicalJson] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../admin.js', import.meta.url), 'utf8'),
  readFile(new URL('../styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../admin.css', import.meta.url), 'utf8'),
  readFile(new URL('../data-validation.js', import.meta.url), 'utf8'),
  readFile(new URL('../data/site-data.json', import.meta.url), 'utf8'),
]);
const canonical = JSON.parse(canonicalJson);

function extractTopLevelFunction(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `Missing ${name}().`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Could not extract ${name}().`);
}

const publicDisplayHelpers = new Function(`
  const defaultImageDisplay = Object.freeze({ positionX: 50, positionY: 50, zoom: 1 });
  ${extractTopLevelFunction(appSource, 'clampImageDisplayNumber')}
  ${extractTopLevelFunction(appSource, 'normalizeImageDisplay')}
  ${extractTopLevelFunction(appSource, 'imageDisplayStyle')}
  return { normalizeImageDisplay, imageDisplayStyle };
`)();

assert.deepEqual(publicDisplayHelpers.normalizeImageDisplay(null), { positionX: 50, positionY: 50, zoom: 1 });
assert.deepEqual(publicDisplayHelpers.normalizeImageDisplay({ positionX: '0', positionY: null, zoom: true }), { positionX: 50, positionY: 50, zoom: 1 });
assert.deepEqual(publicDisplayHelpers.normalizeImageDisplay({ positionX: -2, positionY: 140, zoom: 8 }), { positionX: 0, positionY: 100, zoom: 4 });
assert.equal(
  publicDisplayHelpers.imageDisplayStyle({ positionX: 75, positionY: 25, zoom: 2 }),
  '--image-translate-x:25%;--image-translate-y:-25%;--image-zoom:2',
);
assert.equal(
  publicDisplayHelpers.imageDisplayStyle({ positionX: 100, positionY: 0, zoom: 1 }),
  '--image-translate-x:0%;--image-translate-y:0%;--image-zoom:1',
  'At the default zoom the full image must remain centered regardless of stored position.',
);

const browserSandbox = { window: {}, URL };
vm.runInNewContext(browserSchemaSource, browserSandbox);
const validateBrowser = (value) => browserSandbox.window.EMLDataSchema.validate(value);
assert.equal(validateContent(canonical).valid, true, 'Legacy content without display metadata must remain valid locally.');
assert.equal(validateBrowser(canonical).valid, true, 'Legacy content without display metadata must remain valid in the CMS.');

const configured = structuredClone(canonical);
configured.professor.photoDisplay = { positionX: 44, positionY: 28, zoom: 1.25 };
configured.members[0].photoDisplay = { positionX: 63.5, positionY: 51, zoom: 2.1 };
configured.gallery[0].imageDisplays = configured.gallery[0].images.map((_, index) => ({
  positionX: index === 0 ? 75 : 50,
  positionY: index === 0 ? 30 : 50,
  zoom: index === 0 ? 2 : 1,
}));
assert.equal(validateContent(configured).valid, true);
assert.equal(validateBrowser(configured).valid, true);

const invalidCases = [];
const mismatched = structuredClone(configured);
mismatched.gallery[0].imageDisplays.pop();
invalidCases.push(mismatched);
const partial = structuredClone(configured);
partial.members[0].photoDisplay = { positionX: 50, positionY: 50 };
invalidCases.push(partial);
const unsupported = structuredClone(configured);
unsupported.professor.photoDisplay.crop = true;
invalidCases.push(unsupported);
const outOfRange = structuredClone(configured);
outOfRange.gallery[0].imageDisplays[0].zoom = 4.1;
invalidCases.push(outOfRange);
const wrongType = structuredClone(configured);
wrongType.members[0].photoDisplay.positionX = '50';
invalidCases.push(wrongType);
for (const invalid of invalidCases) {
  assert.equal(validateContent(invalid).valid, false);
  assert.equal(validateBrowser(invalid).valid, false);
}

assert.match(stylesSource, /\.image-display-frame\s*\{[^}]*aspect-ratio:\s*3\s*\/\s*4[^}]*overflow:\s*hidden/s);
assert.match(stylesSource, /\.image-display-frame img\s*\{[^}]*object-fit:\s*contain[^}]*var\(--image-translate-x[^}]*var\(--image-zoom/s);
assert.doesNotMatch(stylesSource, /\.gallery-card img\s*\{[^}]*object-fit:\s*cover/s);
assert.doesNotMatch(stylesSource, /\.member-card img\s*\{[^}]*object-fit:\s*cover/s);
assert.match(stylesSource, /\.lightbox-figure img\s*\{[^}]*object-fit:\s*contain/s);
assert.doesNotMatch(stylesSource, /gallery-card[^}]*:hover[^}]*img\s*\{[^}]*scale|gallery-card[^}]*:hover[^}]*img\s*\{[^}]*transform/s);

assert.match(appSource, /imageDisplayStyle\(p\.photoDisplay\)/);
assert.match(appSource, /imageDisplayStyle\(m\.photoDisplay\)/);
assert.match(appSource, /imageDisplayStyle\(galleryImageDisplay\(item, 0\)\)/);
const lightboxUpdate = extractTopLevelFunction(appSource, 'updateLightbox');
assert.doesNotMatch(lightboxUpdate, /imageDisplay|imageDisplays/, 'The detail modal must show the unmodified original image.');

assert.match(adminStylesSource, /\.image-display-preview\s*\{[^}]*aspect-ratio:\s*3\s*\/\s*4/s);
assert.match(adminStylesSource, /\.image-display-preview > img\s*\{[^}]*object-fit:\s*contain/s);
assert.match(adminSource, /data-image-display-control="zoom"/);
assert.match(adminSource, /data-image-display-control="positionX"/);
assert.match(adminSource, /data-image-display-control="positionY"/);
assert.match(adminSource, /preview\.setPointerCapture\(event\.pointerId\)/);
assert.match(adminSource, /data-image-display-reset/);
assert.match(adminSource, /setPath\(displaysPath, nextDisplays\)/);
assert.match(adminSource, /displays\.splice\(index, 1\)/);
assert.match(adminSource, /const \[movedDisplay\] = displays\.splice\(dragImage\.index, 1\)/);
assert.match(adminSource, /photoDisplay: freshImageDisplay\(\)/);
assert.match(adminSource, /imageDisplays: \[\]/);

console.log('Gallery and Members 3:4 image framing, CMS controls, and validation contract passed.');
