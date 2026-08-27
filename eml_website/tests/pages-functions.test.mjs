import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as sessionModule from '../functions/api/auth/session.js';
import { onRequestGet as login } from '../functions/api/auth/login.js';
import { onRequestGet as callback } from '../functions/api/auth/callback.js';
import { onRequestPost as logout } from '../functions/api/auth/logout.js';
import { onRequest as contentRoute } from '../functions/api/content.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonicalJson = await readFile(path.join(root, 'data', 'site-data.json'), 'utf8');
const canonicalContent = JSON.parse(canonicalJson);
// Security and Git Data API contract test. All GitHub traffic is mocked below.
const env = {
  SESSION_SECRET: 'test-only-session-secret-that-is-longer-than-32-bytes',
  GITHUB_CLIENT_ID: 'Iv1.test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
  GITHUB_REPOSITORY_ID: '1348328666',
  GITHUB_OWNER: 'Energy-Materials',
  GITHUB_REPO: 'EML-website',
  GITHUB_BRANCH: 'develop',
  GITHUB_CONTENT_PATH: 'eml_website/data/site-data.json',
  PUBLIC_ORIGIN: 'https://energy-materials-lab.pages.dev',
};
const shas = {
  head: 'a'.repeat(40),
  file: 'b'.repeat(40),
  tree: 'c'.repeat(40),
  json: 'd'.repeat(40),
  javascript: 'e'.repeat(40),
  image: 'f'.repeat(40),
  newTree: '1'.repeat(40),
  commit: '2'.repeat(40),
};
const token = `ghu_${'x'.repeat(40)}`;
let capturedTokenExchange = null;
let createdBlobs = [];
let createdTree = null;
let updatedRef = null;
let refUpdateMode = 'success';

async function listFiles(directory, prefix = '') {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) output.push(...await listFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile()) output.push(relative.replaceAll('\\', '/'));
  }
  return output;
}
const assetTree = (await listFiles(path.join(root, 'assets'))).map((relative) => ({
  path: `eml_website/assets/${relative}`,
  type: 'blob',
  mode: '100644',
  sha: '9'.repeat(40),
}));

function githubJson(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = String(init.method || 'GET').toUpperCase();
  if (url.origin === 'https://github.com' && url.pathname === '/login/oauth/access_token') {
    capturedTokenExchange = new URLSearchParams(init.body);
    return githubJson({ access_token: token, expires_in: 28800, scope: '', token_type: 'bearer' });
  }
  assert.equal(url.origin, 'https://api.github.com');
  assert.match(new Headers(init.headers).get('Authorization') || '', /^Bearer /);
  const route = decodeURIComponent(url.pathname);
  if (method === 'GET' && route === '/user') {
    return githubJson({ id: 42, login: 'authorized-user', name: 'Authorized User', avatar_url: 'https://avatars.example/user', html_url: 'https://github.com/authorized-user' });
  }
  if (method === 'GET' && route === '/repos/Energy-Materials/EML-website') {
    return githubJson({ id: 1348328666, full_name: 'Energy-Materials/EML-website', archived: false, disabled: false, permissions: { push: true } });
  }
  if (method === 'GET' && route.endsWith('/git/ref/heads/develop')) {
    return githubJson({ object: { sha: shas.head, type: 'commit' } });
  }
  if (method === 'GET' && route.endsWith(`/contents/eml_website/data/site-data.json`)) {
    return githubJson({ type: 'file', sha: shas.file, path: 'eml_website/data/site-data.json' });
  }
  if (method === 'GET' && route.endsWith(`/git/commits/${shas.head}`)) {
    return githubJson({ sha: shas.head, tree: { sha: shas.tree }, committer: { date: '2026-08-27T12:00:00Z' } });
  }
  if (method === 'GET' && route.endsWith('/commits')) {
    return githubJson([{ commit: { committer: { date: '2026-08-27T12:00:00Z' } } }]);
  }
  if (method === 'GET' && route.endsWith(`/git/blobs/${shas.file}`)) {
    return githubJson({ sha: shas.file, encoding: 'base64', content: Buffer.from(canonicalJson, 'utf8').toString('base64') });
  }
  if (method === 'GET' && route.endsWith(`/git/trees/${shas.tree}`)) {
    return githubJson({ sha: shas.tree, truncated: false, tree: assetTree });
  }
  if (method === 'POST' && route.endsWith('/git/blobs')) {
    const body = JSON.parse(init.body);
    createdBlobs.push(body);
    const sha = createdBlobs.length === 1 ? shas.json : createdBlobs.length === 2 ? shas.javascript : shas.image;
    return githubJson({ sha }, 201);
  }
  if (method === 'POST' && route.endsWith('/git/trees')) {
    createdTree = JSON.parse(init.body);
    return githubJson({ sha: shas.newTree }, 201);
  }
  if (method === 'POST' && route.endsWith('/git/commits')) {
    return githubJson({ sha: shas.commit, html_url: `https://github.com/Energy-Materials/EML-website/commit/${shas.commit}`, committer: { date: '2026-08-27T13:00:00Z' } }, 201);
  }
  if (method === 'PATCH' && route.endsWith('/git/refs/heads/develop')) {
    updatedRef = JSON.parse(init.body);
    if (refUpdateMode === 'reject') return githubJson({ message: 'Reference update rejected by ruleset' }, 422);
    return githubJson({ ref: 'refs/heads/develop', object: { sha: shas.commit } });
  }
  throw new Error(`Unexpected mock request: ${method} ${url}`);
};

assert.throws(
  () => sessionModule.getRepositoryConfig({ ...env, GITHUB_REPOSITORY_ID: '' }),
  (error) => error instanceof sessionModule.ApiError && error.code === 'server_not_configured',
);
assert.throws(
  () => sessionModule.requireSessionSecret({ SESSION_SECRET: 'replace-with-at-least-32-random-characters' }),
  (error) => error instanceof sessionModule.ApiError && error.code === 'server_not_configured',
);

const loginResponse = await login({
  request: new Request(`${env.PUBLIC_ORIGIN}/api/auth/login?returnTo=%2Fadmin.html`),
  env,
});
assert.equal(loginResponse.status, 302);
const authorization = new URL(loginResponse.headers.get('Location'));
assert.equal(authorization.origin, 'https://github.com');
assert.equal(authorization.pathname, '/login/oauth/authorize');
assert.equal(authorization.searchParams.has('scope'), false);
assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
const autoOriginEnv = { ...env };
delete autoOriginEnv.PUBLIC_ORIGIN;
const autoOriginLogin = await login({
  request: new Request('https://knu-energy-materials.pages.dev/api/auth/login'),
  env: autoOriginEnv,
});
assert.equal(
  new URL(autoOriginLogin.headers.get('Location')).searchParams.get('redirect_uri'),
  'https://knu-energy-materials.pages.dev/api/auth/callback',
);
const oauthCookieHeader = loginResponse.headers.getSetCookie().find((value) => value.startsWith(`${sessionModule.OAUTH_COOKIE}=`));
assert.ok(oauthCookieHeader?.includes('HttpOnly'));
assert.ok(oauthCookieHeader?.includes('Secure'));
assert.ok(oauthCookieHeader?.includes('SameSite=Lax'));
const oauthCookie = oauthCookieHeader.split(';', 1)[0];
const sealedOauth = oauthCookie.slice(oauthCookie.indexOf('=') + 1);
const oauthState = await sessionModule.openCookiePayload(sealedOauth, env, 'eml-oauth-state');
assert.equal(oauthState.state, authorization.searchParams.get('state'));

const callbackResponse = await callback({
  request: new Request(`${env.PUBLIC_ORIGIN}/api/auth/callback?code=test-code&state=${encodeURIComponent(oauthState.state)}`, {
    headers: { Cookie: oauthCookie },
  }),
  env,
});
assert.equal(callbackResponse.status, 303);
assert.equal(capturedTokenExchange.has('scope'), false);
assert.equal(capturedTokenExchange.get('repository_id'), env.GITHUB_REPOSITORY_ID);
assert.equal(capturedTokenExchange.get('code_verifier'), oauthState.codeVerifier);
const sessionCookieHeader = callbackResponse.headers.getSetCookie().find((value) => value.startsWith(`${sessionModule.SESSION_COOKIE}=`) && !value.includes('Max-Age=0'));
assert.ok(sessionCookieHeader);
const sessionCookie = sessionCookieHeader.split(';', 1)[0];
const sessionRequest = new Request(`${env.PUBLIC_ORIGIN}/api/auth/session`, { headers: { Cookie: sessionCookie } });
const session = await sessionModule.loadSession(sessionRequest, env);
assert.equal(session.user.login, 'authorized-user');
assert.equal(session.repositoryId, env.GITHUB_REPOSITORY_ID);
const sessionCookieSeparator = sessionCookie.indexOf('=');
const sealedSessionParts = sessionCookie.slice(sessionCookieSeparator + 1).split('.');
const tamperIndex = Math.floor(sealedSessionParts[2].length / 2);
sealedSessionParts[2] = `${sealedSessionParts[2].slice(0, tamperIndex)}${sealedSessionParts[2][tamperIndex] === 'a' ? 'b' : 'a'}${sealedSessionParts[2].slice(tamperIndex + 1)}`;
const tamperedCookie = `${sessionCookie.slice(0, sessionCookieSeparator + 1)}${sealedSessionParts.join('.')}`;
assert.equal(await sessionModule.loadSession(new Request(`${env.PUBLIC_ORIGIN}/`, { headers: { Cookie: tamperedCookie } }), env), null);

const unauthenticatedGet = await contentRoute({ request: new Request(`${env.PUBLIC_ORIGIN}/api/content`), env });
assert.equal(unauthenticatedGet.status, 401);
assert.equal((await unauthenticatedGet.json()).code, 'auth_required');

const getResponse = await contentRoute({ request: new Request(`${env.PUBLIC_ORIGIN}/api/content`, { headers: { Cookie: sessionCookie } }), env });
assert.equal(getResponse.status, 200);
const loaded = await getResponse.json();
assert.equal(loaded.revision, shas.file);
assert.equal(loaded.content.site.labName, canonicalContent.site.labName);

const csrfResponse = await contentRoute({
  request: new Request(`${env.PUBLIC_ORIGIN}/api/content`, {
    method: 'PUT',
    headers: { Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-EML-Admin-Request': '1' },
    body: JSON.stringify({ content: canonicalContent, expectedRevision: shas.file }),
  }),
  env,
});
assert.equal(csrfResponse.status, 403);

createdBlobs = [];
const putResponse = await contentRoute({
  request: new Request(`${env.PUBLIC_ORIGIN}/api/content`, {
    method: 'PUT',
    headers: {
      Cookie: sessionCookie,
      Origin: env.PUBLIC_ORIGIN,
      'Content-Type': 'application/json',
      'X-EML-Admin-Request': '1',
      'Sec-Fetch-Site': 'same-origin',
    },
    body: JSON.stringify({ content: canonicalContent, expectedRevision: shas.file, message: 'content: mock publish' }),
  }),
  env,
});
const putText = await putResponse.text();
assert.equal(putResponse.status, 200, putText);
const published = JSON.parse(putText);
assert.equal(published.revision, shas.json);
assert.equal(createdBlobs.length, 2);
assert.equal(createdBlobs[0].encoding, 'utf-8');
assert.equal(createdBlobs[1].content, `window.EML_DATA = ${createdBlobs[0].content.trimEnd()};\n`);
assert.equal(createdTree.base_tree, shas.tree);
assert.deepEqual(updatedRef, { sha: shas.commit, force: false });

createdBlobs = [];
createdTree = null;
updatedRef = null;
const embeddedImageContent = structuredClone(canonicalContent);
const onePixelPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
embeddedImageContent.gallery[0].image = onePixelPng;
embeddedImageContent.gallery[0].images[0] = onePixelPng;
const embeddedImageResponse = await contentRoute({
  request: new Request(`${env.PUBLIC_ORIGIN}/api/content`, {
    method: 'PUT',
    headers: {
      Cookie: sessionCookie,
      Origin: env.PUBLIC_ORIGIN,
      'Content-Type': 'application/json',
      'X-EML-Admin-Request': '1',
      'Sec-Fetch-Site': 'same-origin',
    },
    body: JSON.stringify({ content: embeddedImageContent, expectedRevision: shas.file }),
  }),
  env,
});
const embeddedImageText = await embeddedImageResponse.text();
assert.equal(embeddedImageResponse.status, 200, embeddedImageText);
const embeddedPublished = JSON.parse(embeddedImageText);
assert.equal(createdBlobs.length, 3);
assert.equal(createdBlobs[2].encoding, 'base64');
assert.equal(createdBlobs[2].content, onePixelPng.slice(onePixelPng.indexOf(',') + 1));
assert.match(embeddedPublished.content.gallery[0].image, /^assets\/uploads\/\d{4}-\d{2}-\d{2}\/image-[A-Za-z0-9_-]{24}\.png$/);
assert.equal(embeddedPublished.content.gallery[0].images[0], embeddedPublished.content.gallery[0].image);
assert.ok(createdTree.tree.some((entry) => entry.path.endsWith('.png')));
assert.deepEqual(updatedRef, { sha: shas.commit, force: false });

refUpdateMode = 'reject';
const protectedBranchResponse = await contentRoute({
  request: new Request(`${env.PUBLIC_ORIGIN}/api/content`, {
    method: 'PUT',
    headers: { Cookie: sessionCookie, Origin: env.PUBLIC_ORIGIN, 'Content-Type': 'application/json', 'X-EML-Admin-Request': '1' },
    body: JSON.stringify({ content: canonicalContent, expectedRevision: shas.file }),
  }),
  env,
});
assert.equal(protectedBranchResponse.status, 403);
assert.equal((await protectedBranchResponse.json()).code, 'branch_update_rejected');
refUpdateMode = 'success';

const invalidGallery = structuredClone(canonicalContent);
invalidGallery.gallery[0].images = [];
const invalidResponse = await contentRoute({
  request: new Request(`${env.PUBLIC_ORIGIN}/api/content`, {
    method: 'PUT',
    headers: { Cookie: sessionCookie, Origin: env.PUBLIC_ORIGIN, 'Content-Type': 'application/json', 'X-EML-Admin-Request': '1' },
    body: JSON.stringify({ content: invalidGallery, expectedRevision: shas.file }),
  }),
  env,
});
assert.equal(invalidResponse.status, 422);
assert.equal((await invalidResponse.json()).code, 'invalid_content');

const blankGalleryImage = structuredClone(canonicalContent);
blankGalleryImage.gallery[0].images = [''];
blankGalleryImage.gallery[0].image = '';
const blankGalleryImageResponse = await contentRoute({
  request: new Request(`${env.PUBLIC_ORIGIN}/api/content`, {
    method: 'PUT',
    headers: { Cookie: sessionCookie, Origin: env.PUBLIC_ORIGIN, 'Content-Type': 'application/json', 'X-EML-Admin-Request': '1' },
    body: JSON.stringify({ content: blankGalleryImage, expectedRevision: shas.file }),
  }),
  env,
});
assert.equal(blankGalleryImageResponse.status, 422);
assert.equal((await blankGalleryImageResponse.json()).code, 'invalid_content');

const mismatchedGalleryCover = structuredClone(canonicalContent);
mismatchedGalleryCover.gallery[0].image = canonicalContent.gallery[1].images[0];
const mismatchedGalleryCoverResponse = await contentRoute({
  request: new Request(`${env.PUBLIC_ORIGIN}/api/content`, {
    method: 'PUT',
    headers: { Cookie: sessionCookie, Origin: env.PUBLIC_ORIGIN, 'Content-Type': 'application/json', 'X-EML-Admin-Request': '1' },
    body: JSON.stringify({ content: mismatchedGalleryCover, expectedRevision: shas.file }),
  }),
  env,
});
assert.equal(mismatchedGalleryCoverResponse.status, 422);
assert.equal((await mismatchedGalleryCoverResponse.json()).code, 'invalid_content');

const forgedPng = structuredClone(canonicalContent);
forgedPng.gallery[0].image = 'data:image/png;base64,AAAAAAAAAAAAAAAA';
forgedPng.gallery[0].images[0] = forgedPng.gallery[0].image;
const forgedPngResponse = await contentRoute({
  request: new Request(`${env.PUBLIC_ORIGIN}/api/content`, {
    method: 'PUT',
    headers: { Cookie: sessionCookie, Origin: env.PUBLIC_ORIGIN, 'Content-Type': 'application/json', 'X-EML-Admin-Request': '1' },
    body: JSON.stringify({ content: forgedPng, expectedRevision: shas.file }),
  }),
  env,
});
assert.equal(forgedPngResponse.status, 422);
assert.equal((await forgedPngResponse.json()).code, 'image_signature_mismatch');

const duplicatePublicationNumber = structuredClone(canonicalContent);
duplicatePublicationNumber.publications[1].number = duplicatePublicationNumber.publications[0].number;
const duplicatePublicationResponse = await contentRoute({
  request: new Request(`${env.PUBLIC_ORIGIN}/api/content`, {
    method: 'PUT',
    headers: { Cookie: sessionCookie, Origin: env.PUBLIC_ORIGIN, 'Content-Type': 'application/json', 'X-EML-Admin-Request': '1' },
    body: JSON.stringify({ content: duplicatePublicationNumber, expectedRevision: shas.file }),
  }),
  env,
});
assert.equal(duplicatePublicationResponse.status, 422);
assert.equal((await duplicatePublicationResponse.json()).code, 'invalid_content');

const malformedArrays = structuredClone(canonicalContent);
malformedArrays.gallery = { not: 'an array' };
const malformedResponse = await contentRoute({
  request: new Request(`${env.PUBLIC_ORIGIN}/api/content`, {
    method: 'PUT',
    headers: { Cookie: sessionCookie, Origin: env.PUBLIC_ORIGIN, 'Content-Type': 'application/json', 'X-EML-Admin-Request': '1' },
    body: JSON.stringify({ content: malformedArrays, expectedRevision: shas.file }),
  }),
  env,
});
assert.equal(malformedResponse.status, 422);
assert.equal((await malformedResponse.json()).code, 'invalid_content');

const logoutResponse = await logout({
  request: new Request(`${env.PUBLIC_ORIGIN}/api/auth/logout`, {
    method: 'POST',
    headers: { Origin: env.PUBLIC_ORIGIN, 'X-EML-Admin-Request': '1' },
  }),
});
assert.equal(logoutResponse.status, 200);
assert.ok(logoutResponse.headers.getSetCookie().some((value) => value.startsWith(`${sessionModule.SESSION_COOKIE}=`) && value.includes('Max-Age=0')));

console.log('Pages Functions security and Git publishing mocks passed.');
