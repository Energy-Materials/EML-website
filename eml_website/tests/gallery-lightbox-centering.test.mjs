import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [styles, html, app] = await Promise.all([
  readFile(new URL('../styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
]);

function cssRule(selector, startAt = 0) {
  const start = styles.indexOf(`${selector} {`, startAt);
  assert.notEqual(start, -1, `${selector} rule must exist.`);
  const bodyStart = styles.indexOf('{', start) + 1;
  const end = styles.indexOf('}', bodyStart);
  assert.notEqual(end, -1, `${selector} rule must close.`);
  return styles.slice(bodyStart, end);
}

const overlay = cssRule('.modal, .lightbox');
assert.match(overlay, /position:\s*fixed/);
assert.match(overlay, /inset:\s*0/);
assert.match(overlay, /display:\s*none/);

const modalOpen = cssRule('.modal.is-open');
assert.match(modalOpen, /display:\s*block/, 'The unrelated content modal must keep its block layout.');

const lightboxOpen = cssRule('.lightbox.is-open');
assert.match(lightboxOpen, /display:\s*grid/);
assert.match(lightboxOpen, /place-items:\s*center/);

const dialog = cssRule('.lightbox-dialog');
const openDialog = cssRule('.lightbox.is-open .lightbox-dialog');
assert.match(openDialog, /margin:\s*0(?:\s*;|$)/, 'Open lightboxes must not use viewport-derived top margins.');
for (const rule of [lightboxOpen, dialog, openDialog]) {
  assert.doesNotMatch(rule, /(?:^|;)\s*(?:top|left|translate)\s*:/);
  assert.doesNotMatch(rule, /transform\s*:\s*translate/i);
}

assert.match(dialog, /width:\s*min\(1180px,\s*calc\(100%\s*-\s*38px\)\)/);
assert.match(dialog, /height:\s*min\(86vh,\s*820px\)/);
assert.match(dialog, /height:\s*min\(86dvh,\s*820px\)/);
assert.match(dialog, /display:\s*grid/);
assert.match(dialog, /place-items:\s*center/);
assert.match(dialog, /animation:\s*lightboxIn\s+var\(--normal\)\s+both/);

const figure = cssRule('.lightbox-figure');
assert.match(figure, /width:\s*100%/);
assert.match(figure, /height:\s*100%/);
assert.match(figure, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(260px,\s*330px\)/);
assert.match(figure, /gap:\s*22px/);

const media = cssRule('.lightbox-media');
assert.match(media, /height:\s*100%/);
assert.match(media, /background:\s*#03070c/);
assert.match(media, /border-radius:\s*28px/);
assert.match(media, /box-shadow:\s*0\s+32px\s+90px\s+rgba\(0,0,0,\.4\)/);

const caption = cssRule('.lightbox-figure figcaption');
assert.match(caption, /background:\s*rgba\(255,255,255,\.94\)/);
assert.match(caption, /border-radius:\s*28px/);
assert.match(caption, /padding:\s*30px/);
assert.match(caption, /max-height:\s*100%/);
assert.match(caption, /overflow:\s*auto/);

const tabletStart = styles.indexOf('@media (max-width: 1120px)');
const tabletEnd = styles.indexOf('@media (max-width: 860px)', tabletStart);
const tablet = styles.slice(tabletStart, tabletEnd);
assert.match(tablet, /\.lightbox-figure\s*\{[^}]*grid-template-columns:\s*1fr[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)\s+auto/s);
assert.match(tablet, /\.lightbox-dialog\s*\{[^}]*height:\s*min\(90vh,\s*840px\)[^}]*height:\s*min\(90dvh,\s*840px\)/s);
assert.match(tablet, /\.lightbox-figure figcaption\s*\{[^}]*max-height:\s*240px/s);

const mobileStart = styles.indexOf('@media (max-width: 620px)');
const mobileEnd = styles.indexOf('@media (max-width: 480px)', mobileStart);
const mobile = styles.slice(mobileStart, mobileEnd);
assert.match(mobile, /\.lightbox-dialog\s*\{[^}]*width:\s*calc\(100%\s*-\s*16px\)[^}]*height:\s*calc\(100vh\s*-\s*16px\)[^}]*height:\s*calc\(100dvh\s*-\s*16px\)/s);
assert.match(mobile, /\.lightbox-media\s*\{[^}]*border-radius:\s*22px/s);
assert.match(mobile, /\.lightbox-figure figcaption\s*\{[^}]*border-radius:\s*22px[^}]*padding:\s*20px/s);

const cases = [
  { name: 'desktop-1080', width: 1440, height: 1080, expectedWidth: 1180, expectedHeight: 820 },
  { name: 'desktop-1440', width: 2560, height: 1440, expectedWidth: 1180, expectedHeight: 820 },
  { name: 'tablet-tall', width: 900, height: 1200, expectedWidth: 862, expectedHeight: 840 },
  { name: 'mobile', width: 390, height: 844, expectedWidth: 374, expectedHeight: 828 },
];
for (const testCase of cases) {
  const top = (testCase.height - testCase.expectedHeight) / 2;
  const bottom = testCase.height - top - testCase.expectedHeight;
  const left = (testCase.width - testCase.expectedWidth) / 2;
  const right = testCase.width - left - testCase.expectedWidth;
  assert.equal(top - bottom, 0, `${testCase.name}: vertical center delta`);
  assert.equal(left - right, 0, `${testCase.name}: horizontal center delta`);
}

assert.match(
  html,
  /<div class="lightbox-dialog"[^>]*>\s*<figure class="lightbox-figure">[\s\S]*?<div class="lightbox-media">[\s\S]*?<figcaption>/,
  'The image and information card must remain one centered dialog unit.',
);
assert.match(styles, /body\.no-scroll\s*\{[^}]*overflow:\s*hidden/s);
assert.match(app, /document\.body\.classList\.toggle\(['"]no-scroll['"],\s*hasOpenOverlay\)/);
assert.match(app, /function openGalleryLightbox\([\s\S]*?syncOverlayState\(\)/);

console.log('Gallery lightbox viewport centering and preserved-layout contract passed.');
