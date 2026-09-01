import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const stylesSource = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

assert.match(
  stylesSource,
  /\.container\s*\{[^}]*width:\s*min\(var\(--max\),\s*calc\(100%\s*-\s*44px\)\)/,
  'Primary content must use the shared maximum width with 22px side gutters.',
);
assert.match(
  stylesSource,
  /\.site-footer\s*\{[^}]*padding:\s*52px 22px 34px/,
  'The footer must retain the same 22px desktop side gutters as primary content.',
);
assert.match(
  stylesSource,
  /\.footer-inner\s*\{[^}]*width:\s*min\(var\(--max\),\s*100%\)/,
  'Footer content must use the same shared maximum width as primary content.',
);
assert.match(
  stylesSource,
  /@media \(max-width:\s*620px\)\s*\{[\s\S]*?\.container\s*\{[^}]*width:\s*min\(calc\(100%\s*-\s*30px\),\s*var\(--max\)\)[\s\S]*?\.site-footer\s*\{[^}]*padding-inline:\s*15px/,
  'Primary content and footer must retain matching 15px mobile side gutters.',
);

console.log('Footer container alignment contract passed.');
