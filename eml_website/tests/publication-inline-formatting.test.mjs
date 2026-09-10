import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateContent as validateNode } from '../tools/content-core.mjs';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const [
  appSource,
  adminSource,
  adminStyles,
  stylesSource,
  validationSource,
  workerSource,
  dataText,
] = await Promise.all([
  read('../app.js'),
  read('../admin.js'),
  read('../admin.css'),
  read('../styles.css'),
  read('../data-validation.js'),
  read('../functions/api/content.js'),
  read('../data/site-data.json'),
]);
const siteData = JSON.parse(dataText);

function extractTopLevelFunction(source, name, indent = '  ') {
  const signature = `${indent}function ${name}(`;
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${name} must exist as a top-level helper.`);
  const next = source.indexOf(`\n${indent}function `, start + signature.length);
  return source.slice(start, next === -1 ? source.length : next);
}

const helperNames = [
  'escapeHTML',
  'escapeAttr',
  'parseInlineFormatting',
  'renderInlineFormatting',
  'plainInlineText',
  'renderRichText',
  'renderRichMultilineText',
  'plainRichText',
];
const inlineHelpers = new Function(
  `const richTextFormatNames = Object.freeze(['strong', 'em', 'sup', 'sub']);\n`
  + `${helperNames.map((name) => extractTopLevelFunction(appSource, name)).join('\n')}\n`
  + `return { ${helperNames.join(', ')} };`,
)();
const {
  parseInlineFormatting,
  renderRichText,
  renderRichMultilineText,
  plainRichText,
} = inlineHelpers;

const allFormats = ['strong', 'em', 'sup', 'sub'];
const richSample = '<strong>Ji <em>Hyun</em> Um</strong> · H<sub>2</sub>O · Zn<sup>2+</sup>';
assert.equal(parseInlineFormatting(richSample, allFormats).valid, true);
assert.equal(renderRichText(richSample), richSample, 'All four supported formats must render without changing their scope.');
assert.equal(
  plainRichText(richSample),
  'Ji Hyun Um · H2O · Zn2+',
  'Search, accessible names, and plain-text summaries must exclude implementation tags.',
);
assert.equal(
  renderRichMultilineText('<em>In situ</em>\nCO<sub>2</sub>'),
  '<em>In situ</em><br />CO<sub>2</sub>',
  'The restricted multiline renderer must preserve line breaks without relaxing the tag allowlist.',
);
assert.equal(renderRichText('A & B'), 'A &amp; B', 'Unformatted text must remain HTML-escaped.');

for (const safeNested of [
  '<strong><em>selected words</em></strong>',
  '<em>Zn<sup>2+</sup></em>',
  '<strong>H<sub>2</sub>O</strong>',
]) {
  assert.equal(parseInlineFormatting(safeNested, allFormats).valid, true, `${safeNested} should be valid.`);
  assert.equal(renderRichText(safeNested), safeNested);
}

for (const unsafe of [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>X',
  '<strong onclick="alert(1)">Ji Hyun Um</strong>',
  '<a href="javascript:alert(1)">paper</a>',
  '<EM>uppercase is not canonical</EM>',
  '<strong>same <strong>tag</strong></strong>',
  'Zn<sup>2<sub>+</sub></sup>',
  '<em><strong>mismatched</em></strong>',
  'CO<sub>2</sup>',
  'A<em></em>B',
]) {
  const parsed = parseInlineFormatting(unsafe, allFormats);
  assert.equal(parsed.valid, false, `${unsafe} must fail the public rich-text parser.`);
  assert.doesNotMatch(parsed.html, /<(?:script|img|a)\b/i, 'Unsupported elements must never render as HTML.');
  assert.doesNotMatch(parsed.html, /<(?:strong|em|sup|sub)\s+[^>]*>/i, 'Allowed tags must never retain attributes.');
}

const publicationYear = new Function(
  `${extractTopLevelFunction(appSource, 'publicationYear')}; return publicationYear;`,
)();
const filterPublicationItems = new Function(
  'publicationYear',
  'plainRichText',
  'plainInlineText',
  `${extractTopLevelFunction(appSource, 'filterPublicationItems')}; return filterPublicationItems;`,
)(publicationYear, plainRichText, inlineHelpers.plainInlineText);
const formattedPapers = [
  {
    id: 'formatted',
    year: '2026',
    title: '<em>In situ</em> CO<sub>2</sub> conversion with Zn<sup>2+</sup>',
    authors: 'Alice, <strong>Ji Hyun Um</strong>',
    journal: '<em>Energy</em>',
    note: 'H<sub>2</sub>O',
    link_url: 'https://example.com/formatted',
  },
  {
    id: 'plain',
    year: '2025',
    title: 'Plain electrode study',
    authors: 'Another Author',
    journal: 'Chemistry',
    note: '',
    link_url: '',
  },
];
assert.deepEqual(
  filterPublicationItems(formattedPapers, 'all', 'in situ co2').map((item) => item.id),
  ['formatted'],
  'Search must match the visible title across adjacent rich-text runs.',
);
assert.deepEqual(
  filterPublicationItems(formattedPapers, '2026', 'ji hyun um').map((item) => item.id),
  ['formatted'],
  'Year filtering and visible-text search must continue to work together.',
);
assert.deepEqual(
  filterPublicationItems(formattedPapers, 'all', 'strong').map((item) => item.id),
  [],
  'Formatting tag names must not become searchable content.',
);

const externalLinkUrl = new Function(
  `${extractTopLevelFunction(appSource, 'externalLinkUrl')}; return externalLinkUrl;`,
)();
const renderPublicationExternalLink = new Function(
  'externalLinkUrl',
  'escapeAttr',
  'plainRichText',
  'plainInlineText',
  `${extractTopLevelFunction(appSource, 'renderPublicationExternalLink')}; return renderPublicationExternalLink;`,
)(externalLinkUrl, inlineHelpers.escapeAttr, plainRichText, inlineHelpers.plainInlineText);
const formattedLink = renderPublicationExternalLink(formattedPapers[0], '논문');
assert.match(formattedLink, /target="_blank"[^>]*rel="noopener noreferrer"/);
assert.match(formattedLink, /aria-label="논문 외부 링크: In situ CO2 conversion with Zn2\+ \(새 탭에서 열림\)"/);
assert.doesNotMatch(formattedLink.match(/aria-label="[^"]*"/)?.[0] || '', /(?:&lt;|<)\/?(?:strong|em|sup|sub)/i);

const paperRendererSource = extractTopLevelFunction(appSource, 'renderPaperList');
for (const field of ['title', 'authors', 'journal', 'note']) {
  assert.match(
    paperRendererSource,
    new RegExp(`renderRichText\\(\\s*pub\\.${field}`),
    `Paper ${field} must use the shared restricted renderer.`,
  );
}
const patentRendererSource = extractTopLevelFunction(appSource, 'renderPatentList');
for (const field of ['title', 'inventors']) {
  assert.match(
    patentRendererSource,
    new RegExp(`renderRichText\\(\\s*patent\\.${field}`),
    `Patent ${field} must use the shared restricted renderer.`,
  );
}

assert.match(appSource, /const richTextFormatNames\s*=\s*Object\.freeze\(\[['"]strong['"],\s*['"]em['"],\s*['"]sup['"],\s*['"]sub['"]\]\)/);
assert.match(appSource, /alt="\$\{escapeAttr\(plainRichText\(topic\.title\)\)\}"/);
assert.match(appSource, /alt="\$\{escapeAttr\(plainRichText\(m\.name\)\)\}"/);
assert.match(appSource, /img\.alt\s*=\s*plainRichText\(item\.title\)/);
assert.match(extractTopLevelFunction(appSource, 'filterPublicationItems'), /plainRichText\(item\?\.(?:title|authors|inventors|journal|note)\)/);
const lightboxSource = extractTopLevelFunction(appSource, 'updateLightbox');
assert.match(lightboxSource, /\[data-lightbox-title\][\s\S]*?\.innerHTML\s*=\s*renderRichText\(item\.title/);
assert.match(lightboxSource, /\[data-lightbox-meta\][\s\S]*?renderRichText\(item\.summary/);
assert.match(lightboxSource, /\[data-lightbox-body\][\s\S]*?\.innerHTML\s*=\s*renderRichText\(item\.body/);

assert.match(adminSource, /const richTextFormatNames\s*=\s*Object\.freeze\(\[['"]strong['"],\s*['"]em['"],\s*['"]sup['"],\s*['"]sub['"]\]\)/);
for (const format of ['strong', 'em', 'sup', 'sub']) {
  assert.match(adminSource, new RegExp(`\\b${format}:\\s*\\{`), `The toolbar must expose ${format}.`);
}
assert.match(adminSource, /data-rich-text-format="\$\{escapeAttr\(format\)\}"/);
for (const command of ['bold', 'italic', 'superscript', 'subscript']) {
  assert.match(adminSource, new RegExp(`['"]${command}['"]`), `The editor must map ${command} to a formatting action.`);
}
assert.match(adminSource, /data-rich-text-editor/);
assert.match(adminSource, /data-rich-text-toolbar/);
assert.match(adminSource, /contenteditable="true"/);
assert.match(adminSource, /role="textbox"/);
assert.match(adminSource, /aria-multiline="\$\{String\(multiline\)\}"/);
assert.match(adminSource, /role="toolbar"/);
assert.match(adminSource, /aria-pressed=/);
for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
  assert.match(adminSource, new RegExp(`['"]${key}['"]`), `The toolbar must support ${key} keyboard navigation.`);
}
assert.match(adminSource, /(?:event\.key\.toLowerCase\(\)|key)[\s\S]*?['"]b['"][\s\S]*?['"]i['"]/i);
assert.match(
  adminSource,
  /(?:paste|beforeinput)[\s\S]*?(?:text\/plain|textContent|insertText)/i,
  'Pasted web or Word markup must not bypass the restricted toolbar.',
);
assert.match(
  adminSource,
  /(?:getSelection|Selection)[\s\S]*?(?:cloneRange|Range)/,
  'Toolbar actions must preserve a partial selection when focus moves to a button.',
);
assert.match(adminSource, /function contentInputField\([\s\S]*?formats:\s*richTextFormatNames/);
assert.match(adminSource, /function contentTextareaField\([\s\S]*?formats:\s*richTextFormatNames/);
assert.match(adminSource, /function contentArrayField\([\s\S]*?formats:\s*richTextFormatNames/);
assert.match(
  adminStyles,
  /\.rich-text-format-button\s*\{[^}]*min-height\s*:\s*44px/s,
  'Formatting controls must retain a touch target of at least 44px.',
);
assert.match(adminStyles, /\.rich-text-editor em\s*\{[^}]*font-style\s*:\s*italic/);
assert.match(stylesSource, /\.app sup,[\s\S]*?\.site-footer sub\s*\{[^}]*vertical-align\s*:\s*baseline/);

const cmsRichFieldReferences = [
  "'site.labName'", "'site.labNameKr'", "'site.university'", "'site.universityKr'", "'site.address'", "'site.copyright'", "'site.joinMessage'",
  "'home.eyebrow'", "'home.subtitleKr'", "'home.ctaPrimary'", "'home.ctaSecondary'", "'home.titleLines'", "'home.intro'",
  "'researchStatement'", '`researchTopics.${i}.title`', '`researchTopics.${i}.short`', '`researchTopics.${i}.description`',
  "'professor.name'", "'professor.role'", "'professor.department'", "'professor.interest'", "'professor.education'", "'professor.experience'",
  '`members.${i}.name`', '`members.${i}.role`', '`members.${i}.period`', '`members.${i}.research`',
  '`alumni.${i}.name`', '`alumni.${i}.next`',
  '`publications.${i}.title`', '`publications.${i}.authors`', '`publications.${i}.journal`', '`publications.${i}.note`',
  '`patents.${i}.title`', '`patents.${i}.inventors`',
  '`gallery.${i}.title`', '`gallery.${i}.summary`', '`gallery.${i}.body`',
];
for (const reference of cmsRichFieldReferences) {
  assert.ok(adminSource.includes(reference), `${reference} must remain editable through the shared rich-text field helpers.`);
}

const browserWindow = {};
const browserValidator = new Function(
  'window',
  'URL',
  `${validationSource}\nreturn window.EMLDataSchema.validate;`,
)(browserWindow, URL);
const importMarker = "from './auth/session.js';";
const workerBodyStart = workerSource.indexOf(importMarker) + importMarker.length;
const workerBodyEnd = workerSource.lastIndexOf('export {');
assert.ok(workerBodyStart >= importMarker.length && workerBodyEnd > workerBodyStart);
const workerExecutable = workerSource.slice(workerBodyStart, workerBodyEnd)
  .replace('export async function onRequest', 'async function onRequest');
const workerValidator = new Function(`${workerExecutable}\nreturn validateContent;`)();

function setPath(target, path, value) {
  let current = target;
  path.slice(0, -1).forEach((key) => { current = current[key]; });
  current[path[path.length - 1]] = value;
}

function validateEveryLayer(candidate) {
  return {
    browser: browserValidator(candidate),
    node: validateNode(candidate),
    worker: workerValidator(candidate),
  };
}

function collectStringLeafPaths(value, prefix = []) {
  if (typeof value === 'string') return [prefix];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, nested]) => collectStringLeafPaths(nested, [...prefix, key]));
}

const semanticPaths = [
  ['researchStatement'],
  ...['labName', 'labNameKr', 'university', 'universityKr', 'address', 'copyright', 'joinMessage'].map((field) => ['site', field]),
  ...['eyebrow', 'subtitleKr', 'tagline', 'intro', 'ctaPrimary', 'ctaSecondary'].map((field) => ['home', field]),
  ['home', 'titleLines', 0],
  ...['name', 'role', 'department'].map((field) => ['professor', field]),
  ...['interest', 'education', 'experience'].map((field) => ['professor', field, 0]),
  ...['title', 'short', 'description'].map((field) => ['researchTopics', 0, field]),
  ...['name', 'role', 'period', 'research'].map((field) => ['members', 0, field]),
  ...['name', 'next'].map((field) => ['alumni', 0, field]),
  ...['title', 'authors', 'journal', 'note'].map((field) => ['publications', 0, field]),
  ...['title', 'inventors'].map((field) => ['patents', 0, field]),
  ...['title', 'summary', 'body'].map((field) => ['gallery', 0, field]),
  ...collectStringLeafPaths(siteData.pageContent, ['pageContent']),
];
const validMarkup = '<strong><em>Energy</em></strong> H<sub>2</sub>O Zn<sup>2+</sup>';
for (const path of semanticPaths) {
  const label = path.join('.');
  const candidate = structuredClone(siteData);
  setPath(candidate, path, validMarkup);
  const results = validateEveryLayer(candidate);
  for (const [layer, result] of Object.entries(results)) {
    assert.equal(result.valid, true, `${layer} validation must accept all four formats in ${label}: ${result.errors?.join(' ')}`);
  }

  const unsafeCandidate = structuredClone(siteData);
  setPath(unsafeCandidate, path, '<img src=x onerror=alert(1)>');
  const unsafeResults = validateEveryLayer(unsafeCandidate);
  for (const [layer, result] of Object.entries(unsafeResults)) {
    assert.equal(result.valid, false, `${layer} validation must reject HTML outside the allowlist in ${label}.`);
  }
}

for (const invalidMarkup of [
  '<strong class="professor">Ji Hyun Um</strong>',
  '<strong>Ji <strong>Hyun</strong> Um</strong>',
  'Zn<sup>2<sub>+</sub></sup>',
  '<em><strong>bad close</em></strong>',
  '<script>alert(1)</script>',
  '<sup>\u200b</sup>',
  'A'.repeat(20001),
]) {
  const candidate = structuredClone(siteData);
  candidate.researchTopics[0].title = invalidMarkup;
  const results = validateEveryLayer(candidate);
  for (const [layer, result] of Object.entries(results)) {
    assert.equal(result.valid, false, `${layer} validation must reject ${invalidMarkup.slice(0, 60)}.`);
    assert.ok(result.errors.some((error) => /researchTopics\.0\.title/.test(error)));
  }
}

assert.equal(
  siteData.researchTopics.find((topic) => plainRichText(topic.title) === 'In situ/Operando Analysis')?.title,
  '<em>In situ</em>/Operando Analysis',
  'The requested Research title must store only “In situ” as italic markup.',
);

console.log('Site-wide inline formatting, CMS coverage, validation, safe rendering, search, and accessibility contracts passed.');
