const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export const SESSION_COOKIE = '__Host-eml_admin_session';
export const OAUTH_COOKIE = '__Host-eml_oauth_state';
export const ADMIN_REQUEST_HEADER = 'X-EML-Admin-Request';
export const ADMIN_REQUEST_VALUE = '1';
export const MAX_SESSION_SECONDS = 8 * 60 * 60;
export const OAUTH_STATE_SECONDS = 10 * 60;

const GITHUB_API_VERSION = '2026-03-10';
const MAX_COOKIE_VALUE_LENGTH = 3_800;
const SAFE_NAME = /^[A-Za-z0-9_.-]+$/;
const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/;

export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class GitHubApiError extends Error {
  constructor(status, message, responseBody, headers) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.responseBody = responseBody;
    this.rateLimited = headers?.get('x-ratelimit-remaining') === '0';
  }
}

function requireSecret(env, name, minimumLength = 1) {
  const value = String(env?.[name] || '').trim();
  const placeholder = /^(?:YOUR(?:[_-]|$)|REPLACE(?:[_-]?WITH)?(?:[_-]|$)|CHANGE(?:[_-]?ME)?(?:[_-]|$)|EXAMPLE(?:[_-]|$))/i.test(value);
  if (!value || value.length < minimumLength || placeholder) {
    throw new ApiError(500, 'server_not_configured', `${name} 환경 변수가 설정되지 않았습니다.`);
  }
  return value;
}

function normalizeRepositoryPath(value) {
  const normalized = String(value || '').trim().replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.includes('\\') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new ApiError(500, 'server_not_configured', 'GITHUB_CONTENT_PATH가 안전한 저장소 경로가 아닙니다.');
  }
  return normalized;
}

export function getRepositoryConfig(env) {
  const owner = String(env?.GITHUB_OWNER || 'EML-lab2022').trim();
  const repo = String(env?.GITHUB_REPO || 'EML-website').trim();
  const branch = String(env?.GITHUB_BRANCH || 'develop').trim();
  const contentPath = normalizeRepositoryPath(env?.GITHUB_CONTENT_PATH || 'eml_website/data/site-data.json');
  const repositoryId = String(env?.GITHUB_REPOSITORY_ID || '').trim();

  if (!SAFE_NAME.test(owner) || !SAFE_NAME.test(repo) || !SAFE_BRANCH.test(branch) || branch.includes('..') || branch.startsWith('/') || branch.endsWith('/')) {
    throw new ApiError(500, 'server_not_configured', 'GitHub 저장소 또는 브랜치 환경 변수 형식이 올바르지 않습니다.');
  }
  if (!contentPath.endsWith('.json')) {
    throw new ApiError(500, 'server_not_configured', 'GITHUB_CONTENT_PATH는 .json 파일이어야 합니다.');
  }
  if (!/^\d+$/.test(repositoryId)) {
    throw new ApiError(500, 'server_not_configured', 'GITHUB_REPOSITORY_ID 환경 변수에 대상 저장소의 숫자 ID를 설정해야 합니다.');
  }

  const slash = contentPath.lastIndexOf('/');
  const directory = slash >= 0 ? contentPath.slice(0, slash) : '';
  const siteRoot = directory === 'data' ? '' : directory.replace(/\/data$/, '');
  const generatedPath = contentPath.replace(/\.json$/, '.js');
  const assetsPath = [siteRoot, 'assets/uploads'].filter(Boolean).join('/');

  return Object.freeze({ owner, repo, branch, contentPath, generatedPath, assetsPath, siteRoot, repositoryId });
}

export function getOAuthConfig(env) {
  return Object.freeze({
    ...getRepositoryConfig(env),
    clientId: requireSecret(env, 'GITHUB_CLIENT_ID'),
    clientSecret: requireSecret(env, 'GITHUB_CLIENT_SECRET'),
  });
}

export function requireSessionSecret(env) {
  return requireSecret(env, 'SESSION_SECRET', 32);
}

export function getRequestOrigin(request, env = undefined) {
  const requestOrigin = new URL(request.url).origin;
  const configured = String(env?.PUBLIC_ORIGIN || '').trim();
  if (!configured) return requestOrigin;

  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new ApiError(500, 'server_not_configured', 'PUBLIC_ORIGIN이 올바른 URL이 아닙니다.');
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash
    || (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1')) {
    throw new ApiError(500, 'server_not_configured', 'PUBLIC_ORIGIN은 경로가 없는 HTTPS origin이어야 합니다.');
  }
  return url.origin;
}

export function safeReturnTo(value, fallback = '/admin.html') {
  if (typeof value !== 'string' || value.length > 512 || !value.startsWith('/') || value.startsWith('//') || /[\r\n\\]/.test(value)) {
    return fallback;
  }
  try {
    const parsed = new URL(value, 'https://eml.invalid');
    if (parsed.origin !== 'https://eml.invalid') return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url value.');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function deriveEncryptionKey(secret, purpose) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('eml-pages-functions-v1'),
      info: encoder.encode(purpose),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function sealCookiePayload(payload, env, purpose) {
  const key = await deriveEncryptionKey(requireSessionSecret(env), purpose);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(purpose) },
    key,
    plaintext,
  ));
  const result = `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(ciphertext)}`;
  if (result.length > MAX_COOKIE_VALUE_LENGTH) throw new ApiError(500, 'session_too_large', '암호화된 세션이 쿠키 크기 제한을 초과했습니다.');
  return result;
}

export async function openCookiePayload(value, env, purpose) {
  try {
    if (typeof value !== 'string' || !value || value.length > MAX_COOKIE_VALUE_LENGTH) return null;
    const [version, encodedIv, encodedCiphertext, extra] = value.split('.');
    if (version !== 'v1' || !encodedIv || !encodedCiphertext || extra !== undefined) return null;
    const iv = base64UrlToBytes(encodedIv);
    if (iv.length !== 12) return null;
    const key = await deriveEncryptionKey(requireSessionSecret(env), purpose);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(purpose) },
      key,
      base64UrlToBytes(encodedCiphertext),
    );
    return JSON.parse(decoder.decode(plaintext));
  } catch {
    return null;
  }
}

export function randomBase64Url(byteLength = 32) {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Base64Url(value) {
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

export function constantTimeEqual(left, right) {
  const a = encoder.encode(String(left || ''));
  const b = encoder.encode(String(right || ''));
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a[index] || 0) ^ (b[index] || 0);
  return difference === 0;
}

export function parseCookies(request) {
  const result = Object.create(null);
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && !(name in result)) result[name] = value;
  }
  return result;
}

export function serializeCookie(name, value, { maxAge }) {
  const seconds = Math.max(0, Math.floor(maxAge));
  const parts = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${seconds}`,
  ];
  if (seconds === 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  return parts.join('; ');
}

export function clearSessionCookie() {
  return serializeCookie(SESSION_COOKIE, '', { maxAge: 0 });
}

export function clearOAuthCookie() {
  return serializeCookie(OAUTH_COOKIE, '', { maxAge: 0 });
}

export function appendCookies(headers, cookies = []) {
  cookies.filter(Boolean).forEach((cookie) => headers.append('Set-Cookie', cookie));
  return headers;
}

export function jsonResponse(body, { status = 200, headers: extraHeaders = undefined, cookies = [] } = {}) {
  const headers = new Headers(extraHeaders);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store, max-age=0');
  headers.set('Pragma', 'no-cache');
  headers.set('X-Content-Type-Options', 'nosniff');
  appendCookies(headers, cookies);
  return new Response(JSON.stringify(body), { status, headers });
}

export function redirectResponse(location, { status = 303, cookies = [] } = {}) {
  const headers = new Headers({
    Location: location,
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  appendCookies(headers, cookies);
  return new Response(null, { status, headers });
}

export function errorResponse(error, { cookies = [] } = {}) {
  const normalized = normalizeError(error);
  return jsonResponse(
    {
      error: normalized.code,
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details === undefined ? {} : { details: normalized.details }),
    },
    { status: normalized.status, cookies },
  );
}

export function normalizeError(error) {
  if (error instanceof ApiError) return error;
  if (error instanceof GitHubApiError) {
    if (error.status === 401) return new ApiError(401, 'auth_required', 'GitHub 로그인이 만료되었거나 취소되었습니다. 다시 로그인하세요.');
    if (error.status === 403 && error.rateLimited) return new ApiError(503, 'github_rate_limited', 'GitHub API 요청 한도에 도달했습니다. 잠시 후 다시 시도하세요.');
    if (error.status === 403) return new ApiError(403, 'github_permission_denied', '이 GitHub 계정에는 저장소 게시 권한이 없습니다.');
    if (error.status === 404) return new ApiError(404, 'github_resource_not_found', 'GitHub App이 대상 저장소 또는 파일에 접근할 수 없습니다.');
    if (error.status === 409 || error.status === 422) return new ApiError(409, 'github_conflict', 'GitHub 브랜치가 변경되어 저장하지 못했습니다. 최신 내용을 다시 불러오세요.');
    return new ApiError(502, 'github_unavailable', 'GitHub API 요청을 완료하지 못했습니다. 잠시 후 다시 시도하세요.');
  }
  console.error('Unhandled Pages Function error', error instanceof Error ? { name: error.name, message: error.message } : typeof error);
  return new ApiError(500, 'internal_error', '서버에서 요청을 처리하지 못했습니다.');
}

export function assertSameOriginMutation(request, { requireAdminHeader = true } = {}) {
  const origin = request.headers.get('Origin');
  const expectedOrigin = new URL(request.url).origin;
  if (!origin || origin !== expectedOrigin) {
    throw new ApiError(403, 'origin_mismatch', '동일 출처의 관리자 요청만 허용됩니다.');
  }
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (fetchSite && fetchSite !== 'same-origin') {
    throw new ApiError(403, 'cross_site_request', '교차 사이트 관리자 요청은 허용되지 않습니다.');
  }
  if (requireAdminHeader && request.headers.get(ADMIN_REQUEST_HEADER) !== ADMIN_REQUEST_VALUE) {
    throw new ApiError(403, 'admin_header_required', `${ADMIN_REQUEST_HEADER}: ${ADMIN_REQUEST_VALUE} 헤더가 필요합니다.`);
  }
}

export async function githubRequest(path, token, {
  method = 'GET',
  body = undefined,
  bodyText = undefined,
  headers: extraHeaders = undefined,
} = {}) {
  const headers = new Headers(extraHeaders);
  headers.set('Accept', 'application/vnd.github+json');
  headers.set('Authorization', `Bearer ${token}`);
  headers.set('X-GitHub-Api-Version', GITHUB_API_VERSION);
  headers.set('User-Agent', 'EML-Website-Admin');
  let payload;
  if (body !== undefined && bodyText !== undefined) {
    throw new ApiError(500, 'invalid_github_request', 'GitHub 요청 본문 형식이 중복 지정되었습니다.');
  }
  if (body !== undefined || bodyText !== undefined) {
    headers.set('Content-Type', 'application/json; charset=utf-8');
    payload = bodyText !== undefined ? bodyText : JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(`https://api.github.com${path}`, { method, headers, body: payload });
  } catch (cause) {
    throw new GitHubApiError(0, cause instanceof Error ? cause.message : 'Network error', null, null);
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!response.ok) {
    const message = data && typeof data === 'object' && typeof data.message === 'string' ? data.message : `GitHub API ${response.status}`;
    throw new GitHubApiError(response.status, message, data, response.headers);
  }
  return data;
}

function repositoryApiPath(config) {
  return `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
}

export async function verifyAuthorizedUser(token, config) {
  const [user, repository] = await Promise.all([
    githubRequest('/user', token),
    githubRequest(repositoryApiPath(config), token),
  ]);

  const expectedFullName = `${config.owner}/${config.repo}`.toLowerCase();
  if (!repository || String(repository.full_name || '').toLowerCase() !== expectedFullName) {
    throw new ApiError(403, 'wrong_repository', 'GitHub App이 지정된 저장소에 설치되어 있지 않습니다.');
  }
  if (String(repository.id) !== config.repositoryId) {
    throw new ApiError(403, 'wrong_repository_id', '대상 GitHub 저장소 ID가 설정과 일치하지 않습니다.');
  }
  if (repository.archived || repository.disabled) {
    throw new ApiError(403, 'repository_read_only', '대상 GitHub 저장소가 보관 또는 비활성 상태입니다.');
  }
  if (repository.permissions?.push !== true) {
    throw new ApiError(403, 'push_permission_required', '이 GitHub 계정에는 대상 저장소의 push 권한이 없습니다.');
  }
  if (!user || !Number.isInteger(user.id) || typeof user.login !== 'string') {
    throw new ApiError(502, 'invalid_github_user', 'GitHub 사용자 정보를 확인하지 못했습니다.');
  }

  return {
    user: {
      id: user.id,
      login: user.login,
      name: typeof user.name === 'string' ? user.name : '',
      avatarUrl: typeof user.avatar_url === 'string' ? user.avatar_url : '',
      htmlUrl: typeof user.html_url === 'string' ? user.html_url : '',
    },
    repositoryId: String(repository.id),
  };
}

export async function createSessionCookie({ token, tokenExpiresIn, user, repositoryId }, env) {
  const now = Math.floor(Date.now() / 1000);
  const advertisedLifetime = Number.isFinite(Number(tokenExpiresIn)) ? Math.floor(Number(tokenExpiresIn)) : MAX_SESSION_SECONDS;
  const maxAge = Math.max(1, Math.min(MAX_SESSION_SECONDS, advertisedLifetime));
  const config = getRepositoryConfig(env);
  const payload = {
    v: 1,
    iat: now,
    exp: now + maxAge,
    token,
    user,
    repository: `${config.owner}/${config.repo}`,
    repositoryId,
  };
  const sealed = await sealCookiePayload(payload, env, 'eml-admin-session');
  return { cookie: serializeCookie(SESSION_COOKIE, sealed, { maxAge }), expiresAt: new Date(payload.exp * 1000).toISOString() };
}

export async function loadSession(request, env) {
  const sealed = parseCookies(request)[SESSION_COOKIE];
  if (!sealed) return null;
  const payload = await openCookiePayload(sealed, env, 'eml-admin-session');
  const now = Math.floor(Date.now() / 1000);
  const config = getRepositoryConfig(env);
  if (
    !payload || payload.v !== 1 || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)
    || payload.iat > now + 60 || payload.exp <= now || payload.exp - payload.iat > MAX_SESSION_SECONDS
    || typeof payload.token !== 'string' || payload.token.length < 20
    || !payload.user || !Number.isInteger(payload.user.id) || typeof payload.user.login !== 'string'
    || payload.repository !== `${config.owner}/${config.repo}`
    || payload.repositoryId !== config.repositoryId
  ) return null;
  return payload;
}

export async function requireSession(request, env) {
  const session = await loadSession(request, env);
  if (!session) throw new ApiError(401, 'auth_required', 'GitHub 관리자 로그인이 필요하거나 세션이 만료되었습니다.');
  return session;
}

export async function onRequestGet({ request, env }) {
  try {
    const session = await requireSession(request, env);
    const config = getRepositoryConfig(env);
    const verified = await verifyAuthorizedUser(session.token, config);
    if (verified.user.id !== session.user.id) throw new ApiError(401, 'session_user_changed', 'GitHub 로그인 사용자가 변경되었습니다. 다시 로그인하세요.');
    return jsonResponse({
      authenticated: true,
      user: verified.user,
      expiresAt: new Date(session.exp * 1000).toISOString(),
      repository: { owner: config.owner, repo: config.repo, branch: config.branch },
    });
  } catch (error) {
    const normalized = normalizeError(error);
    const clear = normalized.status === 401 || normalized.status === 403;
    return jsonResponse(
      { authenticated: false, user: null, error: normalized.code, code: normalized.code, message: normalized.message },
      { status: normalized.status, cookies: clear ? [clearSessionCookie()] : [] },
    );
  }
}
