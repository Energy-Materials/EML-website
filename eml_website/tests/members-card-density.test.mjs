import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const styles = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

function cssRule(selector, startAt = 0) {
  const start = styles.indexOf(`${selector} {`, startAt);
  assert.notEqual(start, -1, `${selector} rule must exist.`);
  const bodyStart = styles.indexOf('{', start) + 1;
  const end = styles.indexOf('}', bodyStart);
  assert.notEqual(end, -1, `${selector} rule must close.`);
  return styles.slice(bodyStart, end);
}

const professorCard = cssRule('.prof-card');
assert.match(professorCard, /--prof-photo-width:\s*228px/);
assert.match(professorCard, /grid-template-columns:\s*var\(--prof-photo-width\)\s+minmax\(0,\s*1fr\)/);
assert.match(professorCard, /gap:\s*30px/);
assert.match(professorCard, /padding:\s*clamp\(28px,\s*4vw,\s*44px\)/);

const photoFrame = cssRule('.image-display-frame');
const photoImage = cssRule('.image-display-frame img');
assert.match(photoFrame, /aspect-ratio:\s*3\s*\/\s*4/);
assert.match(photoImage, /object-fit:\s*contain/);

const alumniGrid = cssRule('.alumni-grid');
const alumniCard = cssRule('.alumni-card');
const alumniDate = cssRule('.alumni-card .date');
const alumniName = cssRule('.alumni-card h3');
const alumniAffiliation = cssRule('.alumni-card p');
assert.match(alumniGrid, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
assert.match(alumniGrid, /gap:\s*18px/);
assert.doesNotMatch(alumniGrid, /(?:^|;)\s*(?:width|max-width|padding|margin)\s*:/);
assert.match(alumniCard, /padding:\s*16px\s+22px/);
assert.doesNotMatch(alumniCard, /(?:min-)?height\s*:/);
assert.match(alumniDate, /font-size:\s*13px/);
assert.match(alumniDate, /font-weight:\s*850/);
assert.match(alumniName, /margin:\s*5px\s+0/);
assert.match(alumniName, /font-size:\s*22px/);
assert.match(alumniAffiliation, /font-size:\s*14px/);

const tabletStart = styles.indexOf('@media (max-width: 860px)');
const tabletEnd = styles.indexOf('@media (max-width: 620px)', tabletStart);
assert.notEqual(tabletStart, -1);
assert.notEqual(tabletEnd, -1);
const tablet = styles.slice(tabletStart, tabletEnd);
assert.match(tablet, /\.prof-card\s*\{[^}]*grid-template-columns:\s*1fr[^}]*gap:\s*26px/s);
assert.match(tablet, /\.prof-photo\s*\{[^}]*width:\s*min\(var\(--prof-photo-width\),\s*100%\)/s);
assert.match(tablet, /\.alumni-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);

const mobileStart = styles.indexOf('@media (max-width: 620px)');
const mobileEnd = styles.indexOf('@media (max-width: 480px)', mobileStart);
assert.notEqual(mobileStart, -1);
const mobile = styles.slice(mobileStart, mobileEnd === -1 ? styles.length : mobileEnd);
assert.match(mobile, /\.alumni-card\s*\{[^}]*padding-block:\s*16px/s);
assert.match(mobile, /\.gallery-grid,\s*\.alumni-grid\s*\{[^}]*grid-template-columns:\s*1fr/s);

console.log('Members professor sizing and Alumni card density contract passed.');
