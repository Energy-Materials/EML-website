import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

import { validateContent } from '../tools/content-core.mjs';

const canonical = JSON.parse(await readFile(new URL('../data/site-data.json', import.meta.url), 'utf8'));
const clientValidationSource = await readFile(new URL('../data-validation.js', import.meta.url), 'utf8');
const clientWindow = {};
vm.runInNewContext(clientValidationSource, { window: clientWindow, URL });

const validators = [
  {
    name: 'local content validation',
    validate(content) {
      return validateContent(content);
    },
  },
  {
    name: 'browser draft validation',
    validate(content) {
      return clientWindow.EMLDataSchema.validate(content);
    },
  },
];

function withLinks(publicationLink, patentLink) {
  const content = structuredClone(canonical);
  delete content.publications[0].link_url;
  delete content.patents[0].link_url;
  if (publicationLink !== undefined) content.publications[0].link_url = publicationLink;
  if (patentLink !== undefined) content.patents[0].link_url = patentLink;
  return content;
}

for (const validator of validators) {
  assert.equal(
    validator.validate(withLinks(undefined, undefined)).valid,
    true,
    `${validator.name} must remain compatible with records that omit link_url.`
  );
  assert.equal(
    validator.validate(withLinks('', '')).valid,
    true,
    `${validator.name} must allow clearing both link_url fields.`
  );
  assert.equal(
    validator.validate(withLinks('https://doi.org/10.1000/test', 'http://patents.example.test/item/42')).valid,
    true,
    `${validator.name} must allow absolute http(s) links.`
  );

  for (const invalidLink of [
    'javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'ftp://example.test/file',
    '/relative/path',
    ' https://example.test/leading-space',
    'https://user:password@example.test/private',
    'https://exa\nmple.test/paper',
    'https://exa\tmple.test/paper',
    'https://example.test/a\rb',
    'https://example.test/a\u007fb',
  ]) {
    assert.equal(
      validator.validate(withLinks(invalidLink, '')).valid,
      false,
      `${validator.name} must reject unsafe paper link ${invalidLink}.`
    );
    assert.equal(
      validator.validate(withLinks('', invalidLink)).valid,
      false,
      `${validator.name} must reject unsafe patent link ${invalidLink}.`
    );
  }

  assert.equal(
    validator.validate(withLinks(42, '')).valid,
    false,
    `${validator.name} must reject non-string paper links.`
  );
  assert.equal(
    validator.validate(withLinks(null, null)).valid,
    true,
    `${validator.name} must allow null as an explicit no-link value.`
  );
  assert.equal(
    validator.validate(withLinks('', 42)).valid,
    false,
    `${validator.name} must reject non-string, non-null patent links.`
  );
}

console.log('Publication and patent external-link validation contract passed.');
