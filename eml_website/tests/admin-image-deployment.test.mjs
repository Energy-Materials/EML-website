import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../local-content-store.js', import.meta.url), 'utf8');
const publicAppSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
assert.ok(publicAppSource.includes('__eml_asset=1'));
assert.ok(publicAppSource.includes('img.src = asset(images[lightboxState.imageIndex]'));
let fetchCount = 0;
let readyAfter = 3;
let contentFetchCount = 0;
let contentReadyAfter = 1;
let expectedPublishedContent = { title: 'Published' };
const browser = {
  location: {
    hostname: 'eml-website.em1939653.workers.dev',
    protocol: 'https:',
    href: 'https://eml-website.em1939653.workers.dev/admin.html',
  },
  URL,
  TextEncoder,
  setTimeout,
  clearTimeout,
  fetch: async (input) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname === '/data/site-data.js') {
      contentFetchCount += 1;
      const content = contentFetchCount >= contentReadyAfter ? expectedPublishedContent : { title: 'Previous' };
      return new Response(`window.EML_DATA = ${JSON.stringify(content, null, 2)};\n`, {
        status: 200,
        headers: { 'Content-Type': 'application/javascript' },
      });
    }
    fetchCount += 1;
    const ready = fetchCount >= readyAfter;
    return new Response('', {
      status: ready ? 200 : 404,
      headers: { 'Content-Type': ready ? 'image/webp' : 'text/plain' },
    });
  },
};

vm.runInNewContext(source, {
  window: browser,
  console,
  URL,
  TextEncoder,
  setTimeout,
  clearTimeout,
  Response,
});

const inlineImage = `data:image/png;base64,${Buffer.from('preview').toString('base64')}`;
const publishedPath = 'assets/uploads/2026-08-28/image-example.webp';
const previews = browser.EMLLocalContent.collectPendingImagePreviews(
  { gallery: [{ images: [inlineImage] }], title: inlineImage },
  { gallery: [{ images: [publishedPath] }], title: 'plain text' },
);
assert.deepEqual(JSON.parse(JSON.stringify(previews)), [{ path: publishedPath, preview: inlineImage }]);

const ready = await browser.EMLLocalContent.waitForUploadedImages([publishedPath], {
  timeoutMs: 1000,
  intervalMs: 0,
});
assert.equal(ready.ready, true);
assert.ok(fetchCount >= 4, 'the deployment check should retry and then verify all uploaded assets');

fetchCount = 0;
readyAfter = Number.POSITIVE_INFINITY;
const delayed = await browser.EMLLocalContent.waitForUploadedImages([publishedPath], {
  timeoutMs: 5,
  intervalMs: 1,
});
assert.equal(delayed.ready, false);

fetchCount = 0;
readyAfter = 1;
contentFetchCount = 0;
contentReadyAfter = 3;
expectedPublishedContent = { title: 'New deployment', gallery: [{ images: [publishedPath] }] };
const deployment = await browser.EMLLocalContent.waitForPublishedDeployment(
  expectedPublishedContent,
  [publishedPath],
  { timeoutMs: 1000, intervalMs: 0 },
);
assert.equal(deployment.ready, true);
assert.ok(contentFetchCount >= 3, 'the content revision should be polled before preview opens');

const abortController = new AbortController();
abortController.abort();
const aborted = await browser.EMLLocalContent.waitForPublishedDeployment(
  expectedPublishedContent,
  [publishedPath],
  { timeoutMs: 1000, intervalMs: 0, signal: abortController.signal },
);
assert.equal(aborted.aborted, true);

console.log('Admin image deployment preview contract passed.');
