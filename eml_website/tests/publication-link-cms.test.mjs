import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const adminSource = await readFile(new URL('../admin.js', import.meta.url), 'utf8');
const adminStyles = await readFile(new URL('../admin.css', import.meta.url), 'utf8');

function extractTopLevelFunction(name) {
  const start = adminSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist.`);
  const next = adminSource.indexOf('\n  function ', start + 1);
  return adminSource.slice(start, next === -1 ? adminSource.length : next);
}

const escapeMarkup = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const inputField = new Function(
  'escapeAttr',
  'escapeHTML',
  `${extractTopLevelFunction('inputField')}; return inputField;`,
)(escapeMarkup, escapeMarkup);

const renderPublications = new Function(
  'data',
  'header',
  'inputField',
  'textareaField',
  'saveBar',
  'escapeHTML',
  `${extractTopLevelFunction('renderPublications')}; return renderPublications;`,
);

const content = {
  publications: [{
    number: 1,
    year: '2026',
    journal: 'Journal',
    title: 'Paper title',
    authors: 'Author',
    note: '',
    link_url: 'https://example.com/paper?id=1&view=full',
  }],
  patents: [{
    year: '2026',
    number: '10-1234567',
    title: 'Patent title',
    inventors: 'Inventor',
    link_url: 'https://example.com/patent/10-1234567',
  }],
};

const html = renderPublications(
  content,
  () => '',
  inputField,
  (path, label, value = '') => `<textarea data-path="${escapeMarkup(path)}">${escapeMarkup(value)}</textarea>`,
  () => '',
  escapeMarkup,
)();

assert.match(
  html,
  /type="url" value="https:\/\/example\.com\/paper\?id=1&amp;view=full" data-path="publications\.0\.link_url"[^>]*inputmode="url"[^>]*autocomplete="url"[^>]*maxlength="2048"/,
  'Paper editors must expose the saved link_url through a semantic URL input.',
);
assert.match(
  html,
  /type="url" value="https:\/\/example\.com\/patent\/10-1234567" data-path="patents\.0\.link_url"/,
  'Patent editors must expose the saved link_url through the same URL input.',
);
assert.match(html, /http:\/\/ 또는 https:\/\/로 시작하는 논문 외부 페이지 주소를 입력하세요\.[^<]*비워두거나 기존 주소를 지우면/);
assert.match(html, /http:\/\/ 또는 https:\/\/로 시작하는 특허 외부 페이지 주소를 입력하세요\.[^<]*비워두거나 기존 주소를 지우면/);
assert.equal((html.match(/외부 링크 URL \(선택\)/g) || []).length, 2);
assert.match(
  adminStyles,
  /\.help\s*\{[^}]*color:\s*#627486/,
  'CMS field help must keep sufficient contrast against the white editor surface.',
);

const legacyHtml = renderPublications(
  {
    publications: [{ number: 1, year: '2025', journal: 'J', title: 'Legacy paper', authors: 'A' }],
    patents: [{ year: '2025', number: 'P', title: 'Legacy patent', inventors: 'I' }],
  },
  () => '',
  inputField,
  (path, label, value = '') => `<textarea data-path="${escapeMarkup(path)}">${escapeMarkup(value)}</textarea>`,
  () => '',
  escapeMarkup,
)();
assert.match(legacyHtml, /type="url" value="" data-path="publications\.0\.link_url"/);
assert.match(legacyHtml, /type="url" value="" data-path="patents\.0\.link_url"/);

const draft = { publications: [], patents: [], researchTopics: [], members: [], alumni: [], gallery: [] };
const addItem = new Function(
  'data',
  'markDirty',
  'render',
  'toast',
  `${extractTopLevelFunction('addItem')}; return addItem;`,
)(draft, () => {}, () => {}, () => {});
addItem('publication');
addItem('patent');
assert.equal(draft.publications[0].link_url, '', 'A new paper must start with an optional empty link_url.');
assert.equal(draft.patents[0].link_url, '', 'A new patent must start with an optional empty link_url.');

const inputListeners = new Map();
const urlField = {
  type: 'url',
  value: '',
  dataset: { path: 'publications.0.link_url' },
  addEventListener(type, callback) { inputListeners.set(type, callback); },
};
const savedValues = [];
const bindCommon = new Function(
  'content',
  'setPath',
  'syncBannerUploadState',
  'markDirty',
  'saveData',
  'showPreviewWait',
  'openPreviewAfterDeployment',
  'toast',
  'addItem',
  'deleteItem',
  'moveItem',
  'bindUploads',
  'bindMultiUploads',
  'bindImageActions',
  'bindPublishedImageFallbacks',
  'applyRaw',
  'exportData',
  `${extractTopLevelFunction('bindCommon')}; return bindCommon;`,
)(
  {
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === '[data-path]' ? [urlField] : []),
  },
  (path, value) => savedValues.push({ path, value }),
  () => {},
  () => {},
  async () => true,
  () => {},
  async () => true,
  () => {},
  () => {},
  () => {},
  () => {},
  () => {},
  () => {},
  () => {},
  () => {},
  () => {},
  () => {},
);
bindCommon();
inputListeners.get('input')();
assert.deepEqual(
  savedValues,
  [{ path: 'publications.0.link_url', value: '' }],
  'Clearing a CMS URL input must persist an empty string so an existing external link can be removed.',
);

console.log('Publication and patent link CMS contract passed.');
