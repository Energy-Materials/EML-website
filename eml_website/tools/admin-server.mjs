import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, open, realpath, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import {
  MAX_REQUEST_BYTES,
  MUTATION_HEADER,
  MUTATION_HEADER_VALUE,
  PROJECT_ROOT,
  assertValidContent,
  readCanonicalContent,
  validateReferencedAssets,
  writeCanonicalContent
} from './content-core.mjs';

const HOST = '127.0.0.1';
const PORT = 8767;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const LOCAL_ORIGINS = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);
const UPLOAD_ROOT = path.join(PROJECT_ROOT, 'assets', 'uploads');
const DENIED_TOP_LEVEL = new Set([
  '.git', '.github', '.idea', '.test-artifacts', '.wrangler', 'dist', 'functions', 'node_modules', 'supabase', 'tools'
]);
const DENIED_FILES = new Set([
  '.gitignore', 'admin-local.cmd', 'cloud-data.js', 'package.json', 'package-lock.json',
  'supabase-config.js', 'SUPABASE_SETUP.md'
]);
const MIME_TYPES = new Map([
  ['.avif', 'image/avif'], ['.css', 'text/css; charset=utf-8'], ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'], ['.ico', 'image/x-icon'], ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'], ['.js', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'], ['.svg', 'image/svg+xml; charset=utf-8'], ['.webp', 'image/webp']
]);
const IMAGE_TYPES = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif']
]);

let mutationQueue = Promise.resolve();

class HttpError extends Error {
  constructor(status, message, code = 'REQUEST_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function setSecurityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
}

function sendJson(response, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.end(body);
}

function requestHostIsLocal(request) {
  const host = request.headers.host?.toLowerCase();
  return host === `${HOST}:${PORT}` || host === `localhost:${PORT}`;
}

function enforceLocalRequest(request, { mutation = false } = {}) {
  if (!requestHostIsLocal(request)) throw new HttpError(403, 'Only the local admin address is allowed.', 'INVALID_HOST');
  const origin = request.headers.origin;
  if (origin && !LOCAL_ORIGINS.has(origin.toLowerCase())) {
    throw new HttpError(403, 'Cross-origin requests are not allowed.', 'INVALID_ORIGIN');
  }
  if (mutation) {
    const expectedOrigin = `http://${request.headers.host.toLowerCase()}`;
    if (!origin || origin.toLowerCase() !== expectedOrigin) {
      throw new HttpError(403, 'A same-origin browser request is required.', 'ORIGIN_REQUIRED');
    }
    if (request.headers[MUTATION_HEADER] !== MUTATION_HEADER_VALUE) {
      throw new HttpError(403, `Missing required ${MUTATION_HEADER} header.`, 'ADMIN_HEADER_REQUIRED');
    }
    const fetchSite = request.headers['sec-fetch-site'];
    if (fetchSite && fetchSite !== 'same-origin') {
      throw new HttpError(403, 'Cross-site mutations are not allowed.', 'CROSS_SITE_REQUEST');
    }
  }
}

async function readRequestBody(request) {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw new HttpError(413, 'Request body exceeds the 10 MB limit.', 'BODY_TOO_LARGE');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_REQUEST_BYTES) {
      request.destroy();
      throw new HttpError(413, 'Request body exceeds the 10 MB limit.', 'BODY_TOO_LARGE');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function requireContentType(request, expected) {
  const actual = String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (actual !== expected) throw new HttpError(415, `Content-Type must be ${expected}.`, 'INVALID_CONTENT_TYPE');
}

function enqueueMutation(operation) {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.catch(() => {});
  return result;
}

async function getContent(response) {
  const result = await readCanonicalContent({ verifyGenerated: true });
  sendJson(response, 200, result);
}

async function putContent(request, response) {
  requireContentType(request, 'application/json');
  const body = await readRequestBody(request);
  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.', 'INVALID_JSON');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new HttpError(400, 'Request body must be an object.', 'INVALID_PAYLOAD');
  }
  if (typeof payload.expectedRevision !== 'string' || !payload.expectedRevision) {
    throw new HttpError(400, 'expectedRevision is required.', 'REVISION_REQUIRED');
  }
  if (!payload.content || typeof payload.content !== 'object' || Array.isArray(payload.content)) {
    throw new HttpError(400, 'content must be an object.', 'INVALID_CONTENT');
  }

  const result = await enqueueMutation(async () => {
    const current = await readCanonicalContent({ verifyGenerated: true });
    if (payload.expectedRevision !== current.revision) {
      throw new HttpError(409, 'Content changed on disk. Reload before saving again.', 'REVISION_CONFLICT');
    }
    assertValidContent(payload.content);
    const assetErrors = await validateReferencedAssets(payload.content);
    if (assetErrors.length) {
      const error = new Error(`Referenced assets are invalid:\n- ${assetErrors.join('\n- ')}`);
      error.code = 'INVALID_CONTENT';
      error.validationErrors = assetErrors;
      throw error;
    }
    return writeCanonicalContent(payload.content);
  });
  sendJson(response, 200, result);
}

function imageBytesMatch(buffer, mediaType) {
  if (mediaType === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mediaType === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mediaType === 'image/gif') return buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'));
  if (mediaType === 'image/webp') return buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  return false;
}

function safeUploadStem(fileName) {
  const decoded = String(fileName || 'image').normalize('NFKD');
  const withoutExtension = decoded.replace(/\.[^.]*$/, '');
  const stem = withoutExtension
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .toLowerCase();
  return stem || 'image';
}

async function postMedia(request, response) {
  const mediaType = String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  const extension = IMAGE_TYPES.get(mediaType);
  if (!extension) throw new HttpError(415, 'Allowed image types: JPEG, PNG, WebP, and GIF.', 'INVALID_IMAGE_TYPE');
  const fileName = request.headers['x-file-name'];
  if (typeof fileName !== 'string' || !fileName.trim()) {
    throw new HttpError(400, 'X-File-Name is required.', 'FILE_NAME_REQUIRED');
  }
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    throw new HttpError(413, 'Optimized images must be 2 MB or smaller.', 'IMAGE_TOO_LARGE');
  }
  const body = await readRequestBody(request);
  if (!body.length) throw new HttpError(400, 'The uploaded image is empty.', 'EMPTY_IMAGE');
  if (body.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'Optimized images must be 2 MB or smaller.', 'IMAGE_TOO_LARGE');
  if (!imageBytesMatch(body, mediaType)) throw new HttpError(415, 'Image bytes do not match Content-Type.', 'IMAGE_SIGNATURE_MISMATCH');

  const date = new Date().toISOString().slice(0, 10);
  const directory = path.join(UPLOAD_ROOT, date);
  const absoluteUploadRoot = path.resolve(UPLOAD_ROOT);
  const outputName = `${safeUploadStem(fileName)}-${randomUUID()}${extension}`;
  const outputPath = path.resolve(directory, outputName);
  const relativeCheck = path.relative(absoluteUploadRoot, outputPath);
  if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) {
    throw new HttpError(400, 'Unsafe upload path.', 'UNSAFE_UPLOAD_PATH');
  }
  await mkdir(directory, { recursive: true });
  const handle = await open(outputPath, 'wx', 0o644);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const projectRelative = path.relative(PROJECT_ROOT, outputPath).replaceAll('\\', '/');
  sendJson(response, 201, { path: projectRelative });
}

function decodeStaticPath(url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, 'URL path is malformed.', 'INVALID_PATH');
  }
  if (pathname.includes('\0') || pathname.includes('\\')) throw new HttpError(400, 'URL path is malformed.', 'INVALID_PATH');
  const segments = pathname.split('/').filter(Boolean);
  const lowercaseSegments = segments.map((segment) => segment.toLowerCase());
  if (segments.some((segment) => segment === '.' || segment === '..')) throw new HttpError(403, 'Path traversal is forbidden.', 'INVALID_PATH');
  if (!segments.length) return 'index.html';
  if (DENIED_TOP_LEVEL.has(lowercaseSegments[0]) || DENIED_FILES.has(lowercaseSegments.at(-1)) || segments.some((segment) => segment.startsWith('.'))) {
    throw new HttpError(404, 'Not found.', 'NOT_FOUND');
  }
  return segments.join(path.sep);
}

async function serveStatic(request, response, url) {
  const relativePath = decodeStaticPath(url);
  let absolutePath = path.resolve(PROJECT_ROOT, relativePath);
  const relativeCheck = path.relative(PROJECT_ROOT, absolutePath);
  if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) throw new HttpError(403, 'Path traversal is forbidden.', 'INVALID_PATH');

  let metadata;
  try {
    metadata = await stat(absolutePath);
    if (metadata.isDirectory()) {
      absolutePath = path.join(absolutePath, 'index.html');
      metadata = await stat(absolutePath);
    }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new HttpError(404, 'Not found.', 'NOT_FOUND');
    throw error;
  }
  if (!metadata.isFile()) throw new HttpError(404, 'Not found.', 'NOT_FOUND');

  const [realRoot, realFile] = await Promise.all([realpath(PROJECT_ROOT), realpath(absolutePath)]);
  const realRelative = path.relative(realRoot, realFile);
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) throw new HttpError(403, 'Symlink traversal is forbidden.', 'INVALID_PATH');

  const contentType = MIME_TYPES.get(path.extname(realFile).toLowerCase()) || 'application/octet-stream';
  response.statusCode = 200;
  response.setHeader('Content-Type', contentType);
  response.setHeader('Content-Length', metadata.size);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const stream = createReadStream(realFile);
    stream.once('error', reject);
    response.once('finish', resolve);
    stream.pipe(response);
  });
}

async function route(request, response) {
  setSecurityHeaders(response);
  enforceLocalRequest(request, { mutation: request.method === 'PUT' || request.method === 'POST' || request.method === 'DELETE' || request.method === 'PATCH' });
  const url = new URL(request.url || '/', `http://${HOST}:${PORT}`);

  if (url.pathname === '/__eml_admin/content') {
    if (request.method === 'GET') return getContent(response);
    if (request.method === 'PUT') return putContent(request, response);
    response.setHeader('Allow', 'GET, PUT');
    throw new HttpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
  }
  if (url.pathname === '/__eml_admin/media') {
    if (request.method === 'POST') return postMedia(request, response);
    response.setHeader('Allow', 'POST');
    throw new HttpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    throw new HttpError(405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
  }
  return serveStatic(request, response, url);
}

function handleError(response, error) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const status = error instanceof HttpError
    ? error.status
    : error.code === 'INVALID_CONTENT'
      ? 422
      : error.code === 'CONTENT_TOO_LARGE'
        ? 413
        : 500;
  const code = error.code || 'INTERNAL_ERROR';
  if (status >= 500) process.stderr.write(`${error.stack || error.message}\n`);
  sendJson(response, status, {
    error: status >= 500 ? 'The local admin server could not complete the request.' : error.message,
    code,
    ...(Array.isArray(error.validationErrors) ? { details: error.validationErrors } : {})
  });
}

function openBrowser() {
  if (process.platform !== 'win32') return;
  const child = spawn('cmd.exe', ['/d', '/s', '/c', `start "" "http://${HOST}:${PORT}/admin.html"`], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const known = new Set(['--open', '--check', '--help']);
  const unknown = [...args].filter((argument) => !known.has(argument));
  if (unknown.length) throw new Error(`Unknown option: ${unknown.join(', ')}`);
  if (args.has('--help')) {
    process.stdout.write('Usage: node tools/admin-server.mjs [--open | --check]\n');
    return;
  }
  const checked = await readCanonicalContent({ verifyGenerated: true });
  if (args.has('--check')) {
    process.stdout.write(`Local admin preflight passed (${checked.revision}).\n`);
    return;
  }

  const server = http.createServer((request, response) => {
    route(request, response).catch((error) => handleError(response, error));
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;

  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      process.stderr.write(`Port ${PORT} is already in use. Close the other local admin server and try again.\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  });
  server.listen(PORT, HOST, () => {
    process.stdout.write(`EML local admin server: http://${HOST}:${PORT}/admin.html\n`);
    process.stdout.write('Keep this window open while editing. Press Ctrl+C to stop.\n');
    if (args.has('--open')) openBrowser();
  });

  const stop = () => server.close(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
