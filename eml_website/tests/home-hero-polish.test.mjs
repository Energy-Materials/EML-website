import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');

assert.match(
  appSource,
  /<p class="hero-label">\$\{escapeHTML\(h\.eyebrow \|\| s\.university \|\| ''\)\}<\/p>/,
  'The university name must remain in the Home hero without an adjacent logo.',
);
assert.doesNotMatch(
  appSource,
  /Kongju National University logo/,
  'The low-visibility university logo must not be rendered in the Home hero.',
);
assert.match(
  appSource,
  /ctx\.setTransform\(1, 0, 0, 1, 0, 0\);\s*ctx\.clearRect\(0, 0, canvas\.width, canvas\.height\);\s*ctx\.setTransform\(renderScaleX, 0, 0, renderScaleY, 0, 0\);/,
  'Particles must clear the full backing canvas before restoring the display transform.',
);
assert.match(
  appSource,
  /const bounds = canvas\.getBoundingClientRect\(\);[\s\S]*?renderScaleX = canvas\.width \/ canvasWidth;[\s\S]*?renderScaleY = canvas\.height \/ canvasHeight;/,
  'Particle rendering must derive its backing-store scale from the actual canvas bounds.',
);

console.log('Home hero logo removal and zoom-safe particles contract passed.');
