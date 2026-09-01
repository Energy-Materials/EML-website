import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { collectAssetPaths, validateContent, validateReferencedAssets } from '../tools/content-core.mjs';

const pageKeys = ['research', 'members', 'publications', 'gallery', 'contact'];
const expectedBannerRoutes = [
  { route: 'research', renderer: 'renderResearch', title: 'Research', key: 'research' },
  { route: 'members', renderer: 'renderMembers', title: 'Members', key: 'members' },
  { route: 'publications', renderer: 'renderPublications', title: 'Publications', key: 'publications' },
  { route: 'gallery', renderer: 'renderGallery', title: 'Gallery', key: 'gallery' },
  { route: 'contact', renderer: 'renderContact', title: 'Contact', key: 'contact' },
];
const canonical = JSON.parse(await readFile(new URL('../data/site-data.json', import.meta.url), 'utf8'));
const [appSource, adminSource, adminHtml, stylesSource] = await Promise.all([
  readFile(new URL('../app.js', import.meta.url), 'utf8'),
  readFile(new URL('../admin.js', import.meta.url), 'utf8'),
  readFile(new URL('../admin.html', import.meta.url), 'utf8'),
  readFile(new URL('../styles.css', import.meta.url), 'utf8'),
]);

assert.deepEqual(Object.keys(canonical.site.subHeroImages).sort(), [...pageKeys].sort());
pageKeys.forEach((key) => assert.equal(canonical.site.subHeroImages[key], '', `${key} must initially use the shared default banner.`));

assert.match(appSource, /function renderSubHero\(title, desc, pageKey\)/);
assert.match(appSource, /const defaultHeroImage = asset\(s\.heroImage, 'assets\/hero-concept-from-pdf\.png'\);\s*const heroImage = asset\(s\.subHeroImages\?\.\[pageKey\], defaultHeroImage\);/);

const renderMapBody = appSource.match(/const renderMap = \{([\s\S]*?)\n\s*\};/)?.[1];
assert.ok(renderMapBody, 'The route renderer map must remain discoverable.');
const routeRenderers = Object.fromEntries(
  [...renderMapBody.matchAll(/^\s*([a-z]+):\s*(render[A-Z][A-Za-z]+),?\s*$/gm)].map((match) => [match[1], match[2]])
);

function extractTopLevelFunction(name) {
  const start = appSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist.`);
  const next = appSource.indexOf('\n  function ', start + 1);
  return appSource.slice(start, next === -1 ? appSource.length : next);
}

for (const expected of expectedBannerRoutes) {
  assert.equal(routeRenderers[expected.route], expected.renderer, `#${expected.route} must use ${expected.renderer}.`);
  const rendererSource = extractTopLevelFunction(expected.renderer);
  const calls = [...rendererSource.matchAll(/renderSubHero\(\s*'([^']*)'\s*,\s*'[^']*'\s*,\s*'([^']*)'\s*\)/g)]
    .map((match) => ({ title: match[1], key: match[2] }));
  assert.deepEqual(
    calls,
    [{ title: expected.title, key: expected.key }],
    `${expected.renderer} must render exactly one banner with the matching title and page key.`
  );
}

assert.match(adminHtml, /data-section="banners"[^>]*>Subpage Banners</);
assert.match(adminSource, /banners:\s*renderBanners/);
assert.match(adminSource, /site\.subHeroImages\.\$\{page\.key\}/);
assert.match(adminSource, /data-upload-reset/);
assert.match(adminSource, /setPath\(path, resetValue\);\s*markDirty\(\);\s*renderPreservingPosition\(\);/);
pageKeys.forEach((key) => assert.match(adminSource, new RegExp(`key: '${key}'`)));
assert.match(stylesSource, /\.sub-hero::before\s*\{[^}]*center\s*\/\s*cover\s+no-repeat/);

const legacy = structuredClone(canonical);
delete legacy.site.subHeroImages;
assert.equal(validateContent(legacy).valid, true, 'Legacy content without per-page banners must remain valid.');
assert.ok(collectAssetPaths(legacy).includes(legacy.site.heroImage), 'Legacy content must keep collecting the shared hero image.');

const partial = structuredClone(legacy);
partial.site.subHeroImages = { research: 'assets/gallery-placeholder-1.svg' };
assert.equal(validateContent(partial).valid, true, 'A partial page override object must remain backward compatible.');
assert.ok(collectAssetPaths(partial).includes('assets/gallery-placeholder-1.svg'));

const allOverrides = structuredClone(canonical);
const expectedOverrideAssets = pageKeys.map((key) => `assets/subhero-${key}.png`);
pageKeys.forEach((key, index) => {
  allOverrides.site.subHeroImages[key] = expectedOverrideAssets[index];
});
const collectedOverrideAssets = collectAssetPaths(allOverrides).filter((assetPath) => expectedOverrideAssets.includes(assetPath));
assert.deepEqual(
  collectedOverrideAssets.sort(),
  [...expectedOverrideAssets].sort(),
  'Asset collection must include every page-specific banner key.'
);

const missingOverrides = structuredClone(canonical);
const missingOverrideAssets = pageKeys.map((key) => `assets/missing-subhero-${key}.png`);
pageKeys.forEach((key, index) => {
  missingOverrides.site.subHeroImages[key] = missingOverrideAssets[index];
});
const missingOverrideErrors = await validateReferencedAssets(missingOverrides);
missingOverrideAssets.forEach((assetPath) => {
  assert.ok(
    missingOverrideErrors.some((error) => error.includes(assetPath)),
    `Local validation must reject a missing ${assetPath} banner asset.`
  );
});

const renderSubHeroSource = extractTopLevelFunction('renderSubHero');
const makeRenderSubHero = new Function(
  'data',
  'asset',
  'escapeAttr',
  'escapeHTML',
  `${renderSubHeroSource}; return renderSubHero;`
);
const assetStub = (value, fallback = '') => String(value || '').trim() || fallback;
const identity = (value) => String(value);
const renderBannerWith = (site, pageKey = 'research') => {
  const renderSubHero = makeRenderSubHero({ site }, assetStub, identity, identity);
  return renderSubHero('Research', 'Description', pageKey);
};

assert.match(
  renderBannerWith({ heroImage: 'assets/shared.png', subHeroImages: { research: 'assets/research.png' } }),
  /--hero-image: url\('assets\/research\.png'\)/,
  'A page-specific image must take priority over the shared hero.'
);
assert.match(
  renderBannerWith({ heroImage: 'assets/shared.png', subHeroImages: { research: '' } }),
  /--hero-image: url\('assets\/shared\.png'\)/,
  'An empty page override must fall back to the shared hero.'
);
assert.match(
  renderBannerWith({ heroImage: 'assets/shared.png', subHeroImages: { research: 'assets/research.png' } }, 'members'),
  /--hero-image: url\('assets\/shared\.png'\)/,
  'A missing key in a partial override object must fall back to the shared hero.'
);
assert.match(
  renderBannerWith({ heroImage: 'assets/legacy-shared.png' }),
  /--hero-image: url\('assets\/legacy-shared\.png'\)/,
  'Legacy data without subHeroImages must fall back to the shared hero.'
);
assert.match(
  renderBannerWith({ heroImage: '' }),
  /--hero-image: url\('assets\/hero-concept-from-pdf\.png'\)/,
  'Missing legacy hero data must fall back to the built-in banner image.'
);

const unsupported = structuredClone(canonical);
unsupported.site.subHeroImages.news = 'assets/gallery-placeholder-1.svg';
assert.equal(validateContent(unsupported).valid, false, 'Unknown subpage keys must be rejected.');

const unsafe = structuredClone(canonical);
unsafe.site.subHeroImages.research = '../outside.png';
assert.equal(validateContent(unsafe).valid, false, 'Subpage banners must stay below assets/.');

console.log('Subpage banner CMS contract passed.');
