import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import worker from '../worker.js';

const origin = 'https://eml-website.em1939653.workers.dev';
const wranglerConfig = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
const staticHeaders = await readFile(new URL('../_headers', import.meta.url), 'utf8');
assert.match(wranglerConfig, /run_worker_first\s*=\s*\[[^\]]*"\/assets\/uploads\/\*"[^\]]*\]/s);
assert.match(staticHeaders, /\/assets\/uploads\/\*\s+Cache-Control:\s*no-store,\s*max-age=0/s);

let assetRequests = 0;
const env = {
  GITHUB_OWNER: 'Energy-Materials',
  GITHUB_REPO: 'EML-website',
  GITHUB_BRANCH: 'develop',
  GITHUB_CONTENT_PATH: 'eml_website/data/site-data.json',
  GITHUB_REPOSITORY_ID: '1348328666',
  PUBLIC_ORIGIN: origin,
  ASSETS: {
    async fetch(request) {
      assetRequests += 1;
      const pathname = new URL(request.url).pathname;
      if (pathname.endsWith('/pending.webp')) {
        return new Response('missing', {
          status: 404,
          headers: { 'Cache-Control': 'public, max-age=31536000, immutable' },
        });
      }
      return new Response(`asset:${pathname}`, {
        status: 200,
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      });
    },
  },
};
const executionContext = { waitUntil() {} };

async function request(path, init = undefined) {
  return worker.fetch(new Request(`${origin}${path}`, init), env, executionContext);
}

const asset = await request('/');
assert.equal(asset.status, 200);
assert.equal(await asset.text(), 'asset:/');
assert.equal(assetRequests, 1);

const publishedUpload = await request('/assets/uploads/2026-08-28/ready.webp');
assert.equal(publishedUpload.status, 200);
assert.equal(publishedUpload.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');

const pendingUpload = await request('/assets/uploads/2026-08-28/pending.webp');
assert.equal(pendingUpload.status, 404);
assert.equal(pendingUpload.headers.get('Cache-Control'), 'no-store, max-age=0');
assert.equal(assetRequests, 3);

const session = await request('/api/auth/session');
assert.equal(session.status, 401);
assert.match(session.headers.get('Content-Type') || '', /^application\/json/);
assert.equal(session.headers.get('Cache-Control'), 'no-store, max-age=0');
assert.equal(session.headers.get('X-Content-Type-Options'), 'nosniff');
assert.equal(session.headers.has('Access-Control-Allow-Origin'), false);
assert.equal((await session.json()).code, 'auth_required');
assert.equal(assetRequests, 3, 'API requests must not fall through to static assets');

const invalidSessionMethod = await request('/api/auth/session', { method: 'POST' });
assert.equal(invalidSessionMethod.status, 405);
assert.equal(invalidSessionMethod.headers.get('Allow'), 'GET');

const invalidLogoutMethod = await request('/api/auth/logout');
assert.equal(invalidLogoutMethod.status, 405);
assert.equal(invalidLogoutMethod.headers.get('Allow'), 'POST');

const contentPreflight = await request('/api/content', { method: 'OPTIONS' });
assert.equal(contentPreflight.status, 405);
assert.equal(contentPreflight.headers.get('Allow'), 'GET, PUT');

const loginWithoutSecrets = await request('/api/auth/login');
assert.equal(loginWithoutSecrets.status, 500);
assert.equal((await loginWithoutSecrets.json()).code, 'server_not_configured');

const contentWithoutSession = await request('/api/content');
assert.equal(contentWithoutSession.status, 401);
assert.equal((await contentWithoutSession.json()).code, 'auth_required');

const missingApi = await request('/api/missing');
assert.equal(missingApi.status, 404);
assert.equal((await missingApi.json()).code, 'not_found');

console.log('Cloudflare Worker API routing contract passed.');
