import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONTENT_JSON_PATH = path.join(PROJECT_ROOT, 'data', 'site-data.json');
export const CONTENT_JS_PATH = path.join(PROJECT_ROOT, 'data', 'site-data.js');
export const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
export const MUTATION_HEADER = 'x-eml-admin-request';
export const MUTATION_HEADER_VALUE = '1';

const REQUIRED_RECORDS = ['site', 'home', 'professor'];
const REQUIRED_RECORD_ARRAYS = [
  'researchTopics',
  'members',
  'alumni',
  'publications',
  'patents',
  'gallery'
];
const SUB_HERO_PAGE_KEYS = ['research', 'members', 'publications', 'gallery', 'contact'];
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_DEPTH = 24;
const MAX_NODES = 100_000;
const MAX_ARRAY_ITEMS = 5_000;
const MAX_STRING_LENGTH = 500_000;

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function describePath(segments) {
  return segments.length ? segments.join('.') : 'content';
}

function inspectJsonValue(value, errors, segments = [], state = { nodes: 0 }, depth = 0) {
  state.nodes += 1;
  const label = describePath(segments);

  if (state.nodes > MAX_NODES) {
    if (!errors.includes(`Content exceeds the ${MAX_NODES.toLocaleString('en-US')} value limit.`)) {
      errors.push(`Content exceeds the ${MAX_NODES.toLocaleString('en-US')} value limit.`);
    }
    return;
  }
  if (depth > MAX_DEPTH) {
    errors.push(`${label} is nested more than ${MAX_DEPTH} levels deep.`);
    return;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
      errors.push(`${label} exceeds ${MAX_STRING_LENGTH.toLocaleString('en-US')} characters.`);
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) errors.push(`${label} must be a finite number.`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) {
      errors.push(`${label} exceeds ${MAX_ARRAY_ITEMS.toLocaleString('en-US')} items.`);
      return;
    }
    value.forEach((entry, index) => inspectJsonValue(entry, errors, [...segments, String(index)], state, depth + 1));
    return;
  }
  if (!isPlainRecord(value)) {
    errors.push(`${label} must contain JSON-compatible values only.`);
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) errors.push(`${label} contains the forbidden key "${key}".`);
    inspectJsonValue(entry, errors, [...segments, key], state, depth + 1);
  }
}

function requireRecord(value, key, errors) {
  if (!isPlainRecord(value[key])) errors.push(`${key} must be an object.`);
}

function requireRecordArray(value, key, errors) {
  if (!Array.isArray(value[key])) {
    errors.push(`${key} must be an array.`);
    return;
  }
  value[key].forEach((entry, index) => {
    if (!isPlainRecord(entry)) errors.push(`${key}.${index} must be an object.`);
  });
}

function requireString(record, field, label, errors, { allowEmpty = true } = {}) {
  if (typeof record?.[field] !== 'string') {
    errors.push(`${label}.${field} must be a string.`);
  } else if (!allowEmpty && record[field].trim() === '') {
    errors.push(`${label}.${field} must not be empty.`);
  }
}

function requireStringArray(record, field, label, errors) {
  if (!Array.isArray(record?.[field])) {
    errors.push(`${label}.${field} must be an array.`);
    return;
  }
  record[field].forEach((entry, index) => {
    if (typeof entry !== 'string') errors.push(`${label}.${field}.${index} must be a string.`);
  });
}

function validateEmail(value, label, errors) {
  if (typeof value !== 'string') return;
  if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) errors.push(`${label} is not a valid email address.`);
}

function isSafeAssetPath(value) {
  if (value === '') return true;
  if (typeof value !== 'string' || value.length > 512 || value.includes('\\') || value.includes('\0')) return false;
  if (!/^assets\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) return false;
  if (/[?#]/.test(value)) return false;
  const segments = value.split('/');
  return segments.length >= 2 && segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function validateAssetPath(value, label, errors) {
  if (!isSafeAssetPath(value)) errors.push(`${label} must be a safe project path below assets/.`);
}

function isSafeExternalUrl(value) {
  if (value === '') return true;
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || value.length > 2048
    || /[\u0000-\u001f\u007f]/.test(value)
  ) return false;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol)
      && Boolean(parsed.hostname)
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}

function validateOptionalExternalUrl(entry, field, label, errors) {
  if (!Object.prototype.hasOwnProperty.call(entry, field)) return;
  if (entry[field] === null) return;
  if (typeof entry[field] !== 'string') {
    errors.push(`${label}.${field} must be a string or null.`);
    return;
  }
  if (!isSafeExternalUrl(entry[field])) {
    errors.push(`${label}.${field} must be null, empty, or an absolute http(s) URL without credentials.`);
  }
}

const IMAGE_DISPLAY_KEYS = ['positionX', 'positionY', 'zoom'];

function validateImageDisplay(display, label, errors) {
  if (!isPlainRecord(display)) {
    errors.push(`${label} must be an object.`);
    return;
  }
  Object.keys(display).forEach((key) => {
    if (!IMAGE_DISPLAY_KEYS.includes(key)) errors.push(`${label}.${key} is not supported.`);
  });
  IMAGE_DISPLAY_KEYS.forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(display, key) || typeof display[key] !== 'number' || !Number.isFinite(display[key])) {
      errors.push(`${label}.${key} must be a finite number.`);
    }
  });
  if (Number.isFinite(display.positionX) && (display.positionX < 0 || display.positionX > 100)) {
    errors.push(`${label}.positionX must be between 0 and 100.`);
  }
  if (Number.isFinite(display.positionY) && (display.positionY < 0 || display.positionY > 100)) {
    errors.push(`${label}.positionY must be between 0 and 100.`);
  }
  if (Number.isFinite(display.zoom) && (display.zoom < 1 || display.zoom > 4)) {
    errors.push(`${label}.zoom must be between 1 and 4.`);
  }
}

function validateOptionalImageDisplay(entry, field, label, errors) {
  if (!Object.prototype.hasOwnProperty.call(entry, field)) return;
  validateImageDisplay(entry[field], `${label}.${field}`, errors);
}

function validateKnownShape(content, errors) {
  REQUIRED_RECORDS.forEach((key) => requireRecord(content, key, errors));
  REQUIRED_RECORD_ARRAYS.forEach((key) => requireRecordArray(content, key, errors));
  requireString(content, 'researchStatement', 'content', errors);

  if (isPlainRecord(content.site)) {
    ['labName', 'labNameKr', 'university', 'universityKr', 'shortName', 'email', 'address', 'copyright',
      'logoWhite', 'logoDark', 'knuLogo', 'heroImage', 'mapEmbed', 'mapImage', 'phone', 'joinMessage']
      .forEach((field) => requireString(content.site, field, 'site', errors));
    ['logoWhite', 'logoDark', 'knuLogo', 'heroImage', 'mapImage'].forEach((field) => {
      if (typeof content.site[field] === 'string') validateAssetPath(content.site[field], `site.${field}`, errors);
    });
    if (Object.prototype.hasOwnProperty.call(content.site, 'subHeroImages')) {
      if (!isPlainRecord(content.site.subHeroImages)) {
        errors.push('site.subHeroImages must be an object.');
      } else {
        Object.keys(content.site.subHeroImages).forEach((key) => {
          if (!SUB_HERO_PAGE_KEYS.includes(key)) errors.push(`site.subHeroImages contains unsupported page key "${key}".`);
        });
        SUB_HERO_PAGE_KEYS.forEach((key) => {
          if (!Object.prototype.hasOwnProperty.call(content.site.subHeroImages, key)) return;
          requireString(content.site.subHeroImages, key, 'site.subHeroImages', errors);
          if (typeof content.site.subHeroImages[key] === 'string') {
            validateAssetPath(content.site.subHeroImages[key], `site.subHeroImages.${key}`, errors);
          }
        });
      }
    }
    validateEmail(content.site.email, 'site.email', errors);
    if (typeof content.site.mapEmbed === 'string' && content.site.mapEmbed && !/^https:\/\//i.test(content.site.mapEmbed)) {
      errors.push('site.mapEmbed must use an https:// URL.');
    }
  }

  if (isPlainRecord(content.home)) {
    ['eyebrow', 'subtitleKr', 'tagline', 'intro', 'ctaPrimary', 'ctaSecondary', 'ctaSecondaryRoute']
      .forEach((field) => requireString(content.home, field, 'home', errors));
    requireStringArray(content.home, 'titleLines', 'home', errors);
  }

  if (isPlainRecord(content.professor)) {
    ['name', 'role', 'department', 'email', 'photo'].forEach((field) => requireString(content.professor, field, 'professor', errors));
    ['education', 'experience', 'interest'].forEach((field) => requireStringArray(content.professor, field, 'professor', errors));
    if (typeof content.professor.photo === 'string') validateAssetPath(content.professor.photo, 'professor.photo', errors);
    validateEmail(content.professor.email, 'professor.email', errors);
    validateOptionalImageDisplay(content.professor, 'photoDisplay', 'professor', errors);
  }

  const seenResearchIds = new Set();
  (Array.isArray(content.researchTopics) ? content.researchTopics : []).forEach((entry, index) => {
    if (!isPlainRecord(entry)) return;
    const label = `researchTopics.${index}`;
    ['id', 'title', 'short', 'image', 'description'].forEach((field) => requireString(entry, field, label, errors));
    if (typeof entry.id === 'string') {
      if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(entry.id)) errors.push(`${label}.id must contain lowercase letters, numbers, or hyphens.`);
      if (seenResearchIds.has(entry.id)) errors.push(`${label}.id duplicates "${entry.id}".`);
      seenResearchIds.add(entry.id);
    }
    if (typeof entry.image === 'string') validateAssetPath(entry.image, `${label}.image`, errors);
  });

  (Array.isArray(content.members) ? content.members : []).forEach((entry, index) => {
    if (!isPlainRecord(entry)) return;
    const label = `members.${index}`;
    ['name', 'role', 'period', 'email', 'research', 'photo'].forEach((field) => requireString(entry, field, label, errors));
    if (typeof entry.photo === 'string') validateAssetPath(entry.photo, `${label}.photo`, errors);
    validateEmail(entry.email, `${label}.email`, errors);
    validateOptionalImageDisplay(entry, 'photoDisplay', label, errors);
  });

  (Array.isArray(content.alumni) ? content.alumni : []).forEach((entry, index) => {
    if (!isPlainRecord(entry)) return;
    ['date', 'name', 'next'].forEach((field) => requireString(entry, field, `alumni.${index}`, errors));
  });

  const seenPublicationNumbers = new Set();
  (Array.isArray(content.publications) ? content.publications : []).forEach((entry, index) => {
    if (!isPlainRecord(entry)) return;
    const label = `publications.${index}`;
    if (!Number.isInteger(entry.number) || entry.number <= 0) {
      errors.push(`${label}.number must be a positive integer.`);
    } else if (seenPublicationNumbers.has(entry.number)) {
      errors.push(`${label}.number duplicates ${entry.number}.`);
    } else {
      seenPublicationNumbers.add(entry.number);
    }
    ['year', 'title', 'authors', 'journal'].forEach((field) => requireString(entry, field, label, errors, { allowEmpty: false }));
    requireString(entry, 'note', label, errors);
    validateOptionalExternalUrl(entry, 'link_url', label, errors);
  });

  (Array.isArray(content.patents) ? content.patents : []).forEach((entry, index) => {
    if (!isPlainRecord(entry)) return;
    const label = `patents.${index}`;
    ['year', 'title', 'inventors', 'number'].forEach((field) => requireString(entry, field, label, errors));
    validateOptionalExternalUrl(entry, 'link_url', label, errors);
  });

  (Array.isArray(content.gallery) ? content.gallery : []).forEach((entry, index) => {
    if (!isPlainRecord(entry)) return;
    const label = `gallery.${index}`;
    ['date', 'title'].forEach((field) => requireString(entry, field, label, errors, { allowEmpty: false }));
    ['summary', 'image', 'body'].forEach((field) => requireString(entry, field, label, errors));
    requireStringArray(entry, 'images', label, errors);
    if (Array.isArray(entry.images) && entry.images.length === 0) {
      errors.push(`${label}.images must contain at least one image.`);
    }
    (Array.isArray(entry.images) ? entry.images : []).forEach((image, imageIndex) => {
      if (typeof image === 'string' && image.trim() === '') errors.push(`${label}.images.${imageIndex} must not be empty.`);
    });
    if (typeof entry.image === 'string' && Array.isArray(entry.images) && entry.images.length > 0 && entry.image !== entry.images[0]) {
      errors.push(`${label}.image must match the first gallery image.`);
    }
    if (typeof entry.image === 'string') validateAssetPath(entry.image, `${label}.image`, errors);
    (Array.isArray(entry.images) ? entry.images : []).forEach((image, imageIndex) => {
      if (typeof image === 'string') validateAssetPath(image, `${label}.images.${imageIndex}`, errors);
    });
    if (Object.prototype.hasOwnProperty.call(entry, 'imageDisplays')) {
      if (!Array.isArray(entry.imageDisplays)) {
        errors.push(`${label}.imageDisplays must be an array.`);
      } else {
        if (Array.isArray(entry.images) && entry.imageDisplays.length !== entry.images.length) {
          errors.push(`${label}.imageDisplays must have the same length as ${label}.images.`);
        }
        entry.imageDisplays.forEach((display, displayIndex) => {
          validateImageDisplay(display, `${label}.imageDisplays.${displayIndex}`, errors);
        });
      }
    }
  });
}

export function validateContent(content) {
  const errors = [];
  if (!isPlainRecord(content)) return { valid: false, errors: ['Content must be a JSON object.'] };
  inspectJsonValue(content, errors);
  validateKnownShape(content, errors);
  return { valid: errors.length === 0, errors };
}

export function assertValidContent(content) {
  const result = validateContent(content);
  if (!result.valid) {
    const error = new Error(`Content validation failed:\n- ${result.errors.join('\n- ')}`);
    error.code = 'INVALID_CONTENT';
    error.validationErrors = result.errors;
    throw error;
  }
  return content;
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

export function serializeContentJson(content) {
  assertValidContent(content);
  return `${JSON.stringify(sortJson(content), null, 2)}\n`;
}

export function serializeContentJs(content) {
  return `window.EML_DATA = ${serializeContentJson(content).trimEnd()};\n`;
}

export function revisionForContent(content) {
  return `sha256:${createHash('sha256').update(serializeContentJson(content), 'utf8').digest('hex')}`;
}

function normalizeLineEndings(value) {
  return value.replaceAll('\r\n', '\n');
}

export async function readCanonicalContent({ verifyGenerated = false } = {}) {
  const [source, metadata] = await Promise.all([
    readFile(CONTENT_JSON_PATH, 'utf8'),
    stat(CONTENT_JSON_PATH)
  ]);
  let content;
  try {
    content = JSON.parse(source);
  } catch (cause) {
    const error = new Error(`Could not parse ${path.relative(PROJECT_ROOT, CONTENT_JSON_PATH)}: ${cause.message}`);
    error.code = 'INVALID_JSON';
    throw error;
  }
  assertValidContent(content);

  const expectedJson = serializeContentJson(content);
  if (normalizeLineEndings(source) !== expectedJson) {
    const error = new Error('data/site-data.json is not in canonical format. Run npm run check -- --fix.');
    error.code = 'NON_CANONICAL_CONTENT';
    throw error;
  }

  if (verifyGenerated) {
    const generated = await readFile(CONTENT_JS_PATH, 'utf8');
    if (normalizeLineEndings(generated) !== serializeContentJs(content)) {
      const error = new Error('data/site-data.js is out of sync with data/site-data.json. Run npm run check -- --fix.');
      error.code = 'STALE_GENERATED_CONTENT';
      throw error;
    }
  }

  return {
    content,
    revision: revisionForContent(content),
    updatedAt: metadata.mtime.toISOString()
  };
}

async function writeTemporary(targetPath, contents) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return temporaryPath;
}

async function replaceFileAtomically(temporaryPath, targetPath) {
  try {
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function writeCanonicalContent(content) {
  assertValidContent(content);
  const json = serializeContentJson(content);
  if (Buffer.byteLength(json, 'utf8') > MAX_REQUEST_BYTES) {
    const error = new Error('Canonical content exceeds the 10 MB limit.');
    error.code = 'CONTENT_TOO_LARGE';
    throw error;
  }
  const javascript = serializeContentJs(content);
  const previous = await Promise.all([
    readFile(CONTENT_JSON_PATH).catch(() => null),
    readFile(CONTENT_JS_PATH).catch(() => null)
  ]);
  let jsonTemporary;
  let jsTemporary;
  try {
    jsonTemporary = await writeTemporary(CONTENT_JSON_PATH, json);
    jsTemporary = await writeTemporary(CONTENT_JS_PATH, javascript);
  } catch (error) {
    await Promise.all([
      jsonTemporary ? rm(jsonTemporary, { force: true }) : Promise.resolve(),
      jsTemporary ? rm(jsTemporary, { force: true }) : Promise.resolve()
    ]);
    throw error;
  }

  try {
    await replaceFileAtomically(jsonTemporary, CONTENT_JSON_PATH);
    await replaceFileAtomically(jsTemporary, CONTENT_JS_PATH);
  } catch (error) {
    await Promise.all([rm(jsonTemporary, { force: true }), rm(jsTemporary, { force: true })]);
    const rollbacks = [];
    rollbacks.push(previous[0] !== null
      ? writeTemporary(CONTENT_JSON_PATH, previous[0]).then((temporary) => replaceFileAtomically(temporary, CONTENT_JSON_PATH))
      : rm(CONTENT_JSON_PATH, { force: true }));
    rollbacks.push(previous[1] !== null
      ? writeTemporary(CONTENT_JS_PATH, previous[1]).then((temporary) => replaceFileAtomically(temporary, CONTENT_JS_PATH))
      : rm(CONTENT_JS_PATH, { force: true }));
    await Promise.allSettled(rollbacks);
    throw error;
  }

  return readCanonicalContent({ verifyGenerated: true });
}

export function collectAssetPaths(content) {
  const values = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value) values.add(value);
  };
  ['logoWhite', 'logoDark', 'knuLogo', 'heroImage', 'mapImage'].forEach((key) => add(content.site?.[key]));
  SUB_HERO_PAGE_KEYS.forEach((key) => add(content.site?.subHeroImages?.[key]));
  add(content.professor?.photo);
  content.researchTopics?.forEach((entry) => add(entry.image));
  content.members?.forEach((entry) => add(entry.photo));
  content.gallery?.forEach((entry) => {
    add(entry.image);
    entry.images?.forEach(add);
  });
  return [...values].sort();
}

export async function validateReferencedAssets(content) {
  const errors = [];
  for (const assetPath of collectAssetPaths(content)) {
    const absolutePath = path.resolve(PROJECT_ROOT, ...assetPath.split('/'));
    const relative = path.relative(path.join(PROJECT_ROOT, 'assets'), absolutePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      errors.push(`${assetPath} resolves outside assets/.`);
      continue;
    }
    try {
      let cursor = PROJECT_ROOT;
      for (const segment of assetPath.split('/')) {
        const entries = await readdir(cursor);
        if (!entries.includes(segment)) {
          errors.push(`${assetPath} has incorrect filename casing or does not exist.`);
          cursor = null;
          break;
        }
        cursor = path.join(cursor, segment);
      }
      if (!cursor) continue;
      await access(absolutePath, fsConstants.R_OK);
      const metadata = await stat(absolutePath);
      if (!metadata.isFile()) errors.push(`${assetPath} is not a file.`);
    } catch {
      errors.push(`${assetPath} does not exist.`);
    }
  }
  return errors;
}
