(function (global) {
  'use strict';

  const localContentEndpoint = '/__eml_admin/content';
  const localMediaEndpoint = '/__eml_admin/media';
  const remoteContentEndpoint = '/api/content';
  const remoteSessionEndpoint = '/api/auth/session';
  const mutationHeaders = Object.freeze({ 'X-EML-Admin-Request': '1' });
  const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  const extensionByType = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  const megabyte = 1024 * 1024;
  const maxSourceImageBytes = 32 * megabyte;
  const maxOptimizedImageBytes = 2 * megabyte;
  const targetOptimizedImageBytes = 700 * 1024;
  const maxImageEdge = 2560;
  const maxSelectionFiles = 10;
  const maxSelectionBytes = 80 * megabyte;
  const maxOptimizedSelectionBytes = 8 * megabyte;
  const maxRemoteSaveRequestBytes = 12 * megabyte;
  const optimizationConcurrency = 2;
  const embeddedImageDataPattern = /^data:image\/(?:jpeg|jpg|png|webp|gif);base64,/i;
  const uploadedImagePathPattern = /^assets\/uploads\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9._-]+\.(?:jpe?g|png|webp|gif)$/i;
  const optimizationQueue = [];
  const preparedDataUrls = new Set();
  let activeOptimizations = 0;

  function isLocalhost() {
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(global.location.hostname);
  }

  function assertLocalhost() {
    if (!isLocalhost() || !['http:', 'https:'].includes(global.location.protocol)) {
      throw new Error('관리자 편집기는 로컬 관리 서버에서만 사용할 수 있습니다.');
    }
  }

  function contentEndpoint() {
    return isLocalhost() ? localContentEndpoint : remoteContentEndpoint;
  }

  async function readResponse(response, fallbackMessage) {
    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (error) {
        if (response.ok) throw new Error('로컬 관리 서버가 올바르지 않은 응답을 보냈습니다.');
      }
    }

    if (!response.ok) {
      const baseMessage = payload.message || payload.error || fallbackMessage;
      const details = Array.isArray(payload.details)
        ? payload.details.filter((detail) => typeof detail === 'string' && detail.trim()).slice(0, 3)
        : [];
      const wrapped = new Error(details.length ? `${baseMessage}\n- ${details.join('\n- ')}` : baseMessage);
      wrapped.status = response.status;
      wrapped.code = response.status === 409
        ? 'EML_CONTENT_CONFLICT'
        : response.status === 401
          ? 'EML_AUTH_REQUIRED'
          : (payload.code || 'EML_CONTENT_SERVER_ERROR');
      wrapped.currentRevision = payload.currentRevision ?? payload.revision ?? null;
      throw wrapped;
    }
    return payload;
  }

  function normalizeContent(payload) {
    return {
      content: payload.content || null,
      revision: payload.revision ?? 0,
      updatedAt: payload.updatedAt || payload.updated_at || null,
    };
  }

  async function loadContent() {
    const response = await global.fetch(contentEndpoint(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
    });
    return normalizeContent(await readResponse(response, '저장소의 홈페이지 데이터를 불러오지 못했습니다.'));
  }

  async function saveContent(content, expectedRevision) {
    if (!isLocalhost()) validateEmbeddedImageLimits(content);
    const requestBody = JSON.stringify({ content, expectedRevision });
    if (!isLocalhost()) {
      const requestBytes = new global.TextEncoder().encode(requestBody).byteLength;
      if (requestBytes > maxRemoteSaveRequestBytes) {
        throw new Error(`대표 이미지 중복을 포함한 저장 데이터가 ${formatMegabytes(requestBytes)}입니다. 한 번 저장 한도인 12MB보다 작아지도록 새 사진 수를 줄여 나누어 게시하세요.`);
      }
    }
    const response = await global.fetch(contentEndpoint(), {
      method: 'PUT',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...mutationHeaders,
      },
      cache: 'no-store',
      credentials: 'same-origin',
      body: requestBody,
    });
    const saved = normalizeContent(await readResponse(
      response,
      response.status === 409
        ? '다른 편집 내용이 먼저 저장되었습니다. 최신 파일을 다시 불러온 뒤 수정하세요.'
        : '홈페이지 파일을 저장하지 못했습니다.',
    ));
    if (!saved.content) saved.content = content;
    return saved;
  }

  function formatMegabytes(bytes) {
    const value = bytes / megabyte;
    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}MB`;
  }

  function validateImage(file) {
    if (!file || !allowedImageTypes.has(String(file.type || '').toLowerCase())) {
      throw new Error('JPG, PNG, WebP 또는 GIF 이미지만 업로드할 수 있습니다.');
    }
    if (!Number.isFinite(file.size) || file.size <= 0) {
      throw new Error('비어 있거나 읽을 수 없는 이미지입니다.');
    }
    if (file.type === 'image/gif' && file.size > maxOptimizedImageBytes) {
      throw new Error('움직이는 GIF는 애니메이션 보존을 위해 압축하지 않습니다. 2MB 이하의 GIF를 선택하세요.');
    }
    if (file.type !== 'image/gif' && file.size > maxSourceImageBytes) {
      throw new Error(`원본 이미지 한 장은 ${formatMegabytes(maxSourceImageBytes)} 이하여야 합니다.`);
    }
    return file;
  }

  function validateImageSelection(files) {
    const list = Array.from(files || []);
    if (!list.length) throw new Error('업로드할 이미지를 선택하세요.');
    if (list.length > maxSelectionFiles) {
      throw new Error(`한 번에 이미지는 최대 ${maxSelectionFiles}장까지 선택할 수 있습니다.`);
    }
    list.forEach(validateImage);
    const totalBytes = list.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > maxSelectionBytes) {
      throw new Error(`한 번에 선택한 원본 이미지의 합계는 ${formatMegabytes(maxSelectionBytes)} 이하여야 합니다.`);
    }
    return list;
  }

  function dataUrlByteLength(value) {
    const match = /^data:image\/(?:jpeg|jpg|png|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/i.exec(value);
    if (!match) return null;
    const encoded = match[1].replace(/\s/g, '');
    const padding = encoded.endsWith('==') ? 2 : (encoded.endsWith('=') ? 1 : 0);
    return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
  }

  function validateEmbeddedImageLimits(content) {
    const stack = [content];
    const seenObjects = new Set();
    const seenImages = new Set();
    let totalBytes = 0;
    while (stack.length) {
      const value = stack.pop();
      if (typeof value === 'string') {
        if (!/^data:image\//i.test(value)) continue;
        if (seenImages.has(value)) continue;
        const bytes = dataUrlByteLength(value);
        if (bytes == null) continue;
        if (bytes > maxOptimizedImageBytes) {
          throw new Error('저장할 이미지 중 2MB를 넘는 파일이 있습니다. 이미지를 다시 선택해 자동 최적화하세요.');
        }
        seenImages.add(value);
        totalBytes += bytes;
        if (seenImages.size > maxSelectionFiles) {
          throw new Error(`한 번 저장할 때 새 이미지는 최대 ${maxSelectionFiles}장까지 게시할 수 있습니다.`);
        }
        if (totalBytes > maxOptimizedSelectionBytes) {
          throw new Error(`한 번 저장할 새 이미지의 합계는 최적화 후 ${formatMegabytes(maxOptimizedSelectionBytes)} 이하여야 합니다. 나누어 게시하세요.`);
        }
        continue;
      }
      if (!value || typeof value !== 'object' || seenObjects.has(value)) continue;
      seenObjects.add(value);
      if (Array.isArray(value)) stack.push(...value);
      else stack.push(...Object.values(value));
    }
  }

  function pumpOptimizationQueue() {
    while (activeOptimizations < optimizationConcurrency && optimizationQueue.length) {
      const entry = optimizationQueue.shift();
      activeOptimizations += 1;
      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          activeOptimizations -= 1;
          pumpOptimizationQueue();
        });
    }
  }

  function withOptimizationSlot(task) {
    return new Promise((resolve, reject) => {
      optimizationQueue.push({ task, resolve, reject });
      pumpOptimizationQueue();
    });
  }

  function validDimensions(width, height) {
    return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
  }

  async function decodeImage(file) {
    if (typeof global.createImageBitmap === 'function') {
      let bitmap;
      try {
        bitmap = await global.createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch (orientationError) {
        try {
          bitmap = await global.createImageBitmap(file);
        } catch {
          bitmap = null;
        }
      }
      if (bitmap) {
        if (!validDimensions(bitmap.width, bitmap.height)) {
          bitmap.close();
          throw new Error('이미지 크기를 확인할 수 없습니다.');
        }
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          cleanup: () => bitmap.close(),
        };
      }
    }

    if (!global.URL || typeof global.URL.createObjectURL !== 'function' || typeof global.Image !== 'function') {
      throw new Error('이 브라우저에서는 이미지를 변환할 수 없습니다.');
    }
    const objectUrl = global.URL.createObjectURL(file);
    const image = new global.Image();
    image.decoding = 'async';
    try {
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('이미지 파일을 해석하지 못했습니다.'));
        image.src = objectUrl;
      });
      if (!validDimensions(image.naturalWidth, image.naturalHeight)) {
        throw new Error('이미지 크기를 확인할 수 없습니다.');
      }
      return {
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        cleanup: () => {
          image.onload = null;
          image.onerror = null;
          image.removeAttribute('src');
          global.URL.revokeObjectURL(objectUrl);
        },
      };
    } catch (error) {
      image.onload = null;
      image.onerror = null;
      image.removeAttribute('src');
      global.URL.revokeObjectURL(objectUrl);
      throw error;
    }
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      try {
        canvas.toBlob(
          (blob) => {
            if (blob) resolve(blob);
            else reject(new Error('브라우저가 압축 이미지를 만들지 못했습니다.'));
          },
          type,
          quality,
        );
      } catch (error) {
        reject(error);
      }
    });
  }

  function drawCanvas(source, width, height) {
    const canvas = global.document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) throw new Error('브라우저 이미지 변환 기능을 사용할 수 없습니다.');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, width, height);
    return canvas;
  }

  function optimizedFile(blob, original) {
    const originalName = String(original.name || 'image');
    const stem = originalName.replace(/\.[^.]*$/, '') || 'image';
    const type = allowedImageTypes.has(blob.type) ? blob.type : original.type;
    const extension = extensionByType[type] || extensionByType[original.type] || 'jpg';
    return new global.File([blob], `${stem}.${extension}`, {
      type,
      lastModified: Number.isFinite(original.lastModified) ? original.lastModified : Date.now(),
    });
  }

  async function optimizeDecodedImage(file, decoded) {
    const initialScale = Math.min(1, maxImageEdge / Math.max(decoded.width, decoded.height));
    let width = Math.max(1, Math.round(decoded.width * initialScale));
    let height = Math.max(1, Math.round(decoded.height * initialScale));

    const requestedTypes = file.type === 'image/png'
      ? ['image/png', 'image/webp']
      : (file.type === 'image/jpeg' ? ['image/webp', 'image/jpeg'] : ['image/webp']);
    const qualitySteps = [0.86, 0.78, 0.7, 0.62, 0.54, 0.46];
    let bestWithinLimit = null;
    let smallest = null;

    for (let sizePass = 0; sizePass < 9; sizePass += 1) {
      const canvas = drawCanvas(decoded.source, width, height);
      for (const requestedType of requestedTypes) {
        const qualities = requestedType === 'image/png' ? [undefined] : qualitySteps;
        let supported = false;
        for (const quality of qualities) {
          const blob = await canvasToBlob(canvas, requestedType, quality);
          if (requestedType !== 'image/png' && blob.type !== requestedType) break;
          supported = true;
          if (!smallest || blob.size < smallest.size) smallest = blob;
          if (blob.size <= maxOptimizedImageBytes && (!bestWithinLimit || blob.size < bestWithinLimit.size)) {
            bestWithinLimit = blob;
          }
          if (blob.size <= targetOptimizedImageBytes) return optimizedFile(blob, file);
        }
        if (requestedType === 'image/webp' && supported) break;
      }
      width = Math.max(1, Math.round(width * 0.82));
      height = Math.max(1, Math.round(height * 0.82));
    }

    if (bestWithinLimit) return optimizedFile(bestWithinLimit, file);
    const smallestSize = smallest ? ` (최소 결과 ${formatMegabytes(smallest.size)})` : '';
    throw new Error(`이미지를 2MB 이하로 최적화하지 못했습니다${smallestSize}. 다른 이미지로 다시 시도하세요.`);
  }

  async function optimizeImageNow(file) {
    validateImage(file);
    if (file.type === 'image/gif') return file;
    let decoded;
    try {
      decoded = await decodeImage(file);
      return await optimizeDecodedImage(file, decoded);
    } catch (error) {
      throw new Error(`이미지를 최적화하지 못했습니다. 2MB 이하 파일로 다시 시도하세요. (${error.message})`);
    } finally {
      decoded?.cleanup();
    }
  }

  function prepareImage(file) {
    return withOptimizationSlot(() => optimizeImageNow(file));
  }

  function validateOptimizedBatch(files) {
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > maxOptimizedSelectionBytes) {
      throw new Error(`최적화된 이미지 합계가 ${formatMegabytes(maxOptimizedSelectionBytes)}를 넘습니다. 이미지를 나누어 추가하세요.`);
    }
  }

  function safeFileName(file) {
    const original = String(file.name || 'image').trim();
    const stem = original.replace(/\.[^.]*$/, '').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'image';
    const extension = extensionByType[file.type] || 'bin';
    return `${stem.slice(0, 80)}.${extension}`;
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new global.FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('이미지 파일을 읽지 못했습니다.'));
      reader.readAsDataURL(file);
    });
  }

  async function preparedFileToDataUrl(file) {
    const dataUrl = await fileToDataUrl(file);
    preparedDataUrls.add(dataUrl);
    return dataUrl;
  }

  function dataUrlToFile(dataUrl, label) {
    const match = /^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
    if (!match) throw new Error('지원하지 않거나 손상된 브라우저 이미지입니다.');
    const type = match[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : match[1].toLowerCase();
    const encoded = match[2].replace(/\s/g, '');
    const estimatedBytes = dataUrlByteLength(dataUrl);
    const sourceLimit = type === 'image/gif' ? maxOptimizedImageBytes : maxSourceImageBytes;
    if (estimatedBytes == null || estimatedBytes > sourceLimit) {
      throw new Error(type === 'image/gif'
        ? '움직이는 GIF는 2MB 이하만 사용할 수 있습니다.'
        : `브라우저 이미지 원본은 ${formatMegabytes(maxSourceImageBytes)} 이하여야 합니다.`);
    }
    let binary;
    try {
      binary = global.atob(encoded);
    } catch {
      throw new Error('브라우저 이미지의 Base64 데이터가 손상되었습니다.');
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const extension = extensionByType[type] || 'bin';
    return new global.File([bytes], `${label}.${extension}`, { type });
  }

  async function uploadImage(file) {
    const prepared = await prepareImage(file);
    return preparedFileToDataUrl(prepared);
  }

  async function uploadImages(files) {
    const selected = validateImageSelection(files);
    const prepared = await Promise.all(selected.map(prepareImage));
    validateOptimizedBatch(prepared);
    return Promise.all(prepared.map(preparedFileToDataUrl));
  }

  async function uploadPreparedImageLocally(file) {
    assertLocalhost();
    if (file.size > maxOptimizedImageBytes) {
      throw new Error('최적화된 이미지는 2MB 이하여야 합니다.');
    }
    const response = await global.fetch(localMediaEndpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': file.type,
        'X-File-Name': safeFileName(file),
        ...mutationHeaders,
      },
      cache: 'no-store',
      credentials: 'same-origin',
      body: file,
    });
    const payload = await readResponse(response, '이미지 파일을 저장하지 못했습니다.');
    const path = payload.path || payload.url || payload.src;
    if (!path || typeof path !== 'string') {
      throw new Error('로컬 관리 서버가 저장된 이미지 경로를 보내지 않았습니다.');
    }
    return path;
  }

  async function uploadDataUrl(dataUrl, label = 'legacy-image') {
    const wasPrepared = preparedDataUrls.has(dataUrl);
    const sourceFile = dataUrlToFile(dataUrl, label);
    const prepared = wasPrepared ? sourceFile : await prepareImage(sourceFile);
    if (prepared.size > maxOptimizedImageBytes) {
      throw new Error('최적화된 이미지는 2MB 이하여야 합니다.');
    }
    if (!isLocalhost()) {
      if (wasPrepared) return dataUrl;
      return preparedFileToDataUrl(prepared);
    }
    return uploadPreparedImageLocally(prepared);
  }

  function collectPendingImagePreviews(draft, published) {
    const previews = new Map();

    function visit(before, after) {
      if (typeof before === 'string' && typeof after === 'string') {
        if (embeddedImageDataPattern.test(before) && uploadedImagePathPattern.test(after)) {
          previews.set(after, before);
        }
        return;
      }
      if (Array.isArray(before) && Array.isArray(after)) {
        const length = Math.min(before.length, after.length);
        for (let index = 0; index < length; index += 1) visit(before[index], after[index]);
        return;
      }
      if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return;
      for (const key of Object.keys(before)) {
        if (Object.prototype.hasOwnProperty.call(after, key)) visit(before[key], after[key]);
      }
    }

    visit(draft, published);
    return Array.from(previews, ([path, preview]) => ({ path, preview }));
  }

  function delay(milliseconds, signal) {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timeout = global.setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve(true);
      }, milliseconds);
      const onAbort = () => {
        global.clearTimeout(timeout);
        resolve(false);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function uploadedImageIsReady(path, signal) {
    if (signal?.aborted) return false;
    try {
      const url = new global.URL(path, global.location.href);
      url.searchParams.set('__eml_deploy_check', String(Date.now()));
      const response = await global.fetch(url, {
        method: 'HEAD',
        headers: { Accept: 'image/*' },
        cache: 'no-store',
        credentials: 'same-origin',
        signal,
      });
      const contentType = response.headers.get('Content-Type') || '';
      return response.ok && (!contentType || contentType.toLowerCase().startsWith('image/'));
    } catch {
      return false;
    }
  }

  async function waitForUploadedImages(paths, options = {}) {
    const uniquePaths = [...new Set((paths || []).filter((path) => uploadedImagePathPattern.test(String(path))))];
    if (!uniquePaths.length || isLocalhost()) return { ready: true, paths: uniquePaths };

    const requestedTimeout = Number(options.timeoutMs);
    const requestedInterval = Number(options.intervalMs);
    const timeoutMs = Number.isFinite(requestedTimeout) ? Math.max(0, Math.min(requestedTimeout, 180000)) : 120000;
    const intervalMs = Number.isFinite(requestedInterval) ? Math.max(0, Math.min(requestedInterval, 10000)) : 2000;
    const deadline = Date.now() + timeoutMs;
    const sentinel = uniquePaths.at(-1);
    const signal = options.signal;

    while (true) {
      if (signal?.aborted) return { ready: false, aborted: true, paths: uniquePaths };
      if (await uploadedImageIsReady(sentinel, signal)) {
        const checks = await Promise.all(uniquePaths.map((path) => uploadedImageIsReady(path, signal)));
        if (checks.every(Boolean)) return { ready: true, paths: uniquePaths };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ready: false, paths: uniquePaths };
      if (!await delay(Math.min(intervalMs, remaining), signal)) {
        return { ready: false, aborted: true, paths: uniquePaths };
      }
    }
  }

  async function publishedContentIsReady(expectedJavascript, signal) {
    if (signal?.aborted) return false;
    try {
      const url = new global.URL('/data/site-data.js', global.location.href);
      url.searchParams.set('__eml_deploy_check', String(Date.now()));
      const response = await global.fetch(url, {
        method: 'GET',
        headers: { Accept: 'text/javascript, application/javascript' },
        cache: 'no-store',
        credentials: 'same-origin',
        signal,
      });
      if (!response.ok) return false;
      return (await response.text()).replaceAll('\r\n', '\n') === expectedJavascript;
    } catch {
      return false;
    }
  }

  async function waitForPublishedDeployment(content, paths = [], options = {}) {
    const uniquePaths = [...new Set((paths || []).filter((path) => uploadedImagePathPattern.test(String(path))))];
    if (isLocalhost()) return { ready: true, paths: uniquePaths };
    const expectedJavascript = `window.EML_DATA = ${JSON.stringify(content, null, 2)};\n`;
    const requestedTimeout = Number(options.timeoutMs);
    const requestedInterval = Number(options.intervalMs);
    const timeoutMs = Number.isFinite(requestedTimeout) ? Math.max(0, Math.min(requestedTimeout, 180000)) : 120000;
    const intervalMs = Number.isFinite(requestedInterval) ? Math.max(0, Math.min(requestedInterval, 10000)) : 2000;
    const deadline = Date.now() + timeoutMs;
    const signal = options.signal;

    while (true) {
      if (signal?.aborted) return { ready: false, aborted: true, paths: uniquePaths };
      if (await publishedContentIsReady(expectedJavascript, signal)) {
        if (!uniquePaths.length) return { ready: true, paths: uniquePaths };
        const imageResult = await waitForUploadedImages(uniquePaths, {
          timeoutMs: Math.max(0, deadline - Date.now()),
          intervalMs,
          signal,
        });
        return imageResult;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ready: false, paths: uniquePaths };
      if (!await delay(Math.min(intervalMs, remaining), signal)) {
        return { ready: false, aborted: true, paths: uniquePaths };
      }
    }
  }

  async function getSession() {
    if (isLocalhost()) {
      return { authenticated: true, user: { login: 'Local Git Editor' }, mode: 'local' };
    }
    const response = await global.fetch(remoteSessionEndpoint, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (response.status === 401 || response.status === 403) {
      let payload = {};
      try {
        payload = await response.json();
      } catch {
        payload = {};
      }
      const details = Array.isArray(payload.details)
        ? payload.details.filter((detail) => typeof detail === 'string' && detail.trim()).slice(0, 3)
        : [];
      const baseMessage = payload.message || payload.error || '';
      return {
        authenticated: false,
        user: null,
        mode: 'remote',
        code: payload.code || (response.status === 403 ? 'EML_PERMISSION_DENIED' : 'EML_AUTH_REQUIRED'),
        message: details.length ? `${baseMessage}\n- ${details.join('\n- ')}` : baseMessage,
      };
    }
    const payload = await readResponse(response, 'GitHub 로그인 상태를 확인하지 못했습니다.');
    return {
      authenticated: Boolean(payload.authenticated),
      user: payload.user || null,
      mode: 'remote',
    };
  }

  async function signOut() {
    if (isLocalhost()) return;
    const response = await global.fetch('/api/auth/logout', {
      method: 'POST',
      headers: { Accept: 'application/json', ...mutationHeaders },
      cache: 'no-store',
      credentials: 'same-origin',
    });
    await readResponse(response, 'GitHub 관리자 로그아웃에 실패했습니다.');
  }

  global.EMLLocalContent = Object.freeze({
    isLocalhost,
    getSession,
    signOut,
    loadContent,
    saveContent,
    validateImage,
    validateImageSelection,
    validatePendingImages: validateEmbeddedImageLimits,
    uploadImage,
    uploadImages,
    uploadDataUrl,
    collectPendingImagePreviews,
    waitForUploadedImages,
    waitForPublishedDeployment,
    imageLimits: Object.freeze({
      maxEdge: maxImageEdge,
      maxFileBytes: maxOptimizedImageBytes,
      maxFilesPerSave: maxSelectionFiles,
      maxNewImageBytesPerSave: maxOptimizedSelectionBytes,
    }),
  });
})(window);
