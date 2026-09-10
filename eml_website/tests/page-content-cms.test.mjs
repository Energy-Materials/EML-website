import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateContent as validateNode } from '../tools/content-core.mjs';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const [dataText, browserText, workerText, appText, adminText, adminHtml] = await Promise.all([
  read('../data/site-data.json'),
  read('../data-validation.js'),
  read('../functions/api/content.js'),
  read('../app.js'),
  read('../admin.js'),
  read('../admin.html'),
]);
const canonical = JSON.parse(dataText);

function topFunction(source, name, indent = '  ') {
  const start = source.indexOf(`${indent}function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist.`);
  const end = source.indexOf(`\n${indent}function `, start + 1);
  return source.slice(start, end < 0 ? source.length : end);
}

const browserWindow = {};
const browserValidator = new Function(
  'window',
  'URL',
  `${browserText}\nreturn window.EMLDataSchema.validate;`,
)(browserWindow, URL);

const importMarker = "from './auth/session.js';";
const workerBodyStart = workerText.indexOf(importMarker) + importMarker.length;
const workerBodyEnd = workerText.lastIndexOf('export {');
assert.ok(workerBodyStart >= importMarker.length && workerBodyEnd > workerBodyStart);
const workerExecutable = workerText.slice(workerBodyStart, workerBodyEnd)
  .replace('export async function onRequest', 'async function onRequest');
const workerValidator = new Function(`${workerExecutable}\nreturn validateContent;`)();

const fullPageContent = {
  home: {
    research: { smallLabel: 'Research Focus', title: 'Our Research', subtitle: 'Battery science', description: 'Description', buttonText: 'View Research' },
    publicationsPreview: { smallLabel: 'Publication', title: 'Recent Publications', buttonText: 'View Publications' },
    galleryPreview: { smallLabel: 'Gallery', title: 'Laboratory Gallery', buttonText: 'View Gallery' },
  },
  research: {
    banner: { smallLabel: 'EML', title: 'Research', description: 'Description' },
    topicTabLabel: 'Research Topic',
    statement: { title: 'Research Statement' },
    topics: { smallLabel: 'Research Topic', title: 'Materials\nand interfaces' },
  },
  members: { banner: { smallLabel: 'EML', title: 'Members', description: 'Description' } },
  publications: { banner: { smallLabel: 'EML', title: 'Publications', description: 'Description' } },
  gallery: {
    banner: { smallLabel: 'EML', title: 'Gallery', description: 'Description' },
    section: { smallLabel: 'Lab Gallery', title: 'Click a card\nto view photos', description: 'Description' },
  },
  contact: {
    banner: { smallLabel: 'EML', title: 'Contact', description: 'Description' },
    section: { smallLabel: 'Contact', title: 'Get in touch' },
  },
};

assert.deepEqual(Object.keys(canonical.pageContent).sort(), Object.keys(fullPageContent).sort());
const absent = Symbol('absent');
const cases = [
  ['legacy missing', absent, true],
  ['empty optional object', {}, true],
  ['partial Home', { home: { research: { title: 'Custom' } } }, true],
  ['partial Research', { research: { topicTabLabel: '' } }, true],
  ['complete schema', fullPageContent, true],
  ['null root', null, false],
  ['array root', [], false],
  ['unknown page', { about: {} }, false],
  ['unknown section', { home: { hero: {} } }, false],
  ['unknown field', { gallery: { section: { caption: 'x' } } }, false],
  ['wrong section type', { members: { banner: [] } }, false],
  ['wrong field type', { contact: { section: { title: 42 } } }, false],
];

for (const [label, pageContent, expected] of cases) {
  const candidate = structuredClone(canonical);
  if (pageContent === absent) delete candidate.pageContent;
  else candidate.pageContent = structuredClone(pageContent);
  const results = {
    browser: browserValidator(candidate),
    node: validateNode(candidate),
    worker: workerValidator(candidate),
  };
  assert.deepEqual(
    Object.fromEntries(Object.entries(results).map(([key, result]) => [key, result.valid])),
    { browser: expected, node: expected, worker: expected },
    `${label}: all three validators must agree.`,
  );
  if (!expected) {
    for (const result of Object.values(results)) {
      assert.ok(result.errors.some((error) => /pageContent/i.test(error)), `${label} must identify pageContent.`);
    }
  }
}

const defaultStart = appText.indexOf('  const DEFAULT_PAGE_CONTENT =');
const defaultEnd = appText.indexOf('  function escapeHTML', defaultStart);
assert.ok(defaultStart >= 0 && defaultEnd > defaultStart);
const resolver = (data) => new Function(
  'data',
  `${appText.slice(defaultStart, defaultEnd)}\n${topFunction(appText, 'nestedValue')}\n${topFunction(appText, 'pageContentText')}\nreturn pageContentText;`,
)(data);
assert.equal(resolver({ pageContent: { home: { research: { title: 'CMS' } } } })(['home', 'research', 'title'], 'Legacy'), 'CMS');
assert.equal(resolver({})(['home', 'research', 'title'], 'Legacy'), 'Legacy');
assert.equal(resolver({})(['home', 'research', 'title']), 'Our Research');

const escapes = new Function(
  `${topFunction(appText, 'escapeHTML')}\n${topFunction(appText, 'escapeMultilineHTML')}\nreturn { escapeHTML, escapeMultilineHTML };`,
)();
assert.equal(escapes.escapeHTML('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;');
assert.equal(escapes.escapeMultilineHTML('A\n<img src=x>'), 'A<br />&lt;img src=x&gt;');

const publicPaths = [
  ['home', 'research', 'smallLabel'], ['home', 'research', 'title'], ['home', 'research', 'subtitle'],
  ['home', 'research', 'description'], ['home', 'research', 'buttonText'],
  ['home', 'publicationsPreview', 'smallLabel'], ['home', 'publicationsPreview', 'title'], ['home', 'publicationsPreview', 'buttonText'],
  ['home', 'galleryPreview', 'smallLabel'], ['home', 'galleryPreview', 'title'], ['home', 'galleryPreview', 'buttonText'],
  ['research', 'topicTabLabel'], ['research', 'statement', 'title'], ['research', 'topics', 'smallLabel'], ['research', 'topics', 'title'],
  ['gallery', 'section', 'smallLabel'], ['gallery', 'section', 'title'], ['gallery', 'section', 'description'],
  ['contact', 'section', 'smallLabel'], ['contact', 'section', 'title'],
];
for (const path of publicPaths) {
  const call = `pageContentText([${path.map((part) => `'${part}'`).join(', ')}])`;
  const index = appText.indexOf(call);
  assert.notEqual(index, -1, `app.js must read ${path.join('.')}.`);
  assert.match(
    appText.slice(Math.max(0, index - 36), index),
    /renderRich(?:Multiline)?Text\($/,
    `${path.join('.')} must use the restricted rich-text renderer.`,
  );
}
const subHero = topFunction(appText, 'renderSubHero');
for (const field of ['smallLabel', 'title', 'description']) {
  assert.ok(subHero.includes(`pageContentText([pageKey, 'banner', '${field}']`));
}
for (const value of ['smallLabel', 'bannerTitle', 'description']) assert.ok(subHero.includes(`renderRichText(${value})`));

assert.match(adminHtml, /data-section="pageContent"/);
assert.match(adminText, /pageContent\s*:\s*renderPageContent/);
assert.match(adminText, /function renderPageContent\(/);
assert.match(adminText, /data-page-content-tabs/);
for (const path of publicPaths) {
  const dotted = `pageContent.${path.join('.')}`;
  assert.ok(adminText.includes(dotted), `admin.js must bind ${dotted}.`);
}
const bannerEditor = topFunction(adminText, 'renderPageContentBanner');
for (const field of ['smallLabel', 'title', 'description']) {
  assert.ok(bannerEditor.includes(`pageContent.\${pageKey}.banner.${field}`));
}
for (const key of ['research', 'members', 'publications', 'gallery', 'contact']) {
  assert.match(adminText, new RegExp(`\\{ key: ['"]${key}['"], title:`));
}
for (const path of ['home.eyebrow', 'home.subtitleKr', 'home.ctaPrimary', 'home.ctaSecondary', 'home.ctaSecondaryRoute', 'home.titleLines', 'home.intro']) {
  assert.ok(adminText.includes(`'${path}'`), `Existing ${path} editor must remain available.`);
}
assert.match(topFunction(adminText, 'renderPageContentResearch'), /contentTextareaField\(['"]researchStatement['"]/);
assert.match(topFunction(adminText, 'renderPageContentContact'), /contentTextareaField\(['"]site\.joinMessage['"]/);
assert.doesNotMatch(topFunction(adminText, 'renderPageContentHome'), /home\.ctaSecondaryRoute/);

console.log('Page Content CMS schema, fallback, safe rich rendering, and editor contract passed.');
