import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const stylesSource = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

function extractTopLevelFunction(name) {
  const start = appSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist.`);
  const next = appSource.indexOf('\n  function ', start + 1);
  return appSource.slice(start, next === -1 ? appSource.length : next);
}

const externalLinkUrl = new Function(`${extractTopLevelFunction('externalLinkUrl')}; return externalLinkUrl;`)();
assert.equal(externalLinkUrl(null), '', 'A null link_url must not render an icon.');
assert.equal(externalLinkUrl(''), '', 'An empty link_url must not render an icon.');
assert.equal(externalLinkUrl('javascript:alert(1)'), '', 'Unsafe schemes must not render an icon.');
assert.equal(externalLinkUrl('https://user:password@example.com/private'), '', 'Credential-bearing URLs must not render an icon.');
assert.equal(externalLinkUrl('https://exa\nmple.com/paper'), '', 'Line feeds must not be normalized into a link.');
assert.equal(externalLinkUrl('https://exa\tmple.com/paper'), '', 'Tabs must not be normalized into a link.');
assert.equal(externalLinkUrl('https://example.com/a\rb'), '', 'Carriage returns must not be normalized into a link.');
assert.equal(externalLinkUrl('https://example.com/a\u007fb'), '', 'DEL characters must not be accepted in a link.');
assert.equal(externalLinkUrl(`https://example.com/${'a'.repeat(2049)}`), '', 'Oversized links must not render an icon.');
assert.equal(externalLinkUrl('https://example.com/paper'), 'https://example.com/paper');

assert.match(
  appSource,
  /function externalLinkUrl\(value\)[\s\S]*?value !== value\.trim\(\)[\s\S]*?new URL\(raw\)[\s\S]*?\['http:', 'https:'\]\.includes\(resolved\.protocol\)[\s\S]*?resolved\.hostname[\s\S]*?!resolved\.username[\s\S]*?!resolved\.password/,
  'Publication links must accept only trimmed absolute HTTP(S) URLs with a host and no credentials.',
);
assert.match(
  appSource,
  /function renderPublicationExternalLink\(item, typeLabel\)[\s\S]*?item\?\.link_url[\s\S]*?if \(!href\) return ''/,
  'Cards without a usable link_url must not render an external-link control.',
);
assert.match(
  appSource,
  /class="publication-external-link"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*aria-label=/,
  'External publication links must open safely in a new tab and expose an accessible label.',
);
assert.match(
  appSource,
  /renderPublicationExternalLink\(pub, '논문'\)/,
  'Paper cards must render the shared external-link control.',
);
assert.match(
  appSource,
  /renderPublicationExternalLink\(patent, '특허'\)/,
  'Patent cards must render the shared external-link control.',
);

assert.match(
  stylesSource,
  /\.publication-card\s*\{[^}]*position:\s*relative/,
  'The publication card must establish the positioning context for its link icon.',
);
assert.match(
  stylesSource,
  /\.publication-external-link\s*\{[^}]*position:\s*absolute[^}]*right:\s*18px[^}]*bottom:\s*18px[^}]*width:\s*44px[^}]*height:\s*44px/,
  'The external-link control must stay at the card bottom-right with an accessible target size.',
);
assert.match(
  stylesSource,
  /\.publication-card\.has-external-link \.publication-card-content\s*\{[^}]*padding-right:\s*50px/,
  'Linked cards must reserve content space so text cannot overlap the icon.',
);
assert.match(
  stylesSource,
  /\.publication-external-link:active\s*\{[^}]*scale\(\.95\)/,
  'The external-link control must provide a subtle pressed state.',
);

console.log('Publication external-link frontend contract passed.');
