import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const adminSource = await readFile(new URL('../admin.js', import.meta.url), 'utf8');
const adminStyles = await readFile(new URL('../admin.css', import.meta.url), 'utf8');
const validationSource = await readFile(new URL('../data-validation.js', import.meta.url), 'utf8');
const siteData = JSON.parse(await readFile(new URL('../data/site-data.json', import.meta.url), 'utf8'));

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
];

const inlineHelpers = new Function(
  `${helperNames.map((name) => extractTopLevelFunction(appSource, name)).join('\n')}\n`
  + `return { ${helperNames.join(', ')} };`,
)();

const { parseInlineFormatting, renderInlineFormatting, plainInlineText } = inlineHelpers;
const authorFormats = ['strong'];
const titleFormats = ['sup', 'sub'];

assert.ok(
  parseInlineFormatting('Alice, <strong>Ji Hyun Um</strong>, Bob', authorFormats),
  'The parser must accept a partially bold author list.',
);
assert.equal(
  renderInlineFormatting('Alice, <strong>Ji Hyun Um</strong>, Bob', authorFormats),
  'Alice, <strong>Ji Hyun Um</strong>, Bob',
  'Only the selected author name must render in bold.',
);
assert.equal(
  plainInlineText('Alice, <strong>Ji Hyun Um</strong>, Bob', authorFormats),
  'Alice, Ji Hyun Um, Bob',
  'Formatting markup must not become part of the searchable author text.',
);

const chemistryTitle = 'H<sub>2</sub>O, CO<sub>2</sub>, and Zn<sup>2+</sup>';
assert.equal(
  renderInlineFormatting(chemistryTitle, titleFormats),
  chemistryTitle,
  'Subscript and superscript must render only around the selected title characters.',
);
assert.equal(
  plainInlineText(chemistryTitle, titleFormats),
  'H2O, CO2, and Zn2+',
  'Search and accessible labels must receive the unformatted chemistry title.',
);
assert.equal(
  renderInlineFormatting('A & B', titleFormats),
  'A &amp; B',
  'Unformatted text must still be HTML-escaped.',
);

for (const unsafe of [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>X',
  '<strong onclick="alert(1)">Ji Hyun Um</strong>',
  '<a href="javascript:alert(1)">paper</a>',
]) {
  const rendered = renderInlineFormatting(unsafe, authorFormats);
  assert.doesNotMatch(rendered, /<(?:script|img|a)\b/i, 'Unsupported elements must never render as HTML.');
  assert.doesNotMatch(rendered, /<strong\s+[^>]*>/i, 'Allowed elements must never retain attributes.');
}
assert.doesNotMatch(
  renderInlineFormatting('<strong>not allowed in a title</strong>', titleFormats),
  /<strong>/i,
  'Bold markup must not cross from Authors into Title.',
);
assert.doesNotMatch(
  renderInlineFormatting('<sup>not allowed in authors</sup>', authorFormats),
  /<sup>/i,
  'Superscript markup must not cross from Title into Authors.',
);

const publicationYear = new Function(
  `${extractTopLevelFunction(appSource, 'publicationYear')}; return publicationYear;`,
)();
const filterPublicationItems = new Function(
  'publicationYear',
  'plainInlineText',
  `${extractTopLevelFunction(appSource, 'filterPublicationItems')}; return filterPublicationItems;`,
)(publicationYear, plainInlineText);

const formattedPapers = [
  {
    id: 'formatted',
    year: '2026',
    title: 'CO<sub>2</sub> conversion with Zn<sup>2+</sup>',
    authors: 'Alice, <strong>Ji Hyun Um</strong>',
    journal: 'Energy',
    note: '',
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
  filterPublicationItems(formattedPapers, 'all', 'co2').map((item) => item.id),
  ['formatted'],
  'Search must match visible title text across inline formatting tags.',
);
assert.deepEqual(
  filterPublicationItems(formattedPapers, '2026', 'ji hyun um').map((item) => item.id),
  ['formatted'],
  'Year filtering and visible author-text search must continue to work as an intersection.',
);
assert.deepEqual(
  filterPublicationItems(formattedPapers, 'all', 'strong').map((item) => item.id),
  [],
  'Implementation tag names must not become searchable content.',
);

const externalLinkUrl = new Function(
  `${extractTopLevelFunction(appSource, 'externalLinkUrl')}; return externalLinkUrl;`,
)();
const renderPublicationExternalLink = new Function(
  'externalLinkUrl',
  'escapeAttr',
  'plainInlineText',
  `${extractTopLevelFunction(appSource, 'renderPublicationExternalLink')}; return renderPublicationExternalLink;`,
)(externalLinkUrl, inlineHelpers.escapeAttr, plainInlineText);
const formattedLink = renderPublicationExternalLink(formattedPapers[0], '논문');
assert.match(formattedLink, /target="_blank"[^>]*rel="noopener noreferrer"/);
assert.match(formattedLink, /aria-label="논문 외부 링크: CO2 conversion with Zn2\+ \(새 탭에서 열림\)"/);
assert.doesNotMatch(formattedLink.match(/aria-label="[^"]*"/)?.[0] || '', /(?:&lt;|<)\/?(?:sup|sub)/i);

const paperRendererSource = extractTopLevelFunction(appSource, 'renderPaperList');
assert.match(
  paperRendererSource,
  /renderInlineFormatting\(\s*pub\.title\s*,[\s\S]*?(?:sup[\s\S]*?sub|sub[\s\S]*?sup)[\s\S]*?\)/,
  'Paper titles must use the restricted superscript/subscript renderer.',
);
assert.match(
  paperRendererSource,
  /renderInlineFormatting\(\s*pub\.authors\s*,[\s\S]*?strong[\s\S]*?\)/,
  'Paper authors must use the restricted bold renderer.',
);

const publicationsAdminSource = extractTopLevelFunction(adminSource, 'renderPublications');
assert.match(
  publicationsAdminSource,
  /textareaField\(\s*`publications\.\$\{i\}\.title`[\s\S]*?formats\s*:\s*\[[^\]]*['"]sup['"][^\]]*['"]sub['"][^\]]*\]/,
  'Paper Title must expose only Superscript and Subscript formatting.',
);
assert.match(
  publicationsAdminSource,
  /textareaField\(\s*`publications\.\$\{i\}\.authors`[\s\S]*?formats\s*:\s*\[[^\]]*['"]strong['"][^\]]*\]/,
  'Paper Authors must expose only Bold formatting.',
);
assert.match(adminSource, /data-rich-text-editor/);
assert.match(adminSource, /data-rich-text-toolbar/);
assert.match(adminSource, /contenteditable="true"/);
assert.match(adminSource, /role="textbox"/);
assert.match(adminSource, /aria-multiline="(?:true|false)"/);
assert.match(adminSource, /role="toolbar"/);
assert.match(adminSource, /aria-label=/);
assert.match(adminSource, /aria-pressed=/);
for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
  assert.match(adminSource, new RegExp(`['"]${key}['"]`), `The formatting toolbar must support ${key} keyboard navigation.`);
}
assert.match(
  adminSource,
  /(?:paste|beforeinput)[\s\S]*?(?:text\/plain|textContent|insertText)/i,
  'The CMS must prevent pasted web/Word markup from bypassing its restricted toolbar.',
);
assert.match(
  adminSource,
  /(?:getSelection|Selection)[\s\S]*?(?:cloneRange|Range)/,
  'Toolbar actions must preserve a partial text selection when focus moves to a button.',
);
assert.match(
  adminStyles,
  /(?:\[data-rich-text-toolbar\]|\.rich-text-toolbar)[\s\S]*?button[^{]*\{[^}]*min-height\s*:\s*44px/s,
  'Formatting controls must retain a touch target of at least 44px.',
);

const validatorWindow = {};
const schema = new Function(
  'window',
  'URL',
  `${validationSource}\nreturn window.EMLDataSchema;`,
)(validatorWindow, URL);

function validatePublicationMarkup(field, value) {
  const candidate = structuredClone(siteData);
  candidate.publications[0][field] = value;
  return schema.validate(candidate);
}

assert.equal(
  validatePublicationMarkup('authors', 'Alice, <strong>Ji Hyun Um</strong>, Bob').valid,
  true,
  'Browser validation must accept partial Bold in Authors.',
);
assert.equal(
  validatePublicationMarkup('title', chemistryTitle).valid,
  true,
  'Browser validation must accept sibling Superscript/Subscript runs in Title.',
);
assert.equal(
  validatePublicationMarkup('title', 'A plain legacy publication title').valid,
  true,
  'Legacy publications without formatting must remain valid.',
);

const invalidMarkup = [
  ['authors', '<em>Ji Hyun Um</em>', 'unsupported author tag'],
  ['authors', '<strong class="professor">Ji Hyun Um</strong>', 'attribute on an allowed tag'],
  ['authors', '<strong>Ji <strong>Hyun</strong> Um</strong>', 'nested Bold'],
  ['authors', '<sup>2+</sup>', 'Title-only tag in Authors'],
  ['title', '<strong>Bold title</strong>', 'Authors-only tag in Title'],
  ['title', 'Zn<sup class="charge">2+</sup>', 'attribute on Superscript'],
  ['title', 'Zn<sup>2<sub>+</sub></sup>', 'nested Superscript/Subscript'],
  ['title', 'CO<sub>2</sup>', 'mismatched closing tag'],
  ['title', 'A<sup></sup>B', 'empty formatted range'],
  ['authors', '<strong>\u200b</strong> Ji Hyun Um', 'zero-width-only formatted range'],
  ['title', '<script>alert(1)</script>', 'script element'],
  ['title', '<sup></sup>', 'markup-only required value'],
  ['title', 'A'.repeat(20001), 'oversized formatted field'],
];
for (const [field, value, label] of invalidMarkup) {
  const result = validatePublicationMarkup(field, value);
  assert.equal(result.valid, false, `Browser validation must reject ${label}.`);
  assert.match(
    result.errors.join(' '),
    new RegExp(`publications\\.0\\.${field}`),
    `${label} must report the exact publication field.`,
  );
}

console.log('Publication inline formatting, CMS semantics, validation, search, and link regression contract passed.');
