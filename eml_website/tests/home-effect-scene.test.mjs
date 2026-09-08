import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const stylesSource = await readFile(new URL('../styles.css', import.meta.url), 'utf8');

const metricsMatch = appSource.match(/function getCoverSceneMetrics\([\s\S]*?\n  \}/);
assert.ok(metricsMatch, 'The Home effect must expose one cover-scene geometry helper.');
const getCoverSceneMetrics = Function(`"use strict"; ${metricsMatch[0]}; return getCoverSceneMetrics;`)();

const imageRatio = 1111 / 627;
const wide = getCoverSceneMetrics(1425, 900, imageRatio);
const narrow = getCoverSceneMetrics(375, 900, imageRatio);
const restored = getCoverSceneMetrics(1425, 900, imageRatio);

assert.ok(Math.abs(wide.sceneWidth - narrow.sceneWidth) < 0.000001);
assert.ok(Math.abs(wide.sceneHeight - narrow.sceneHeight) < 0.000001);
assert.ok(narrow.sceneOffsetX < wide.sceneOffsetX, 'A narrower viewport must crop farther into the same centered scene.');
assert.deepEqual(restored, wide, 'Restoring the viewport must restore the original scene mapping exactly.');
assert.ok(wide.sceneWidth >= 1425 && wide.sceneHeight >= 900, 'The scene must cover the viewport.');
const scenePoint = (metrics, u, v) => ({
  x: metrics.sceneOffsetX + (u * metrics.sceneWidth),
  y: metrics.sceneOffsetY + (v * metrics.sceneHeight),
});
const widePoint = scenePoint(wide, 0.42, 0.61);
const narrowPoint = scenePoint(narrow, 0.42, 0.61);
assert.ok(Math.abs((narrowPoint.x - widePoint.x) - ((375 - 1425) / 2)) < 0.000001);
assert.equal(narrowPoint.y, widePoint.y, 'A width-only resize must not move a scene point vertically.');

assert.match(
  appSource,
  /data-particles data-particle-scene-image="\$\{escapeAttr\(heroImage\)\}"/,
  'Particles must use the same CMS-managed image source as the Home background.',
);
assert.match(
  appSource,
  /const bounds = \(hero \|\| canvas\)\.getBoundingClientRect\(\);/,
  'Particle backing dimensions must come from the untransformed Home hero.',
);
assert.match(appSource, /const count = 88;/, 'The logical scene particle count must not shrink with the viewport.');
assert.match(
  appSource,
  /sceneImage\.onload = \(\) => \{[\s\S]*?sceneAspectRatio = naturalRatio;[\s\S]*?resize\(\);[\s\S]*?startDrawing\(\);[\s\S]*?sceneImage\.onerror = startDrawing;/,
  'A CMS image must establish its real aspect ratio before the effect is first painted.',
);
assert.match(appSource, /p\.u = Math\.random\(\) \* 0\.78;\s*p\.v = Math\.random\(\);/);
assert.match(appSource, /p\.u \+= p\.vx \/ sceneWidth;/);
assert.match(appSource, /const sceneVerticalMargin = 20 \/ sceneHeight;/);
assert.match(appSource, /const x = sceneOffsetX \+ \(p\.u \* sceneWidth\);/);
assert.match(appSource, /const y = sceneOffsetY \+ \(p\.v \* sceneHeight\);/);
assert.match(appSource, /p\.r = Math\.random\(\) \* 2\.4 \+ 0\.7;/);
assert.match(appSource, /p\.vx = Math\.random\(\) \* 0\.58 \+ 0\.22;/);
assert.match(appSource, /p\.vy = \(Math\.random\(\) - 0\.5\) \* 0\.42;/);
assert.match(appSource, /p\.alpha = Math\.random\(\) \* 0\.52 \+ 0\.18;/);
assert.match(appSource, /const animationTime = Date\.now\(\) \/ 900;/);
assert.match(appSource, /Math\.sin\(animationTime \+ i\) \* 0\.16/);
assert.match(appSource, /const glowRadius = p\.r \* 8;/);
assert.match(appSource, /ctx\.arc\(x, y, glowRadius, 0, Math\.PI \* 2\);/);
const resizeStart = appSource.indexOf('    function resize() {', appSource.indexOf('  function initParticles()'));
const resizeEnd = appSource.indexOf('    particleResize = resize;', resizeStart);
assert.ok(resizeStart >= 0 && resizeEnd > resizeStart, 'The particle resize routine must be discoverable.');
assert.doesNotMatch(
  appSource.slice(resizeStart, resizeEnd),
  /resetParticle\(|Math\.random\(|particles\.(?:push|splice)/,
  'Viewport resize must not recreate or randomize particles.',
);

assert.match(
  stylesSource,
  /\.hero::before,\s*\.hero-particles\s*\{[^}]*transform:\s*scale\(1\.025\)[^}]*animation:\s*heroZoom 26s ease-in-out infinite alternate/,
  'The particle scene must follow the exact background zoom timeline.',
);

console.log('Home background and particle scene coordinate contract passed.');
