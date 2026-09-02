import {
  ApiError,
  GitHubApiError,
  assertSameOriginMutation,
  clearSessionCookie,
  getRepositoryConfig,
  githubRequest,
  jsonResponse,
  normalizeError,
  randomBase64Url,
  requireSession,
  verifyAuthorizedUser,
} from './auth/session.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
const MAX_CANONICAL_CONTENT_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_UNIQUE_IMAGES = 10;
const MAX_DEPTH = 24;
const MAX_NODES = 100_000;
const MAX_ARRAY_ITEMS = 5_000;
const MAX_STRING_LENGTH = 500_000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const REQUIRED_RECORDS = ['site', 'home', 'professor'];
const REQUIRED_RECORD_ARRAYS = ['researchTopics', 'members', 'alumni', 'publications', 'patents', 'gallery'];
const SUB_HERO_PAGE_KEYS = ['research', 'members', 'publications', 'gallery', 'contact'];
const REVISION_PATTERN = /^[0-9a-f]{40,64}$/i;
const IMAGE_DATA_PREFIX = /^data:image\//i;
const IMAGE_DATA_PATTERN = /^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i;

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function repositoryPath(config, suffix = '') {
  const base = `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
  return `${base}${suffix}`;
}

function encodeRepositoryFilePath(path) {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
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
  if (typeof value === 'string' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    errors.push(`${label} is not a valid email address.`);
  }
}

function isSafeAssetPath(value) {
  if (value === '') return true;
  if (typeof value !== 'string' || value.length > 512 || value.includes('\\') || value.includes('\0')) return false;
  if (!/^assets\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) return false;
  if (/[?#]/.test(value)) return false;
  const segments = value.split('/');
  return segments.length >= 2 && segments.every((segment) => segment && segment !== '.' && segment !== '..');
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
    if (Array.isArray(entry.images) && entry.images.length === 0) errors.push(`${label}.images must contain at least one image.`);
    if (typeof entry.image === 'string') validateAssetPath(entry.image, `${label}.image`, errors);
    (Array.isArray(entry.images) ? entry.images : []).forEach((image, imageIndex) => {
      if (typeof image === 'string') {
        if (image.trim() === '') errors.push(`${label}.images.${imageIndex} must not be empty.`);
        validateAssetPath(image, `${label}.images.${imageIndex}`, errors);
      }
    });
    if (typeof entry.image === 'string' && Array.isArray(entry.images) && typeof entry.images[0] === 'string'
      && entry.image !== entry.images[0]) {
      errors.push(`${label}.image must match the first item in ${label}.images.`);
    }
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

function validateContent(content) {
  const errors = [];
  if (!isPlainRecord(content)) return { valid: false, errors: ['Content must be a JSON object.'] };
  inspectJsonValue(content, errors);
  validateKnownShape(content, errors);
  return { valid: errors.length === 0, errors };
}

function assertValidContent(content) {
  const result = validateContent(content);
  if (!result.valid) {
    throw new ApiError(422, 'invalid_content', '홈페이지 데이터 검증에 실패했습니다.', result.errors.slice(0, 100));
  }
  return content;
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function serializeContent(content) {
  assertValidContent(content);
  const sorted = sortJson(content);
  const json = `${JSON.stringify(sorted, null, 2)}\n`;
  if (encoder.encode(json).byteLength > MAX_CANONICAL_CONTENT_BYTES) {
    throw new ApiError(413, 'content_too_large', '이미지를 파일로 분리한 홈페이지 JSON은 10MB 이하여야 합니다.');
  }
  return { sorted, json, javascript: `window.EML_DATA = ${json.trimEnd()};\n` };
}

function normalizeBase64(value) {
  const normalized = value.replace(/\s+/g, '');
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1 || /=/.test(normalized.slice(0, -2))) {
    throw new ApiError(422, 'invalid_image_data', 'Base64 이미지 데이터가 올바르지 않습니다.');
  }
  return normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
}

function normalizeInlineBase64(value) {
  if (value.length % 4 === 1) {
    throw new ApiError(422, 'invalid_image_data', 'Base64 이미지 데이터가 올바르지 않습니다.');
  }
  return value + '='.repeat((4 - (value.length % 4)) % 4);
}

function base64ByteLength(padded) {
  const padding = padded.endsWith('==') ? 2 : padded.endsWith('=') ? 1 : 0;
  return (padded.length / 4) * 3 - padding;
}

function decodeBase64(value) {
  const padded = normalizeBase64(value);
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new ApiError(422, 'invalid_image_data', 'Base64 이미지 데이터를 해석하지 못했습니다.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeBase64Prefix(padded, byteLimit = 12) {
  const encodedLimit = Math.ceil(byteLimit / 3) * 4;
  const prefix = padded.slice(0, Math.min(padded.length, encodedLimit));
  try {
    const binary = atob(prefix);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new ApiError(422, 'invalid_image_data', 'Base64 이미지 데이터를 해석하지 못했습니다.');
  }
}

function hasBytes(bytes, expected, offset = 0) {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function assertImageSignature(mime, bytes) {
  const valid = mime === 'image/jpeg'
    ? bytes.length >= 3 && hasBytes(bytes, [0xff, 0xd8, 0xff])
    : mime === 'image/png'
      ? bytes.length >= 8 && hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      : mime === 'image/gif'
        ? bytes.length >= 6 && (hasBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || hasBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))
        : mime === 'image/webp'
          ? bytes.length >= 12 && hasBytes(bytes, [0x52, 0x49, 0x46, 0x46]) && hasBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8)
          : false;
  if (!valid) throw new ApiError(422, 'image_signature_mismatch', `${mime} 선언과 실제 이미지 파일 형식이 일치하지 않습니다.`);
}

function migrateEmbeddedImages(content, config) {
  const bySource = new Map();
  const uploads = [];
  const date = new Date().toISOString().slice(0, 10);
  let totalBytes = 0;

  function migrateString(value, label) {
    if (!IMAGE_DATA_PREFIX.test(value)) return value;
    if (bySource.has(value)) return bySource.get(value).publicPath;
    const match = IMAGE_DATA_PATTERN.exec(value);
    if (!match) throw new ApiError(422, 'unsupported_image_data', `${label}에는 JPG, PNG, WebP 또는 GIF base64 이미지만 사용할 수 있습니다.`);
    if (uploads.length >= MAX_UNIQUE_IMAGES) {
      throw new ApiError(413, 'too_many_images', `한 번에 게시할 수 있는 새 이미지는 최대 ${MAX_UNIQUE_IMAGES}개입니다.`);
    }

    const requestedMime = match[1].toLowerCase();
    const mime = requestedMime === 'image/jpg' ? 'image/jpeg' : requestedMime;
    const extension = mime === 'image/jpeg' ? 'jpg' : mime.slice('image/'.length);
    const base64 = normalizeInlineBase64(match[2]);
    const byteLength = base64ByteLength(base64);
    if (!byteLength || byteLength > MAX_IMAGE_BYTES) {
      throw new ApiError(413, 'image_too_large', `${label} 이미지 파일은 2MB 이하여야 합니다.`);
    }
    totalBytes += byteLength;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      throw new ApiError(413, 'images_too_large', '한 번의 게시 요청에 포함된 새 이미지 합계는 8MB 이하여야 합니다.');
    }
    // GitHub's blob API accepts base64 directly. Decode only the signature prefix so
    // Pages Free CPU is not spent decoding and re-encoding multi-megabyte images.
    assertImageSignature(mime, decodeBase64Prefix(base64));
    const filename = `image-${randomBase64Url(18)}.${extension}`;
    const publicPath = `assets/uploads/${date}/${filename}`;
    const repoPath = `${config.assetsPath}/${date}/${filename}`;
    const upload = { publicPath, repoPath, mime, base64, byteLength };
    bySource.set(value, upload);
    uploads.push(upload);
    return publicPath;
  }

  function walk(value, segments = [], depth = 0) {
    if (depth > MAX_DEPTH) throw new ApiError(422, 'content_too_deep', `Content is nested more than ${MAX_DEPTH} levels deep.`);
    if (typeof value === 'string') return migrateString(value, describePath(segments));
    if (Array.isArray(value)) {
      const output = [];
      for (let index = 0; index < value.length; index += 1) output.push(walk(value[index], [...segments, String(index)], depth + 1));
      return output;
    }
    if (isPlainRecord(value)) {
      const output = {};
      for (const [key, entry] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.has(key)) throw new ApiError(422, 'forbidden_content_key', `Content contains the forbidden key "${key}".`);
        output[key] = walk(entry, [...segments, key], depth + 1);
      }
      return output;
    }
    return value;
  }

  return { content: walk(content), uploads };
}

function collectAssetPaths(content) {
  const values = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value) values.add(value);
  };
  ['logoWhite', 'logoDark', 'knuLogo', 'heroImage', 'mapImage'].forEach((key) => add(content.site?.[key]));
  SUB_HERO_PAGE_KEYS.forEach((key) => add(content.site?.subHeroImages?.[key]));
  add(content.professor?.photo);
  (Array.isArray(content.researchTopics) ? content.researchTopics : []).forEach((entry) => add(entry.image));
  (Array.isArray(content.members) ? content.members : []).forEach((entry) => add(entry.photo));
  (Array.isArray(content.gallery) ? content.gallery : []).forEach((entry) => {
    add(entry.image);
    (Array.isArray(entry.images) ? entry.images : []).forEach(add);
  });
  return [...values].sort();
}

function validateReferencedAssets(content, config, treeEntries, uploads) {
  const currentPaths = new Set(treeEntries.filter((entry) => entry.type === 'blob').map((entry) => entry.path));
  const newPaths = new Set(uploads.map((entry) => entry.repoPath));
  const missing = [];
  for (const asset of collectAssetPaths(content)) {
    const repoPath = [config.siteRoot, asset].filter(Boolean).join('/');
    if (!currentPaths.has(repoPath) && !newPaths.has(repoPath)) missing.push(asset);
  }
  if (missing.length) {
    throw new ApiError(422, 'missing_assets', '홈페이지 데이터가 저장소에 없는 이미지 파일을 참조합니다.', missing.slice(0, 50));
  }
}

function decodeGitBlob(blob) {
  if (!blob || blob.encoding !== 'base64' || typeof blob.content !== 'string') {
    throw new ApiError(502, 'invalid_github_blob', 'GitHub 콘텐츠 파일 응답 형식이 올바르지 않습니다.');
  }
  try {
    return decoder.decode(decodeBase64(blob.content));
  } catch {
    throw new ApiError(502, 'invalid_github_blob', 'GitHub 콘텐츠 파일을 UTF-8로 읽지 못했습니다.');
  }
}

async function loadRepositorySnapshot(token, config, { includeTree = false } = {}) {
  const refPath = repositoryPath(config, `/git/ref/heads/${encodeURIComponent(config.branch)}`);
  const ref = await githubRequest(refPath, token);
  const headSha = ref?.object?.sha;
  if (!REVISION_PATTERN.test(String(headSha || ''))) {
    throw new ApiError(502, 'invalid_branch_ref', 'GitHub develop 브랜치의 최신 commit을 확인하지 못했습니다.');
  }

  const filePath = repositoryPath(config, `/contents/${encodeRepositoryFilePath(config.contentPath)}?ref=${encodeURIComponent(headSha)}`);
  const commitPath = repositoryPath(config, `/git/commits/${encodeURIComponent(headSha)}`);
  const historyPath = repositoryPath(
    config,
    `/commits?path=${encodeURIComponent(config.contentPath)}&sha=${encodeURIComponent(config.branch)}&per_page=1`,
  );
  const [file, commit, history] = await Promise.all([
    githubRequest(filePath, token),
    githubRequest(commitPath, token),
    githubRequest(historyPath, token),
  ]);
  if (!file || Array.isArray(file) || file.type !== 'file' || !REVISION_PATTERN.test(String(file.sha || ''))) {
    throw new ApiError(502, 'invalid_content_file', 'GitHub 홈페이지 콘텐츠 파일 정보를 확인하지 못했습니다.');
  }
  const blob = await githubRequest(repositoryPath(config, `/git/blobs/${encodeURIComponent(file.sha)}`), token);
  let content;
  try {
    content = JSON.parse(decodeGitBlob(blob));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, 'invalid_content_json', 'GitHub의 홈페이지 콘텐츠 JSON이 올바르지 않습니다.');
  }
  assertValidContent(content);

  const result = {
    content,
    revision: file.sha,
    headSha,
    treeSha: commit?.tree?.sha,
    updatedAt: history?.[0]?.commit?.committer?.date || history?.[0]?.commit?.author?.date || commit?.committer?.date || null,
  };
  if (!REVISION_PATTERN.test(String(result.treeSha || ''))) {
    throw new ApiError(502, 'invalid_commit_tree', 'GitHub commit tree를 확인하지 못했습니다.');
  }
  if (includeTree) {
    const tree = await githubRequest(repositoryPath(config, `/git/trees/${encodeURIComponent(result.treeSha)}?recursive=1`), token);
    if (!tree || tree.truncated || !Array.isArray(tree.tree)) {
      throw new ApiError(502, 'repository_tree_too_large', '이미지 경로 검증을 위한 GitHub tree를 완전히 읽지 못했습니다.');
    }
    result.treeEntries = tree.tree;
  }
  return result;
}

async function requireAuthorizedSession(request, env) {
  const session = await requireSession(request, env);
  const config = getRepositoryConfig(env);
  const verified = await verifyAuthorizedUser(session.token, config);
  if (verified.user.id !== session.user.id) {
    throw new ApiError(401, 'session_user_changed', 'GitHub 로그인 사용자가 변경되었습니다. 다시 로그인하세요.');
  }
  return { session, config, user: verified.user };
}

async function readJsonBody(request) {
  const contentType = (request.headers.get('Content-Type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw new ApiError(415, 'json_required', 'Content-Type: application/json 요청만 허용됩니다.');
  }
  const advertisedLength = Number(request.headers.get('Content-Length') || 0);
  if (Number.isFinite(advertisedLength) && advertisedLength > MAX_REQUEST_BYTES) {
    throw new ApiError(413, 'request_too_large', '게시 요청은 최대 12MB입니다.');
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_REQUEST_BYTES) {
    throw new ApiError(413, 'request_too_large', '게시 요청은 최대 12MB입니다.');
  }
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new ApiError(400, 'invalid_json_encoding', '요청 본문은 올바른 UTF-8 JSON이어야 합니다.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'invalid_json', '요청 본문이 올바른 JSON이 아닙니다.');
  }
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const output = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return output;
}

async function createBlob(token, config, content, encoding = 'utf-8') {
  const options = encoding === 'base64'
    ? { method: 'POST', bodyText: `{"content":"${content}","encoding":"base64"}` }
    : { method: 'POST', body: { content, encoding } };
  const result = await githubRequest(repositoryPath(config, '/git/blobs'), token, options);
  if (!REVISION_PATTERN.test(String(result?.sha || ''))) {
    throw new ApiError(502, 'invalid_created_blob', 'GitHub이 생성한 blob 정보를 확인하지 못했습니다.');
  }
  return result.sha;
}

function cleanCommitMessage(value, userLogin) {
  const fallback = `content: update website via admin (${userLogin})`;
  if (typeof value !== 'string') return fallback;
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 120) : fallback;
}

async function publishCommit({ token, config, user, snapshot, serialized, uploads, message }) {
  const blobInputs = [
    { path: config.contentPath, content: serialized.json, encoding: 'utf-8' },
    { path: config.generatedPath, content: serialized.javascript, encoding: 'utf-8' },
    ...uploads.map((upload) => ({ path: upload.repoPath, content: upload.base64, encoding: 'base64' })),
  ];
  const blobShas = await mapWithConcurrency(blobInputs, 4, (entry) => createBlob(token, config, entry.content, entry.encoding));
  const treeEntries = blobInputs.map((entry, index) => ({
    path: entry.path,
    mode: '100644',
    type: 'blob',
    sha: blobShas[index],
  }));
  const tree = await githubRequest(repositoryPath(config, '/git/trees'), token, {
    method: 'POST',
    body: { base_tree: snapshot.treeSha, tree: treeEntries },
  });
  if (!REVISION_PATTERN.test(String(tree?.sha || ''))) {
    throw new ApiError(502, 'invalid_created_tree', 'GitHub이 생성한 tree 정보를 확인하지 못했습니다.');
  }
  const commitMessage = cleanCommitMessage(message, user.login);
  const commit = await githubRequest(repositoryPath(config, '/git/commits'), token, {
    method: 'POST',
    body: { message: commitMessage, tree: tree.sha, parents: [snapshot.headSha] },
  });
  if (!REVISION_PATTERN.test(String(commit?.sha || ''))) {
    throw new ApiError(502, 'invalid_created_commit', 'GitHub이 생성한 commit 정보를 확인하지 못했습니다.');
  }

  try {
    await githubRequest(repositoryPath(config, `/git/refs/heads/${encodeURIComponent(config.branch)}`), token, {
      method: 'PATCH',
      body: { sha: commit.sha, force: false },
    });
  } catch (error) {
    if (error instanceof GitHubApiError && (error.status === 409 || error.status === 422)) {
      let currentRevision = null;
      let currentHead = null;
      try {
        const latest = await loadRepositorySnapshot(token, config);
        currentRevision = latest.revision;
        currentHead = latest.headSha;
      } catch {
        // Preserve the original non-fast-forward error when the refresh also fails.
      }
      if (error.status === 422 && currentHead === snapshot.headSha) {
        throw new ApiError(
          403,
          'branch_update_rejected',
          'GitHub가 develop 직접 갱신을 거부했습니다. GitHub App의 Contents 쓰기 권한과 develop ruleset의 direct push 허용 대상을 확인하세요.',
          { currentRevision },
        );
      }
      throw new ApiError(409, 'revision_conflict', '게시 중 develop 브랜치가 변경되었습니다. 최신 내용을 다시 불러오세요.', { currentRevision });
    }
    throw error;
  }

  return {
    revision: blobShas[0],
    updatedAt: commit.committer?.date || commit.author?.date || new Date().toISOString(),
    commit: {
      sha: commit.sha,
      message: commitMessage,
      htmlUrl: typeof commit.html_url === 'string' ? commit.html_url : '',
    },
  };
}

function contentErrorResponse(error) {
  const normalized = normalizeError(error);
  const currentRevision = normalized.details?.currentRevision || null;
  return jsonResponse(
    {
      error: normalized.code,
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details === undefined ? {} : { details: normalized.details }),
      ...(currentRevision ? { currentRevision, revision: currentRevision } : {}),
    },
    {
      status: normalized.status,
      cookies: normalized.status === 401 ? [clearSessionCookie()] : [],
    },
  );
}

async function handleGet({ request, env }) {
  try {
    const { session, config } = await requireAuthorizedSession(request, env);
    const snapshot = await loadRepositorySnapshot(session.token, config);
    return jsonResponse(
      { content: snapshot.content, revision: snapshot.revision, updatedAt: snapshot.updatedAt },
      { headers: { ETag: `"${snapshot.revision}"` } },
    );
  } catch (error) {
    return contentErrorResponse(error);
  }
}

async function handlePut({ request, env }) {
  try {
    assertSameOriginMutation(request);
    const { session, config, user } = await requireAuthorizedSession(request, env);
    const body = await readJsonBody(request);
    if (!isPlainRecord(body) || !('content' in body)) {
      throw new ApiError(400, 'content_required', '요청 본문에 content 객체가 필요합니다.');
    }
    if (typeof body.expectedRevision !== 'string' || !REVISION_PATTERN.test(body.expectedRevision)) {
      throw new ApiError(400, 'expected_revision_required', '유효한 expectedRevision Git blob SHA가 필요합니다.');
    }

    const snapshot = await loadRepositorySnapshot(session.token, config, { includeTree: true });
    if (!constantRevision(body.expectedRevision, snapshot.revision)) {
      throw new ApiError(409, 'revision_conflict', '다른 관리자가 먼저 게시했습니다. 최신 내용을 다시 불러오세요.', {
        currentRevision: snapshot.revision,
      });
    }

    const migrated = await migrateEmbeddedImages(body.content, config);
    const serialized = serializeContent(migrated.content);
    validateReferencedAssets(serialized.sorted, config, snapshot.treeEntries, migrated.uploads);
    const published = await publishCommit({
      token: session.token,
      config,
      user,
      snapshot,
      serialized,
      uploads: migrated.uploads,
      message: body.message,
    });
    return jsonResponse({
      content: serialized.sorted,
      revision: published.revision,
      updatedAt: published.updatedAt,
      commit: published.commit,
    });
  } catch (error) {
    return contentErrorResponse(error);
  }
}

function constantRevision(left, right) {
  const a = String(left || '').toLowerCase();
  const b = String(right || '').toLowerCase();
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  return difference === 0;
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return handleGet(context);
  if (context.request.method === 'PUT') return handlePut(context);
  if (context.request.method === 'OPTIONS') {
    return jsonResponse(
      { error: 'method_not_allowed', code: 'method_not_allowed', message: '교차 출처 요청은 지원하지 않습니다.' },
      { status: 405, headers: { Allow: 'GET, PUT' } },
    );
  }
  return jsonResponse(
    { error: 'method_not_allowed', code: 'method_not_allowed', message: 'GET 또는 PUT 요청만 허용됩니다.' },
    { status: 405, headers: { Allow: 'GET, PUT' } },
  );
}

export { handleGet as onRequestGet, handlePut as onRequestPut };
