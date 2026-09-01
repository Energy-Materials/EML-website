(function () {
  const storageKey = 'emlDataV2';
  const defaultSubHeroImage = 'assets/hero-concept-from-pdf.png';
  const subHeroPages = Object.freeze([
    { key: 'research', title: 'Research', description: '연구 분야와 Research Topic 상단 배너' },
    { key: 'members', title: 'Members', description: 'Professor, Members, Alumni 상단 배너' },
    { key: 'publications', title: 'Publications', description: '논문과 특허 목록 상단 배너' },
    { key: 'gallery', title: 'Gallery', description: '연구실 사진과 소식 목록 상단 배너' },
    { key: 'contact', title: 'Contact', description: '연락처와 찾아오는 길 상단 배너' },
  ]);
  const sidebar = document.querySelector('[data-sidebar]');
  const content = document.querySelector('[data-admin-content]');
  const authShell = document.querySelector('[data-auth-shell]');
  const authLoading = document.querySelector('[data-auth-loading]');
  const loginPanel = document.querySelector('[data-login-panel]');
  const authError = document.querySelector('[data-auth-error]');
  const adminApp = document.querySelector('[data-admin-app]');
  const adminActions = document.querySelector('[data-admin-actions]');
  const localState = document.querySelector('[data-local-state]');
  const adminUser = document.querySelector('[data-admin-user]');
  const topSave = document.querySelector('[data-top-save]');
  const sessionDraftExport = document.querySelector('[data-export-session-draft]');
  let activeSection = 'dashboard';
  let dragImage = null;
  let data = clone(window.EML_DATA || {});
  let loadedRevision = 0;
  let loadedUpdatedAt = null;
  let hasPublishedContent = false;
  let editorReady = false;
  let saveInFlight = null;
  let isDirty = false;
  let editSequence = 0;
  let sessionDraft = null;
  let activeUserId = null;
  let editorMode = 'local';
  let editorEpoch = 0;
  let busyOwner = null;
  const embeddedUploadCache = new Map();
  const pendingImagePreviews = new Map();
  let deploymentPreviewRun = 0;
  let deploymentReadyPromise = Promise.resolve({ ready: true, paths: [] });
  let deploymentAbortController = null;
  let deploymentInProgress = false;
  let deploymentWatchSettled = true;
  let pendingPublishedContent = null;

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  function isValidSiteData(value) {
    return Boolean(window.EMLDataSchema && window.EMLDataSchema.validate(value).valid);
  }

  function getLegacyDraft() {
    try {
      const saved = localStorage.getItem(storageKey);
      if (!saved) return null;
      const parsed = JSON.parse(saved);
      return isValidSiteData(parsed) ? parsed : null;
    } catch (error) {
      console.warn(error);
      return null;
    }
  }

  function setStorageState(message, type = '') {
    localState.textContent = message;
    localState.classList.toggle('is-saving', type === 'saving');
    localState.classList.toggle('is-error', type === 'error');
  }

  function setBusy(busy, message = 'Git 콘텐츠 연결됨') {
    document.body.classList.toggle('is-busy', busy);
    adminApp.inert = busy;
    adminActions.inert = busy;
    adminApp.setAttribute('aria-busy', String(busy));
    if (busy) setStorageState(message, 'saving');
  }

  function beginBusy(message) {
    const owner = Symbol('busy-operation');
    busyOwner = owner;
    setBusy(true, message);
    return owner;
  }

  function endBusy(owner) {
    if (busyOwner !== owner) return;
    busyOwner = null;
    setBusy(false);
  }

  function markDirty() {
    isDirty = true;
    topSave.disabled = false;
    editSequence += 1;
    setStorageState('저장되지 않은 변경', 'saving');
  }

  function formatUpdatedAt(value) {
    if (!value) return '';
    try {
      return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
    } catch (error) {
      return String(value);
    }
  }

  function updateStorageNotice(message = '') {
    const heading = document.querySelector('[data-local-heading]');
    const detail = document.querySelector('[data-local-detail]');
    if (heading) heading.textContent = hasPublishedContent ? 'Git 홈페이지 콘텐츠 관리' : '첫 저장 준비 완료';
    if (detail) {
      detail.textContent = message || (hasPublishedContent
        ? `현재 Git 버전 ${formatRevision(loadedRevision)} · 마지막 저장 ${formatUpdatedAt(loadedUpdatedAt)}`
        : '아직 저장된 Git 콘텐츠가 없습니다. 기본 데이터를 확인한 뒤 Save Changes를 눌러 처음 저장하세요.');
    }
  }

  function formatRevision(value) {
    const revision = String(value ?? '0');
    if (revision.length <= 20) return revision;
    if (revision.startsWith('sha256:')) return `sha256:${revision.slice(7, 19)}…`;
    return `${revision.slice(0, 16)}…`;
  }

  function revisionFileLabel(value) {
    return String(value ?? '0').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40) || 'unknown';
  }

  function escapeHTML(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }
  function escapeAttr(value) { return escapeHTML(value).replaceAll('`', '&#096;'); }

  function imagePreviewSource(value) {
    const publishedPath = String(value || '');
    const pendingPreview = pendingImagePreviews.get(publishedPath);
    if (pendingPreview) return pendingPreview;
    if (!publishedPath.startsWith('assets/uploads/')) return publishedPath;
    const revision = encodeURIComponent(String(loadedRevision || 'latest').slice(0, 48));
    return `${publishedPath}?__eml_admin_revision=${revision}`;
  }

  function imageIsDeploying(value) {
    return pendingImagePreviews.has(String(value || ''));
  }

  function rememberPendingImagePreviews(draft, published) {
    if (editorMode === 'local' || !window.EMLLocalContent.collectPendingImagePreviews) return [];
    const pending = window.EMLLocalContent.collectPendingImagePreviews(draft, published);
    pending.forEach(({ path, preview }) => pendingImagePreviews.set(path, preview));
    return pending;
  }

  function showPublishedImages(paths) {
    const published = new Set(paths);
    document.querySelectorAll('[data-published-src]').forEach((image) => {
      const path = image.dataset.publishedSrc;
      if (!published.has(path)) return;
      image.src = imagePreviewSource(path);
      const container = image.closest('.image-tile, .dropzone');
      container?.classList.remove('is-deploying');
      container?.querySelectorAll('[data-deployment-badge]').forEach((badge) => badge.remove());
      container?.querySelectorAll('[data-deployment-note]').forEach((note) => note.remove());
    });
    document.querySelectorAll('[data-published-background]').forEach((element) => {
      const path = element.dataset.publishedBackground;
      if (!published.has(path)) return;
      element.style.backgroundImage = `linear-gradient(90deg, rgba(5,16,28,.82), rgba(5,16,28,.26)), url('${imagePreviewSource(path)}')`;
    });
  }

  function cancelDeploymentPreview() {
    deploymentPreviewRun += 1;
    deploymentAbortController?.abort();
    deploymentAbortController = null;
    deploymentInProgress = false;
    deploymentWatchSettled = true;
    pendingPublishedContent = null;
    pendingImagePreviews.clear();
    deploymentReadyPromise = Promise.resolve({ ready: true, paths: [] });
  }

  function startDeploymentWatch(publishedContent = pendingPublishedContent) {
    const paths = [...pendingImagePreviews.keys()];
    if (!publishedContent || editorMode === 'local') {
      deploymentReadyPromise = Promise.resolve({ ready: true, paths: [] });
      return deploymentReadyPromise;
    }

    deploymentAbortController?.abort();
    deploymentAbortController = new AbortController();
    const run = ++deploymentPreviewRun;
    const watchEpoch = editorEpoch;
    const watchUserId = activeUserId;
    const signal = deploymentAbortController.signal;
    pendingPublishedContent = clone(publishedContent);
    deploymentInProgress = true;
    deploymentWatchSettled = false;
    deploymentReadyPromise = window.EMLLocalContent.waitForPublishedDeployment(pendingPublishedContent, paths, { signal })
      .catch((error) => {
        console.error(error);
        return { ready: false, paths };
      })
      .then((result) => {
        if (run !== deploymentPreviewRun || editorEpoch !== watchEpoch || activeUserId !== watchUserId || !editorReady) {
          return result;
        }
        deploymentWatchSettled = true;
        if (result.aborted) return result;
        if (result.ready) {
          result.paths.forEach((path) => pendingImagePreviews.delete(path));
          showPublishedImages(result.paths);
          deploymentInProgress = false;
          pendingPublishedContent = null;
          deploymentAbortController = null;
          if (!isDirty) {
            setStorageState('Git 저장 및 배포 완료');
            updateStorageNotice('저장한 콘텐츠가 홈페이지에 배포되었습니다. Preview Site에서 확인할 수 있습니다.');
          }
          toast('홈페이지 배포가 완료되었습니다.');
        } else if (!isDirty) {
          setStorageState('Git 저장 완료 · 배포 확인 필요', 'saving');
          updateStorageNotice('콘텐츠는 GitHub에 안전하게 저장되었습니다. Cloudflare 배포가 지연되고 있으니 잠시 후 Preview Site를 다시 눌러 확인하세요.');
        }
        return result;
      });
    return deploymentReadyPromise;
  }

  function getPath(path) {
    return String(path).split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), data);
  }

  function setPath(path, value) {
    const parts = String(path).split('.');
    let obj = data;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const key = parts[i];
      if (obj[key] == null) obj[key] = /^\d+$/.test(parts[i + 1]) ? [] : {};
      obj = obj[key];
    }
    obj[parts[parts.length - 1]] = value;
  }

  async function migrateEmbeddedImages(value, path = 'legacy') {
    if (typeof value === 'string' && /^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(value)) {
      setStorageState('기존 이미지 파일 처리 중', 'saving');
      if (!embeddedUploadCache.has(value)) {
        const upload = window.EMLLocalContent
          .uploadDataUrl(value, path.replace(/[^a-z0-9_-]+/gi, '-'))
          .catch((error) => {
            embeddedUploadCache.delete(value);
            throw error;
          });
        embeddedUploadCache.set(value, upload);
      }
      return embeddedUploadCache.get(value);
    }
    if (Array.isArray(value)) {
      const migrated = [];
      for (let index = 0; index < value.length; index += 1) {
        migrated.push(await migrateEmbeddedImages(value[index], `${path}-${index + 1}`));
      }
      return migrated;
    }
    if (value && typeof value === 'object') {
      const migrated = {};
      for (const [key, child] of Object.entries(value)) {
        migrated[key] = await migrateEmbeddedImages(child, `${path}-${key}`);
      }
      return migrated;
    }
    return value;
  }

  async function saveData(show = true) {
    if (!editorReady) return false;
    const invalidField = content.querySelector(':invalid');
    if (invalidField) {
      const collapsedCard = invalidField.closest('details:not([open])');
      if (collapsedCard) collapsedCard.open = true;
      invalidField.reportValidity();
      invalidField.focus({ preventScroll: true });
      invalidField.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast('필수 항목과 숫자 형식을 확인하세요.');
      return false;
    }
    if (!isDirty && hasPublishedContent) {
      if (show) toast('저장할 변경사항이 없습니다.');
      return true;
    }
    if (saveInFlight && saveInFlight.epoch === editorEpoch) return saveInFlight.promise;
    // keep gallery thumbnail synced with the first image
    (data.gallery || []).forEach((item) => {
      if (Array.isArray(item.images)) item.image = item.images[0] || '';
    });
    const snapshot = clone(data);
    const snapshotSequence = editSequence;
    const snapshotRevision = loadedRevision;
    const snapshotEpoch = editorEpoch;
    const snapshotUserId = activeUserId;
    const saveBusyOwner = beginBusy('Git 콘텐츠 저장 중');
    const operation = { epoch: snapshotEpoch, promise: null };
    saveInFlight = operation;
    operation.promise = (async () => {
      try {
        window.EMLDataSchema.assertValid(snapshot);
        const prepared = await migrateEmbeddedImages(snapshot);
        if (editorEpoch !== snapshotEpoch || activeUserId !== snapshotUserId || !editorReady) {
          return false;
        }
        const saved = await window.EMLLocalContent.saveContent(prepared, snapshotRevision);
        if (editorEpoch !== snapshotEpoch || activeUserId !== snapshotUserId || !editorReady) {
          return false;
        }
        loadedRevision = saved.revision;
        loadedUpdatedAt = saved.updatedAt;
        hasPublishedContent = true;
        if (editSequence === snapshotSequence) {
          const pendingImages = rememberPendingImagePreviews(snapshot, saved.content);
          data = clone(saved.content);
          isDirty = false;
          topSave.disabled = true;
          sessionDraft = null;
          sessionDraftExport.hidden = true;
          if (editorMode !== 'local' && pendingImages.length) {
            setStorageState(`Git 저장 완료 · 이미지 ${pendingImages.length}개 배포 중`, 'saving');
            updateStorageNotice('이미지는 GitHub에 저장되었습니다. Cloudflare 배포가 끝날 때까지 방금 선택한 미리보기를 유지합니다. 보통 1분 안에 완료됩니다.');
          } else if (editorMode !== 'local') {
            setStorageState('Git 저장 완료 · 홈페이지 배포 중', 'saving');
            updateStorageNotice('콘텐츠는 GitHub에 저장되었습니다. Cloudflare 배포가 끝나는 즉시 Preview Site에서 확인할 수 있습니다.');
          } else {
            setStorageState('로컬 저장 완료');
            updateStorageNotice();
          }
          render();
          if (editorMode !== 'local') startDeploymentWatch(saved.content);
          if (show) toast(editorMode === 'local'
            ? '저장소 파일에 저장했습니다. 커밋 후 배포할 수 있습니다.'
            : 'GitHub 저장 완료 · Cloudflare 배포를 확인하고 있습니다.');
          return true;
        }
        setStorageState('추가 변경 저장 필요', 'saving');
        updateStorageNotice('저장 중 생긴 추가 변경사항이 남아 있습니다. Save Changes를 다시 눌러주세요.');
        return false;
      } catch (error) {
        console.error(error);
        if (editorEpoch !== snapshotEpoch || activeUserId !== snapshotUserId || !editorReady) {
          return false;
        }
        if (error.code === 'EML_CONTENT_CONFLICT' || error.code === 'EML_AUTH_REQUIRED') {
          sessionDraft = { content: snapshot, baseRevision: snapshotRevision, userId: snapshotUserId };
          sessionDraftExport.hidden = false;
        }
        const message = error.code === 'EML_CONTENT_CONFLICT'
          ? `${error.message} 현재 초안은 유지되며 JSON으로 내려받을 수 있습니다.`
          : error.code === 'EML_AUTH_REQUIRED'
            ? 'GitHub 로그인이 만료되었습니다. 먼저 충돌 초안 JSON을 내려받고 페이지를 새로고침해 다시 로그인하세요.'
            : `저장 실패: ${error.message}`;
        setStorageState(
          error.code === 'EML_CONTENT_CONFLICT'
            ? '버전 충돌 · 확인 필요'
            : error.code === 'EML_AUTH_REQUIRED'
              ? 'GitHub 로그인 만료'
              : '저장 실패',
          'error',
        );
        updateStorageNotice(message);
        toast(message);
        return false;
      } finally {
        endBusy(saveBusyOwner);
        if (saveInFlight === operation) saveInFlight = null;
      }
    })();
    return operation.promise;
  }

  function header(title, description, actions = '') {
    return `<div class="section-heading"><div><h1>${escapeHTML(title)}</h1><p>${escapeHTML(description)}</p></div><div class="actions">${actions}</div></div>`;
  }

  function inputField(path, label, value = '', type = 'text', options = {}) {
    const numberAttributes = type === 'number' ? ' min="1" step="1" inputmode="numeric"' : '';
    const requiredAttributes = options.required ? ' required aria-required="true"' : '';
    const marker = options.required ? '<em class="required-mark">필수</em>' : '';
    return `<label class="field"><span>${escapeHTML(label)}${marker}</span><input type="${escapeAttr(type)}" value="${escapeAttr(value ?? '')}" data-path="${escapeAttr(path)}"${numberAttributes}${requiredAttributes} /></label>`;
  }

  function textareaField(path, label, value = '', options = {}) {
    const requiredAttributes = options.required ? ' required aria-required="true"' : '';
    const marker = options.required ? '<em class="required-mark">필수</em>' : '';
    return `<label class="field"><span>${escapeHTML(label)}${marker}</span><textarea data-path="${escapeAttr(path)}"${requiredAttributes}>${escapeHTML(value ?? '')}</textarea></label>`;
  }

  function arrayField(path, label, value = []) {
    return `<label class="field array-field"><span>${escapeHTML(label)}</span><textarea data-array-path="${escapeAttr(path)}">${escapeHTML((value || []).join('\n'))}</textarea><p class="help">한 줄에 하나씩 입력하세요.</p></label>`;
  }

  function uploadField(path, label, value = '', options = {}) {
    const storedPath = String(value || '');
    const publishedPath = String(options.publishedPreviewPath ?? storedPath);
    const preview = imagePreviewSource(publishedPath) || options.placeholder || 'assets/gallery-placeholder-1.svg';
    const deploying = imageIsDeploying(publishedPath);
    const wide = options.wide ? ' preview-wide' : '';
    const canReset = Object.prototype.hasOwnProperty.call(options, 'resetValue');
    const resetValue = String(options.resetValue ?? '');
    const resetLabel = options.resetLabel || '기본 이미지로 복구';
    const pathPlaceholder = options.pathPlaceholder || 'assets/example.png 형식의 저장소 경로';
    const uploadLabel = options.uploadLabel || 'Choose Image';
    const uploadAriaLabel = options.uploadAriaLabel || uploadLabel;
    const resetAriaLabel = options.resetAriaLabel || resetLabel;
    const resetDisabled = options.resetDisabled ? ' disabled' : '';
    const pathInput = `<input class="path-input" type="text" value="${escapeAttr(value ?? '')}" data-path="${escapeAttr(path)}" placeholder="${escapeAttr(pathPlaceholder)}" aria-label="${escapeAttr(label)} 저장소 경로" />`;
    const pathControl = options.advancedPath
      ? `<details class="advanced-path"><summary>고급: 저장소 경로 직접 입력</summary><label><span>저장소 이미지 경로</span>${pathInput}</label></details>`
      : pathInput;
    return `<div class="upload-field" data-upload-field data-upload-path="${escapeAttr(path)}">
      <span class="upload-label">${escapeHTML(label)}</span>
      <div class="dropzone${wide}${deploying ? ' is-deploying' : ''}" data-dropzone>
        <img src="${escapeAttr(preview)}" alt="${escapeAttr(label)} preview" data-upload-preview data-published-src="${escapeAttr(publishedPath)}" />
        ${deploying ? '<span class="deployment-badge" data-deployment-badge>배포 중</span>' : ''}
        <div class="dropzone-text">
          <strong>이미지를 드래그하거나 파일을 선택하세요.</strong>
          <p>JPG·PNG·WebP는 최대 2560px, 보통 약 700KB(최대 2MB)로 자동 최적화합니다. 움직이는 GIF는 2MB 이하만 원본 그대로 사용합니다.</p>
          ${deploying ? '<p class="deployment-note" data-deployment-note>GitHub 저장 완료 · Cloudflare 반영을 기다리는 중입니다.</p>' : ''}
          <div class="upload-actions">
            <button class="secondary" type="button" data-upload-button aria-label="${escapeAttr(uploadAriaLabel)}">${escapeHTML(uploadLabel)}</button>
            ${canReset ? `<button class="ghost-btn" type="button" data-upload-reset data-reset-value="${escapeAttr(resetValue)}" aria-label="${escapeAttr(resetAriaLabel)}"${resetDisabled}>${escapeHTML(resetLabel)}</button>` : ''}
          </div>
          <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" data-upload-input hidden />
          ${pathControl}
        </div>
      </div>
    </div>`;
  }

  function saveBar() {
    return `<div class="row-actions"><button class="primary" type="button" data-save>Save Changes</button><button class="secondary" type="button" data-preview>Save & Open Preview</button></div>`;
  }

  function render() {
    if (!editorReady) return;
    const renderMap = {
      dashboard: renderDashboard,
      brand: renderBrand,
      banners: renderBanners,
      site: renderSite,
      home: renderHome,
      research: renderResearch,
      professor: renderProfessor,
      members: renderMembers,
      alumni: renderAlumni,
      publications: renderPublications,
      gallery: renderGallery,
      raw: renderRaw,
    };
    content.innerHTML = renderMap[activeSection]();
    document.querySelector('[data-admin-logo]').src = (data.site && data.site.logoWhite) || 'assets/eml-logo-white.svg';
    bindCommon();
  }

  function renderPreservingPosition() {
    const openDetails = Array.from(content.querySelectorAll('details.item-card'), (details, index) => ({ index, open: details.open }));
    const scrollTop = window.scrollY;
    render();
    const nextDetails = content.querySelectorAll('details.item-card');
    openDetails.forEach(({ index, open }) => {
      if (nextDetails[index]) nextDetails[index].open = open;
    });
    window.requestAnimationFrame(() => window.scrollTo({ top: scrollTop, behavior: 'auto' }));
  }

  function renderDashboard() {
    return `<section class="dashboard-card">
      ${header('Dashboard', '홈페이지 주요 콘텐츠를 한 번에 확인합니다. 왼쪽 메뉴에서 각 섹션을 수정할 수 있습니다.')}
      <div class="stats-grid">
        <div class="stat"><span>Research Topics</span><strong>${(data.researchTopics || []).length}</strong></div>
        <div class="stat"><span>Members</span><strong>${(data.members || []).length}</strong></div>
        <div class="stat"><span>Publications</span><strong>${(data.publications || []).length}</strong></div>
        <div class="stat"><span>Gallery Posts</span><strong>${(data.gallery || []).length}</strong></div>
      </div>
    </section>
    <section class="editor-card">
      ${header('Quick Checklist', 'PPT 수정 요청이 반영된 주요 기능입니다.')}
      <div class="item-list">
        ${[
          '로고, 공주대학교 로고, 메인 및 서브페이지별 배너 이미지 교체 가능',
          'Research의 Facility & Equipment와 More View 버튼 제거',
          'Publications 전체 36편 표시 및 관리자 수정 지원',
          'Gallery 게시글별 다중 이미지, 미리보기, 순서 변경, 캐러셀 지원',
          'Contact 정보와 Google Maps 또는 지도 이미지 교체 지원',
          '메인 홈페이지와 동일한 버튼, 카드, 색상, 여백, 타이포그래피 시스템 적용'
        ].map((item) => `<div class="item-card"><summary>${escapeHTML(item)}</summary></div>`).join('')}
      </div>
      <div class="row-actions"><button class="primary" type="button" data-preview>Open Preview</button></div>
    </section>`;
  }

  function renderBrand() {
    const s = data.site || {};
    return `<section class="editor-card">
      ${header('Brand & Assets', '홈페이지 전반에서 사용하는 로고와 공통 기본 배너 이미지를 관리합니다.')}
      <div class="grid-2">
        ${uploadField('site.logoWhite', 'Header / Footer White Logo', s.logoWhite, { placeholder: 'assets/eml-logo-white.svg' })}
        ${uploadField('site.logoDark', 'Dark Logo', s.logoDark, { placeholder: 'assets/eml-logo-dark.svg' })}
        ${uploadField('site.knuLogo', 'Kongju National University Logo', s.knuLogo, { placeholder: 'assets/knu-logo.png' })}
        ${uploadField('site.heroImage', 'Main Home Hero / Default Subpage Banner', s.heroImage, { wide: true, placeholder: defaultSubHeroImage })}
      </div>
      <div class="hero-preview" data-published-background="${escapeAttr(s.heroImage || '')}" style="background-image: linear-gradient(90deg, rgba(5,16,28,.82), rgba(5,16,28,.26)), url('${escapeAttr(imagePreviewSource(s.heroImage) || 'assets/hero-concept-from-pdf.png')}')"><div><p class="help" style="color:rgba(255,255,255,.76);margin:0 0 6px">Preview</p><h3>Energy Materials Laboratory</h3></div></div>
      ${saveBar()}
    </section>`;
  }

  function renderBanners() {
    const s = data.site || {};
    const subHeroImages = s.subHeroImages || {};
    const defaultPreview = imagePreviewSource(s.heroImage) || defaultSubHeroImage;
    return `<section class="editor-card">
      ${header('Subpage Banners', 'Research, Members, Publications, Gallery, Contact의 상단 배너를 페이지별로 관리합니다.')}
      <div class="banner-guide" role="note">
        <strong>권장 이미지: 가로형 16:9 이상</strong>
        <p>중요한 피사체는 중앙에 배치하세요. 화면 크기에 따라 가장자리는 자연스럽게 잘리고 그라데이션으로 이어집니다. 개별 이미지가 없으면 Brand & Assets의 공통 기본 배너를 사용합니다.</p>
      </div>
      <div class="banner-sticky-save" role="group" aria-label="서브페이지 배너 저장">
        <span><strong>배너 변경사항 저장</strong><small>현재 초안의 모든 배너 변경을 함께 게시합니다.</small></span>
        <button class="primary" type="button" data-save>배너 변경 저장</button>
      </div>
      <div class="banner-manager-grid">
        ${subHeroPages.map((page) => {
          const value = typeof subHeroImages[page.key] === 'string' ? subHeroImages[page.key] : '';
          const custom = Boolean(value.trim());
          return `<article class="banner-manager-card">
            <div class="banner-card-heading">
              <div>
                <span>PAGE BANNER</span>
                <h2>${escapeHTML(page.title)}</h2>
                <p>${escapeHTML(page.description)}</p>
              </div>
              <a class="secondary" href="index.html#${escapeAttr(page.key)}" target="_blank" rel="noreferrer" aria-label="게시된 ${escapeAttr(page.title)} 페이지 보기">게시된 페이지 보기</a>
            </div>
            <p class="banner-source${custom ? ' is-custom' : ''}">${custom ? '페이지별 이미지 사용 중' : '공통 기본 이미지 사용 중'}</p>
            ${uploadField(`site.subHeroImages.${page.key}`, `${page.title} 현재 배너 이미지`, value, {
              wide: true,
              placeholder: defaultPreview,
              publishedPreviewPath: custom ? value : (s.heroImage || defaultSubHeroImage),
              resetValue: '',
              resetLabel: '공통 기본 배너로 복구',
              resetDisabled: !custom,
              resetAriaLabel: `${page.title} 배너를 공통 기본 이미지로 복구`,
              uploadLabel: '이미지 선택 / 교체',
              uploadAriaLabel: `${page.title} 배너 이미지 선택 또는 교체`,
              pathPlaceholder: '비워두면 공통 기본 배너를 사용합니다.',
              advancedPath: true,
            })}
          </article>`;
        }).join('')}
      </div>
      ${saveBar()}
    </section>`;
  }

  function renderSite() {
    const s = data.site || {};
    return `<section class="editor-card">
      ${header('Contact / Footer', '주소, 이메일, 지도, Footer 정보를 수정합니다.')}
      <div class="grid-2">
        ${inputField('site.labName', 'Lab Name', s.labName)}
        ${inputField('site.labNameKr', 'Korean Lab Name', s.labNameKr)}
        ${inputField('site.university', 'University', s.university)}
        ${inputField('site.universityKr', 'Department / Korean University', s.universityKr)}
        ${inputField('site.email', 'E-mail', s.email, 'email')}
        ${inputField('site.phone', 'Phone', s.phone || '')}
      </div>
      <div style="margin-top:16px">${textareaField('site.address', 'Address', s.address)}</div>
      <div class="grid-2" style="margin-top:16px">
        ${textareaField('site.joinMessage', 'Join Us Message', s.joinMessage || '')}
        ${textareaField('site.copyright', 'Copyright', s.copyright || '')}
      </div>
      <div class="grid-2" style="margin-top:16px">
        ${textareaField('site.mapEmbed', 'Google Maps Embed URL', s.mapEmbed || '')}
        ${uploadField('site.mapImage', 'Fallback Map Image', s.mapImage || '', { wide: true, placeholder: 'assets/gallery-placeholder-2.svg' })}
      </div>
      ${saveBar()}
    </section>`;
  }

  function renderHome() {
    const h = data.home || {};
    return `<section class="editor-card">
      ${header('Home', '메인 홈 배너의 문구와 버튼을 관리합니다.')}
      <div class="grid-2">
        ${inputField('home.eyebrow', 'Eyebrow', h.eyebrow)}
        ${inputField('home.subtitleKr', 'Korean Subtitle', h.subtitleKr)}
        ${inputField('home.ctaPrimary', 'Primary Button Text', h.ctaPrimary)}
        ${inputField('home.ctaSecondary', 'Secondary Button Text', h.ctaSecondary)}
        ${inputField('home.ctaSecondaryRoute', 'Secondary Button Route', h.ctaSecondaryRoute || 'contact')}
      </div>
      <div style="margin-top:16px">${arrayField('home.titleLines', 'Main Title Lines', h.titleLines || [])}</div>
      <div style="margin-top:16px">${textareaField('home.intro', 'Intro Text', h.intro || '')}</div>
      ${saveBar()}
    </section>`;
  }

  function renderResearch() {
    data.researchTopics = data.researchTopics || [];
    return `<section class="editor-card">
      ${header('Research', 'Research Statement와 Research Topic 카드를 관리합니다.', '<button class="primary" type="button" data-add="research">+ Add Topic</button>')}
      ${textareaField('researchStatement', 'Research Statement', data.researchStatement || '')}
      <div class="item-list" style="margin-top:18px">
        ${data.researchTopics.map((t, i) => `<details class="item-card" ${i < 2 ? 'open' : ''}>
          <summary>${escapeHTML(String(i + 1).padStart(2, '0'))} · ${escapeHTML(t.title || 'Research Topic')}</summary>
          <div class="item-fields">
            <div class="grid-2">
              ${inputField(`researchTopics.${i}.title`, 'Title', t.title)}
              ${inputField(`researchTopics.${i}.short`, 'Short Description', t.short)}
            </div>
            ${uploadField(`researchTopics.${i}.image`, 'Topic Image', t.image, { wide: true, placeholder: 'assets/research-electrode-interface.svg' })}
            ${textareaField(`researchTopics.${i}.description`, 'Detailed Description', t.description)}
            <div class="inline-actions">
              <button class="ghost-btn" type="button" data-move="research" data-index="${i}" data-dir="-1">↑ Move up</button>
              <button class="ghost-btn" type="button" data-move="research" data-index="${i}" data-dir="1">↓ Move down</button>
              <button class="danger" type="button" data-delete="research" data-index="${i}">Delete</button>
            </div>
          </div>
        </details>`).join('')}
      </div>
      ${saveBar()}
    </section>`;
  }

  function renderProfessor() {
    const p = data.professor || (data.professor = {});
    return `<section class="editor-card">
      ${header('Professor', '교수님 프로필, 학력, 경력을 관리합니다.')}
      <div class="grid-2">
        ${uploadField('professor.photo', 'Profile Photo', p.photo, { placeholder: 'assets/person-placeholder.svg' })}
        <div class="grid-2">
          ${inputField('professor.name', 'Name', p.name)}
          ${inputField('professor.role', 'Role', p.role)}
          ${inputField('professor.department', 'Department', p.department)}
          ${inputField('professor.email', 'E-mail', p.email, 'email')}
        </div>
      </div>
      <div class="grid-3" style="margin-top:16px">
        ${arrayField('professor.interest', 'Research Interest Tags', p.interest || [])}
        ${arrayField('professor.education', 'Education', p.education || [])}
        ${arrayField('professor.experience', 'Research Experience', p.experience || [])}
      </div>
      ${saveBar()}
    </section>`;
  }

  function renderMembers() {
    data.members = data.members || [];
    return `<section class="editor-card">
      ${header('Members', '현재 구성원 카드를 추가, 수정, 삭제합니다.', '<button class="primary" type="button" data-add="member">+ Add Member</button>')}
      <div class="item-list">
        ${data.members.map((m, i) => `<details class="item-card" ${i < 2 ? 'open' : ''}>
          <summary>${escapeHTML(m.name || `Member ${i + 1}`)}</summary>
          <div class="item-fields">
            <div class="grid-2">
              ${uploadField(`members.${i}.photo`, 'Photo', m.photo, { placeholder: 'assets/person-placeholder.svg' })}
              <div class="grid-2">
                ${inputField(`members.${i}.name`, 'Name', m.name)}
                ${inputField(`members.${i}.role`, 'Role', m.role)}
                ${inputField(`members.${i}.period`, 'Period', m.period)}
                ${inputField(`members.${i}.email`, 'E-mail', m.email)}
              </div>
            </div>
            ${textareaField(`members.${i}.research`, 'Research Interest', m.research)}
            <div class="inline-actions">
              <button class="ghost-btn" type="button" data-move="member" data-index="${i}" data-dir="-1">↑ Move up</button>
              <button class="ghost-btn" type="button" data-move="member" data-index="${i}" data-dir="1">↓ Move down</button>
              <button class="danger" type="button" data-delete="member" data-index="${i}">Delete member</button>
            </div>
          </div>
        </details>`).join('')}
      </div>
      ${saveBar()}
    </section>`;
  }

  function renderAlumni() {
    data.alumni = data.alumni || [];
    return `<section class="editor-card">
      ${header('Alumni', '졸업생 정보를 관리합니다.', '<button class="primary" type="button" data-add="alumni">+ Add Alumni</button>')}
      <div class="item-list">
        ${data.alumni.map((a, i) => `<div class="item-card"><div class="item-fields" style="padding-top:18px">
          <div class="grid-3">
            ${inputField(`alumni.${i}.date`, 'Graduation', a.date)}
            ${inputField(`alumni.${i}.name`, 'Name', a.name)}
            ${inputField(`alumni.${i}.next`, 'Current Position', a.next)}
          </div>
          <div class="inline-actions">
            <button class="ghost-btn" type="button" data-move="alumni" data-index="${i}" data-dir="-1">↑ Move up</button>
            <button class="ghost-btn" type="button" data-move="alumni" data-index="${i}" data-dir="1">↓ Move down</button>
            <button class="danger" type="button" data-delete="alumni" data-index="${i}">Delete alumni</button>
          </div>
        </div></div>`).join('')}
      </div>
      ${saveBar()}
    </section>`;
  }

  function renderPublications() {
    data.publications = data.publications || [];
    data.patents = data.patents || [];
    return `<section class="editor-card">
      ${header('Publications', '논문과 특허를 관리합니다. 모든 연도 논문이 누락 없이 표시되도록 구성되어 있습니다.', '<button class="primary" type="button" data-add="publication">+ Add Paper</button> <button class="secondary" type="button" data-add="patent">+ Add Patent</button>')}
      <h3>Papers (${data.publications.length})</h3>
      <div class="item-list" style="margin-top:14px">
        ${data.publications.map((p, i) => `<details class="item-card">
          <summary>#${escapeHTML(p.number ?? '')} · ${escapeHTML(p.year)} · ${escapeHTML(p.title)}</summary>
          <div class="item-fields">
            <div class="grid-3">
              ${inputField(`publications.${i}.number`, 'No.', p.number ?? '', 'number', { required: true })}
              ${inputField(`publications.${i}.year`, 'Year', p.year, 'text', { required: true })}
              ${inputField(`publications.${i}.journal`, 'Journal', p.journal, 'text', { required: true })}
            </div>
            ${textareaField(`publications.${i}.title`, 'Title', p.title, { required: true })}
            ${textareaField(`publications.${i}.authors`, 'Authors', p.authors, { required: true })}
            ${inputField(`publications.${i}.note`, 'Note', p.note || '')}
            <div class="inline-actions">
              <button class="ghost-btn" type="button" data-move="publication" data-index="${i}" data-dir="-1">↑ Move up</button>
              <button class="ghost-btn" type="button" data-move="publication" data-index="${i}" data-dir="1">↓ Move down</button>
              <button class="danger" type="button" data-delete="publication" data-index="${i}">Delete paper</button>
            </div>
          </div>
        </details>`).join('')}
      </div>
      <h3 style="margin-top:28px">Patents (${data.patents.length})</h3>
      <div class="item-list" style="margin-top:14px">
        ${data.patents.map((p, i) => `<details class="item-card">
          <summary>${escapeHTML(p.year || '')} · ${escapeHTML(p.title)}</summary>
          <div class="item-fields">
            <div class="grid-2">
              ${inputField(`patents.${i}.year`, 'Year', p.year || '')}
              ${inputField(`patents.${i}.number`, 'Patent Number', p.number)}
            </div>
            ${textareaField(`patents.${i}.title`, 'Title', p.title)}
            ${textareaField(`patents.${i}.inventors`, 'Inventors', p.inventors)}
            <div class="inline-actions">
              <button class="ghost-btn" type="button" data-move="patent" data-index="${i}" data-dir="-1">↑ Move up</button>
              <button class="ghost-btn" type="button" data-move="patent" data-index="${i}" data-dir="1">↓ Move down</button>
              <button class="danger" type="button" data-delete="patent" data-index="${i}">Delete patent</button>
            </div>
          </div>
        </details>`).join('')}
      </div>
      ${saveBar()}
    </section>`;
  }

  function imageList(path, images = []) {
    return `<div class="image-list" data-image-list="${escapeAttr(path)}">
      ${(images || []).map((src, index) => {
        const deploying = imageIsDeploying(src);
        return `<div class="image-tile${deploying ? ' is-deploying' : ''}" draggable="true" data-image-path="${escapeAttr(path)}" data-image-index="${index}">
        <img src="${escapeAttr(imagePreviewSource(src))}" alt="Gallery image ${index + 1}" data-published-src="${escapeAttr(src)}" />
        ${deploying ? '<span class="deployment-badge" data-deployment-badge>배포 중</span>' : ''}
        <div class="tile-actions">
          <button type="button" data-image-action="up" data-image-path="${escapeAttr(path)}" data-index="${index}">↑</button>
          <button type="button" data-image-action="down" data-image-path="${escapeAttr(path)}" data-index="${index}">↓</button>
          <button type="button" data-image-action="delete" data-image-path="${escapeAttr(path)}" data-index="${index}">Delete</button>
        </div>
      </div>`;
      }).join('')}
    </div>`;
  }

  function multiUploadField(path, label) {
    return `<div class="upload-field" data-multi-upload data-images-path="${escapeAttr(path)}">
      <span class="upload-label">${escapeHTML(label)}</span>
      <div class="dropzone preview-wide" data-dropzone>
        <img src="assets/gallery-placeholder-1.svg" alt="Upload preview" />
        <div class="dropzone-text">
          <strong>여러 장의 이미지를 드래그하거나 선택하세요.</strong>
          <p>첫 이미지가 대표 썸네일입니다. 한 번에 최대 10장(원본 합계 80MB), 게시할 새 이미지 합계는 최적화 후 8MB까지입니다.</p>
          <button class="secondary" type="button" data-multi-upload-button>Add Images</button>
          <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple data-multi-upload-input hidden />
        </div>
      </div>
    </div>`;
  }

  function renderGallery() {
    data.gallery = data.gallery || [];
    return `<section class="editor-card">
      ${header('Gallery', '게시글별 다중 이미지, 미리보기, 드래그 앤 드롭, 순서 변경을 지원합니다.', '<button class="primary" type="button" data-add="gallery">+ Add Gallery Post</button>')}
      <div class="item-list">
        ${data.gallery.map((g, i) => {
          const images = Array.isArray(g.images) ? g.images : (g.image ? [g.image] : []);
          return `<details class="item-card" ${i < 2 ? 'open' : ''}>
            <summary>${escapeHTML(g.date || '')} · ${escapeHTML(g.title || 'Gallery Post')} · ${images.length} photos</summary>
            <div class="item-fields">
              <div class="grid-3">
                ${inputField(`gallery.${i}.date`, 'Date', g.date, 'text', { required: true })}
                ${inputField(`gallery.${i}.title`, 'Title', g.title, 'text', { required: true })}
                ${inputField(`gallery.${i}.summary`, 'Summary', g.summary)}
              </div>
              ${textareaField(`gallery.${i}.body`, 'Detail Body', g.body)}
              ${multiUploadField(`gallery.${i}.images`, 'Gallery Images')}
              ${imageList(`gallery.${i}.images`, images)}
              <div class="inline-actions">
                <button class="ghost-btn" type="button" data-move="gallery" data-index="${i}" data-dir="-1">↑ Move post up</button>
                <button class="ghost-btn" type="button" data-move="gallery" data-index="${i}" data-dir="1">↓ Move post down</button>
                <button class="danger" type="button" data-delete="gallery" data-index="${i}">Delete post</button>
              </div>
            </div>
          </details>`;
        }).join('')}
      </div>
      ${saveBar()}
    </section>`;
  }

  function renderRaw() {
    return `<section class="editor-card">
      ${header('Raw JSON', '고급 수정용입니다. 데이터 전체를 직접 수정할 수 있습니다.')}
      <textarea class="raw-textarea" data-raw-json>${escapeHTML(JSON.stringify(data, null, 2))}</textarea>
      <div class="row-actions"><button class="primary" type="button" data-apply-raw>Apply Raw JSON</button><button class="secondary" type="button" data-export>Export JSON</button></div>
    </section>`;
  }

  function showPreviewWait(previewWindow, message = 'GitHub 저장과 Cloudflare 이미지 배포를 확인하고 있습니다.') {
    if (!previewWindow || previewWindow.closed) return;
    const previewDocument = previewWindow.document;
    previewDocument.title = 'EML 미리보기 준비 중';
    const shell = previewDocument.createElement('main');
    shell.style.cssText = 'box-sizing:border-box;display:grid;place-items:center;min-height:100vh;padding:24px;background:#071522;color:#fff;font:700 16px/1.6 system-ui,sans-serif;text-align:center';
    const text = previewDocument.createElement('p');
    text.style.cssText = 'max-width:520px;margin:0';
    text.textContent = message;
    shell.appendChild(text);
    previewDocument.body.replaceChildren(shell);
  }

  async function openPreviewAfterDeployment(previewWindow) {
    if (!previewWindow || previewWindow.closed) return false;
    if (deploymentInProgress) {
      showPreviewWait(previewWindow);
      if (deploymentWatchSettled && pendingPublishedContent) startDeploymentWatch(pendingPublishedContent);
      const result = await deploymentReadyPromise;
      if (!result.ready) {
        showPreviewWait(previewWindow, '콘텐츠는 GitHub에 안전하게 저장되었지만 Cloudflare 배포가 지연되고 있습니다. 이 창을 닫고 잠시 후 Preview Site를 다시 눌러주세요.');
        return false;
      }
    }
    if (!previewWindow.closed) {
      const previewUrl = new URL('index.html', window.location.href);
      previewUrl.searchParams.set('__eml_admin_preview', String(Date.now()));
      previewUrl.hash = 'home';
      previewWindow.location.replace(previewUrl.href);
    }
    return true;
  }

  function bindCommon() {
    content.querySelectorAll('[data-path]').forEach((field) => {
      field.addEventListener('input', () => {
        let value = field.value;
        if (field.type === 'number') {
          const normalized = field.value.trim();
          const numeric = Number(normalized);
          const valid = /^\d+$/.test(normalized) && Number.isSafeInteger(numeric) && numeric > 0;
          value = valid ? numeric : null;
          field.setCustomValidity(valid ? '' : '1 이상의 정수를 입력하세요.');
          field.setAttribute('aria-invalid', String(!valid));
        }
        setPath(field.dataset.path, value);
        syncBannerUploadState(field, value);
        markDirty();
      });
    });
    content.querySelectorAll('[data-array-path]').forEach((field) => {
      field.addEventListener('input', () => {
        setPath(field.dataset.arrayPath, field.value.split('\n').map((v) => v.trim()).filter(Boolean));
        markDirty();
      });
    });
    content.querySelectorAll('[data-save]').forEach((button) => button.addEventListener('click', async () => saveData(true)));
    content.querySelectorAll('[data-preview]').forEach((button) => button.addEventListener('click', async () => {
      const previewWindow = window.open('', '_blank');
      if (previewWindow) showPreviewWait(previewWindow, '콘텐츠를 저장하고 있습니다.');
      const saved = await saveData(false);
      if (saved && previewWindow) await openPreviewAfterDeployment(previewWindow);
      if (!saved && previewWindow) previewWindow.close();
      if (saved && !previewWindow) toast('저장되었지만 팝업이 차단되었습니다. 상단 Preview Site를 눌러주세요.');
    }));
    content.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', () => addItem(button.dataset.add)));
    content.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', () => deleteItem(button.dataset.delete, Number(button.dataset.index))));
    content.querySelectorAll('[data-move]').forEach((button) => button.addEventListener('click', () => moveItem(button.dataset.move, Number(button.dataset.index), Number(button.dataset.dir))));
    bindUploads();
    bindMultiUploads();
    bindImageActions();
    bindPublishedImageFallbacks();
    const rawApply = content.querySelector('[data-apply-raw]');
    if (rawApply) rawApply.addEventListener('click', applyRaw);
    content.querySelectorAll('[data-export]').forEach((button) => button.addEventListener('click', exportData));
  }

  function bindPublishedImageFallbacks() {
    content.querySelectorAll('img[data-published-src]').forEach((image) => {
      image.addEventListener('error', () => {
        const path = image.dataset.publishedSrc || '';
        if (!path.startsWith('assets/uploads/') || image.dataset.deploymentFallback === 'true') return;
        image.dataset.deploymentFallback = 'true';
        pendingImagePreviews.set(path, 'assets/gallery-placeholder-2.svg');
        image.src = 'assets/gallery-placeholder-2.svg';
        const container = image.closest('.image-tile, .dropzone');
        container?.classList.add('is-deploying');
        if (container && !container.querySelector('[data-deployment-badge]')) {
          const badge = document.createElement('span');
          badge.className = 'deployment-badge';
          badge.dataset.deploymentBadge = '';
          badge.textContent = '배포 확인 중';
          container.appendChild(badge);
        }
        if (!isDirty) {
          setStorageState('Git 저장 완료 · 이미지 배포 확인 중', 'saving');
          updateStorageNotice('이미지 파일은 GitHub에 저장되어 있습니다. Cloudflare에서 사용할 수 있게 되는 즉시 자동으로 표시합니다.');
        }
        startDeploymentWatch(data);
      }, { once: true });
    });
  }

  function bindUploads() {
    content.querySelectorAll('[data-upload-field]').forEach((field) => {
      const path = field.dataset.uploadPath;
      const input = field.querySelector('[data-upload-input]');
      const button = field.querySelector('[data-upload-button]');
      const resetButton = field.querySelector('[data-upload-reset]');
      const dropzone = field.querySelector('[data-dropzone]');
      const preview = field.querySelector('[data-upload-preview]');
      button.addEventListener('click', () => input.click());
      input.addEventListener('change', () => {
        const file = input.files[0];
        input.value = '';
        readSingleFile(file, path, preview);
      });
      dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('is-dragover'); });
      dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-dragover'));
      dropzone.addEventListener('drop', (event) => {
        event.preventDefault();
        dropzone.classList.remove('is-dragover');
        readSingleFile(event.dataTransfer.files[0], path, preview);
      });
      resetButton?.addEventListener('click', () => {
        const resetValue = resetButton.dataset.resetValue || '';
        if (String(getPath(path) || '') === resetValue) {
          toast('이미 공통 기본 배너를 사용하고 있습니다.');
          return;
        }
        setPath(path, resetValue);
        markDirty();
        renderPreservingPosition();
        toast('공통 기본 배너로 복구했습니다. Save Changes를 눌러 게시하세요.');
      });
    });
  }

  function syncBannerUploadState(field, value) {
    const card = field?.closest('.banner-manager-card');
    if (!card) return;
    const custom = Boolean(String(value || '').trim());
    const source = card.querySelector('.banner-source');
    const resetButton = card.querySelector('[data-upload-reset]');
    if (source) {
      source.classList.toggle('is-custom', custom);
      source.textContent = custom ? '페이지별 이미지 사용 중' : '공통 기본 이미지 사용 중';
    }
    if (resetButton) resetButton.disabled = !custom;
  }

  async function readSingleFile(file, path, preview) {
    if (!file) return;
    const uploadEpoch = editorEpoch;
    const uploadUserId = activeUserId;
    const uploadBusyOwner = beginBusy('이미지 최적화 중');
    try {
      const imageUrl = await window.EMLLocalContent.uploadImage(file);
      if (editorEpoch !== uploadEpoch || activeUserId !== uploadUserId || !editorReady) return;
      const previousValue = getPath(path);
      setPath(path, imageUrl);
      try {
        window.EMLLocalContent.validatePendingImages(data);
      } catch (error) {
        setPath(path, previousValue);
        throw error;
      }
      markDirty();
      if (preview) preview.src = imageUrl;
      const pathInput = Array.from(content.querySelectorAll('[data-path]')).find((el) => el.dataset.path === path);
      if (pathInput) {
        pathInput.value = imageUrl;
        syncBannerUploadState(pathInput, imageUrl);
      }
      toast('이미지가 초안에 추가되었습니다. Save Changes를 눌러 게시하세요.');
    } catch (error) {
      console.error(error);
      if (editorEpoch !== uploadEpoch || activeUserId !== uploadUserId || !editorReady) return;
      setStorageState('이미지 추가 실패', 'error');
      toast(`이미지 업로드 실패: ${error.message}`);
    } finally {
      endBusy(uploadBusyOwner);
    }
  }

  function bindMultiUploads() {
    content.querySelectorAll('[data-multi-upload]').forEach((field) => {
      const path = field.dataset.imagesPath;
      const input = field.querySelector('[data-multi-upload-input]');
      const button = field.querySelector('[data-multi-upload-button]');
      const dropzone = field.querySelector('[data-dropzone]');
      button.addEventListener('click', () => input.click());
      input.addEventListener('change', () => {
        const files = Array.from(input.files || []);
        input.value = '';
        addFilesToImages(path, files);
      });
      dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('is-dragover'); });
      dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-dragover'));
      dropzone.addEventListener('drop', (event) => {
        event.preventDefault();
        dropzone.classList.remove('is-dragover');
        addFilesToImages(path, Array.from(event.dataTransfer.files || []));
      });
    });
  }

  async function addFilesToImages(path, files) {
    const images = getPath(path) || [];
    const uploadEpoch = editorEpoch;
    const uploadUserId = activeUserId;
    let imageFiles;
    try {
      imageFiles = window.EMLLocalContent.validateImageSelection(files);
    } catch (error) {
      toast(error.message);
      return;
    }
    const uploadBusyOwner = beginBusy(`${imageFiles.length}개 이미지 최적화 중`);
    try {
      const imageUrls = await window.EMLLocalContent.uploadImages(imageFiles);
      if (editorEpoch !== uploadEpoch || activeUserId !== uploadUserId || !editorReady) return;
      const nextImages = [...images, ...imageUrls];
      setPath(path, nextImages);
      try {
        window.EMLLocalContent.validatePendingImages(data);
      } catch (error) {
        setPath(path, images);
        throw error;
      }
      markDirty();
      renderPreservingPosition();
      toast(`${imageFiles.length}개 이미지가 최적화되어 초안에 추가되었습니다. Save Changes를 눌러 게시하세요.`);
    } catch (error) {
      console.error(error);
      if (editorEpoch !== uploadEpoch || activeUserId !== uploadUserId || !editorReady) return;
      setStorageState('이미지 추가 실패', 'error');
      toast(`이미지 업로드 실패: ${error.message}`);
    } finally {
      endBusy(uploadBusyOwner);
    }
  }

  function bindImageActions() {
    content.querySelectorAll('[data-image-action]').forEach((button) => {
      button.addEventListener('click', () => {
        const path = button.dataset.imagePath;
        const index = Number(button.dataset.index);
        const images = getPath(path) || [];
        const deleted = button.dataset.imageAction === 'delete';
        if (deleted) images.splice(index, 1);
        if (button.dataset.imageAction === 'up' && index > 0) [images[index - 1], images[index]] = [images[index], images[index - 1]];
        if (button.dataset.imageAction === 'down' && index < images.length - 1) [images[index + 1], images[index]] = [images[index], images[index + 1]];
        setPath(path, images);
        markDirty();
        renderPreservingPosition();
        toast(deleted ? '이미지 삭제가 초안에 반영되었습니다.' : '이미지 순서 변경이 초안에 반영되었습니다.');
      });
    });
    content.querySelectorAll('.image-tile[draggable="true"]').forEach((tile) => {
      tile.addEventListener('dragstart', (event) => {
        dragImage = { path: tile.dataset.imagePath, index: Number(tile.dataset.imageIndex) };
        tile.classList.add('is-dragging');
        event.dataTransfer.effectAllowed = 'move';
      });
      tile.addEventListener('dragend', () => tile.classList.remove('is-dragging'));
      tile.addEventListener('dragover', (event) => event.preventDefault());
      tile.addEventListener('drop', (event) => {
        event.preventDefault();
        if (!dragImage || dragImage.path !== tile.dataset.imagePath) return;
        const targetIndex = Number(tile.dataset.imageIndex);
        const images = getPath(dragImage.path) || [];
        const [moved] = images.splice(dragImage.index, 1);
        images.splice(targetIndex, 0, moved);
        setPath(dragImage.path, images);
        dragImage = null;
        markDirty();
        renderPreservingPosition();
        toast('이미지 순서 변경이 초안에 반영되었습니다.');
      });
    });
  }

  function addItem(type) {
    const now = new Date().toISOString().slice(0, 10).replaceAll('-', '.');
    if (type === 'research') data.researchTopics.push({ id: `topic-${Date.now()}`, title: 'New Research Topic', short: 'Short description', image: 'assets/research-electrode-interface.svg', description: 'Detailed description.' });
    if (type === 'member') data.members.push({ name: 'New Member', role: 'Graduate Student', period: '2026.03. - present', email: '', research: 'Research interest', photo: 'assets/person-placeholder.svg' });
    if (type === 'alumni') data.alumni.push({ date: '2026.02', name: 'Name', next: '-' });
    if (type === 'publication') {
      const nextNumber = Math.max(0, ...data.publications.map((publication) => Number.isInteger(publication.number) ? publication.number : 0)) + 1;
      data.publications.unshift({ number: nextNumber, year: String(new Date().getFullYear()), title: '', authors: '', journal: '', note: '' });
    }
    if (type === 'patent') data.patents.unshift({ year: String(new Date().getFullYear()), title: 'New patent title', inventors: 'Inventors', number: 'Patent number' });
    if (type === 'gallery') data.gallery.unshift({ date: now, title: '', summary: '', image: '', images: [], body: '' });
    markDirty();
    render();
    toast('새 항목이 초안에 추가되었습니다. 내용을 작성한 뒤 Save Changes를 눌러 게시하세요.');
  }

  function deleteItem(type, index) {
    const map = { research: 'researchTopics', member: 'members', alumni: 'alumni', publication: 'publications', patent: 'patents', gallery: 'gallery' };
    const key = map[type];
    if (!key || !Array.isArray(data[key])) return;
    if (!confirm('삭제할까요?')) return;
    data[key].splice(index, 1);
    markDirty();
    render();
    toast('삭제가 초안에 반영되었습니다. Save Changes를 눌러 게시하세요.');
  }

  function moveItem(type, index, dir) {
    const map = { research: 'researchTopics', member: 'members', alumni: 'alumni', publication: 'publications', patent: 'patents', gallery: 'gallery' };
    const key = map[type];
    const arr = data[key];
    if (!Array.isArray(arr)) return;
    const next = index + dir;
    if (next < 0 || next >= arr.length) return;
    [arr[index], arr[next]] = [arr[next], arr[index]];
    markDirty();
    render();
    toast('순서 변경이 초안에 반영되었습니다.');
  }

  function applyRaw() {
    try {
      const parsed = JSON.parse(content.querySelector('[data-raw-json]').value);
      window.EMLDataSchema.assertValid(parsed);
      data = parsed;
      markDirty();
      render();
      toast('JSON 데이터가 초안에 적용되었습니다. Save Changes를 눌러 게시하세요.');
    } catch (error) {
      alert(`JSON 형식 오류입니다. ${error.message}`);
    }
  }

  function downloadJson(value, filename) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function exportData() {
    downloadJson(data, 'eml-site-data.json');
  }

  function exportSessionDraft() {
    if (!sessionDraft) return;
    downloadJson(
      sessionDraft.content,
      `eml-session-draft-revision-${revisionFileLabel(sessionDraft.baseRevision)}.json`,
    );
    toast('충돌 초안을 내려받았습니다. 최신 데이터와 비교한 뒤 필요한 내용만 다시 반영하세요.');
  }

  function importData(file) {
    if (!file) return;
    const importEpoch = editorEpoch;
    const importUserId = activeUserId;
    const importSequence = editSequence;
    const reader = new FileReader();
    reader.onload = () => {
      if (editorEpoch !== importEpoch || activeUserId !== importUserId || !editorReady) return;
      if (busyOwner || editSequence !== importSequence) {
        toast('파일을 읽는 동안 편집 내용이 바뀌어 가져오기를 취소했습니다. 다시 선택하세요.');
        return;
      }
      try {
        const parsed = JSON.parse(reader.result);
        window.EMLDataSchema.assertValid(parsed);
        data = parsed;
        markDirty();
        render();
        toast('JSON을 초안으로 불러왔습니다. Save Changes를 눌러 Git 콘텐츠에 저장하세요.');
      } catch (error) {
        alert(`JSON 파일을 읽을 수 없습니다. ${error.message}`);
      }
    };
    reader.readAsText(file);
  }

  function toast(message) {
    document.querySelectorAll('.toast').forEach((item) => item.remove());
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2400);
  }

  function showAuthPanel(panel) {
    cancelDeploymentPreview();
    editorEpoch += 1;
    busyOwner = null;
    setBusy(false);
    [authLoading, loginPanel, authError].forEach((element) => {
      element.hidden = element !== panel;
    });
    authShell.hidden = false;
    adminApp.hidden = true;
    adminActions.hidden = true;
    editorReady = false;
  }

  function showLogin(message = '') {
    showAuthPanel(loginPanel);
    const feedback = document.querySelector('[data-login-message]');
    feedback.textContent = message;
    feedback.hidden = !message;
  }

  function consumeAuthFeedback() {
    const url = new URL(window.location.href);
    const result = url.searchParams.get('auth');
    const reason = url.searchParams.get('reason') || '';
    if (!result) return '';
    url.searchParams.delete('auth');
    url.searchParams.delete('reason');
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    if (result !== 'error') return '';
    const messages = {
      oauth_denied: 'GitHub 로그인이 취소되었습니다. 다시 시도해 주세요.',
      invalid_oauth_state: '로그인 요청이 만료되었습니다. 다시 로그인해 주세요.',
      oauth_state_mismatch: '로그인 확인값이 일치하지 않습니다. 새로고침 후 다시 시도해 주세요.',
      github_permission_denied: '이 GitHub 계정에는 홈페이지 저장소 게시 권한이 없습니다.',
      push_permission_required: '이 GitHub 계정에는 EML-website 저장소의 push 권한이 없습니다.',
      wrong_repository: 'GitHub App이 EML-website 저장소에 설치되어 있지 않습니다.',
      wrong_repository_id: 'GitHub App 저장소와 배포 설정의 저장소 ID가 일치하지 않습니다.',
      github_resource_not_found: 'GitHub App의 저장소 설치 또는 Contents 권한을 확인해 주세요.',
      github_app_required: '저장소 전용 GitHub App 설정을 확인해 주세요.',
      server_not_configured: 'Cloudflare 관리자 인증 환경 변수가 아직 설정되지 않았습니다.',
    };
    return messages[reason] || `GitHub 관리자 로그인에 실패했습니다${reason ? ` (${reason})` : ''}. 다시 시도해 주세요.`;
  }

  function showAuthError(message) {
    showAuthPanel(authError);
    document.querySelector('[data-auth-error-message]').textContent = message;
  }

  function applyRemoteData(remote) {
    cancelDeploymentPreview();
    const nextData = remote.content || window.EML_DATA || {};
    window.EMLDataSchema.assertValid(nextData);
    hasPublishedContent = Boolean(remote.content);
    data = clone(nextData);
    loadedRevision = remote.revision;
    loadedUpdatedAt = remote.updatedAt;
    isDirty = false;
    topSave.disabled = true;
    editSequence += 1;
  }

  async function openEditor(session) {
    showAuthPanel(authLoading);
    const openEpoch = editorEpoch;
    editorMode = session.mode || 'remote';
    activeUserId = session.user?.login || (editorMode === 'local' ? 'Local Git Editor' : null);
    const remote = await window.EMLLocalContent.loadContent();
    if (editorEpoch !== openEpoch) return;
    applyRemoteData(remote);
    let restoredDraft = false;
    let conflictedDraft = false;
    if (sessionDraft && sessionDraft.userId === activeUserId) {
      if (sessionDraft.baseRevision === loadedRevision) {
        data = clone(sessionDraft.content);
        sessionDraft = null;
        markDirty();
        restoredDraft = true;
      } else {
        conflictedDraft = true;
      }
    } else if (sessionDraft) {
      sessionDraft = null;
    }
    editorReady = true;
    authShell.hidden = true;
    adminApp.hidden = false;
    adminActions.hidden = false;
    adminUser.textContent = activeUserId || 'GitHub Administrator';
    document.querySelector('[data-logout]').hidden = editorMode === 'local';
    sessionDraftExport.hidden = !conflictedDraft;
    setStorageState(editorMode === 'local' ? 'Local Git Editor' : 'GitHub 연결됨');
    updateStorageNotice();
    if (restoredDraft) {
      setStorageState('복구된 초안 · 저장 필요', 'saving');
      updateStorageNotice('이전 작업의 초안을 복구했습니다. 내용을 확인하고 Save Changes를 누르세요.');
    } else if (conflictedDraft) {
      setStorageState('초안 충돌 · 확인 필요', 'error');
      updateStorageNotice(`작업 중 Git 버전이 ${formatRevision(sessionDraft.baseRevision)}에서 ${formatRevision(loadedRevision)}(으)로 변경되었습니다. 예전 초안은 자동 복구하지 않았습니다. JSON을 내려받아 최신 내용과 비교하세요.`);
    }
    document.querySelector('[data-import-legacy]').hidden = !getLegacyDraft();
    render();
  }

  async function initializeAdmin() {
    showAuthPanel(authLoading);
    const authFeedback = consumeAuthFeedback();
    if (!window.EMLLocalContent) {
      showAuthError('관리자 콘텐츠 모듈을 불러오지 못했습니다. local-content-store.js 배포 여부를 확인하세요.');
      return;
    }
    const localHost = window.EMLLocalContent.isLocalhost();
    if (!localHost && window.location.protocol !== 'https:') {
      showAuthError('GitHub 관리자 로그인은 HTTPS 주소에서만 사용할 수 있습니다. 배포 주소를 확인하세요.');
      return;
    }
    try {
      const session = await window.EMLLocalContent.getSession();
      if (!session.authenticated) {
        showLogin(authFeedback || session.message);
        return;
      }
      await openEditor(session);
    } catch (error) {
      console.error(error);
      if (error.code === 'EML_AUTH_REQUIRED') {
        showLogin();
        return;
      }
      showAuthError(`${error.message} 로컬 관리 서버 또는 Cloudflare Worker API 설정을 확인하세요.`);
    }
  }

  async function reloadStoredData() {
    if (isDirty && !confirm('저장하지 않은 변경사항을 버리고 Git 저장소의 최신 내용을 다시 불러올까요?')) return;
    const reloadEpoch = editorEpoch;
    const reloadUserId = activeUserId;
    const reloadBusyOwner = beginBusy('최신 내용 불러오는 중');
    try {
      const remote = await window.EMLLocalContent.loadContent();
      if (editorEpoch !== reloadEpoch || activeUserId !== reloadUserId || !editorReady) return;
      applyRemoteData(remote);
      setStorageState(editorMode === 'local' ? 'Local Git Editor' : 'GitHub 연결됨');
      updateStorageNotice();
      render();
      toast('Git 저장소의 최신 내용을 불러왔습니다.');
    } catch (error) {
      console.error(error);
      if (editorEpoch !== reloadEpoch || activeUserId !== reloadUserId || !editorReady) return;
      setStorageState('불러오기 실패', 'error');
      updateStorageNotice(`불러오기 실패: ${error.message}`);
      toast(`불러오기 실패: ${error.message}`);
    } finally {
      endBusy(reloadBusyOwner);
    }
  }

  sidebar.addEventListener('click', (event) => {
    const button = event.target.closest('[data-section]');
    if (!button) return;
    activeSection = button.dataset.section;
    sidebar.querySelectorAll('[data-section]').forEach((el) => {
      const active = el === button;
      el.classList.toggle('is-active', active);
      if (active) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    });
    render();
    if (window.matchMedia('(max-width: 1180px)').matches) {
      window.requestAnimationFrame(() => {
        const heading = content.querySelector('h1');
        if (!heading) return;
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
        heading.scrollIntoView({
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
          block: 'start',
        });
      });
    }
  });
  document.querySelector('[data-export]').addEventListener('click', exportData);
  topSave.addEventListener('click', async () => saveData(true));
  document.querySelector('[data-preview-site]').addEventListener('click', async (event) => {
    if (!deploymentInProgress) return;
    event.preventDefault();
    const previewWindow = window.open('', '_blank');
    if (!previewWindow) {
      toast('팝업이 차단되었습니다. 브라우저에서 이 사이트의 팝업을 허용해 주세요.');
      return;
    }
    await openPreviewAfterDeployment(previewWindow);
  });
  document.querySelector('[data-import-trigger]').addEventListener('click', () => {
    document.querySelector('[data-import]').click();
  });
  document.querySelector('[data-import]').addEventListener('change', (event) => {
    importData(event.target.files[0]);
    event.target.value = '';
  });
  document.querySelector('[data-reset]').addEventListener('click', () => {
    if (!confirm('현재 편집 내용을 기본 데이터로 바꿀까요? Save Changes를 누르기 전에는 Git 저장소에 반영되지 않습니다.')) return;
    data = clone(window.EML_DATA || {});
    markDirty();
    render();
    toast('기본 데이터를 초안으로 불러왔습니다.');
  });
  document.querySelector('[data-reload-content]').addEventListener('click', reloadStoredData);
  sessionDraftExport.addEventListener('click', exportSessionDraft);
  document.querySelector('[data-import-legacy]').addEventListener('click', () => {
    const legacy = getLegacyDraft();
    if (!legacy) {
      toast('가져올 기존 브라우저 초안이 없습니다.');
      return;
    }
    if (!confirm('현재 편집 내용을 이 브라우저에 남아 있는 기존 초안으로 바꿀까요?')) return;
    data = clone(legacy);
    markDirty();
    render();
    toast('기존 초안을 불러왔습니다. Save Changes를 눌러 Git 콘텐츠에 저장하세요.');
  });
  document.querySelector('[data-logout]').addEventListener('click', async () => {
    if (isDirty && !confirm('저장하지 않은 변경사항이 있습니다. 로그아웃할까요?')) return;
    const logoutBusyOwner = beginBusy('GitHub 로그아웃 중');
    try {
      await window.EMLLocalContent.signOut();
      isDirty = false;
      sessionDraft = null;
      sessionDraftExport.hidden = true;
      activeUserId = null;
      window.location.reload();
    } catch (error) {
      toast(`로그아웃 실패: ${error.message}`);
    } finally {
      endBusy(logoutBusyOwner);
    }
  });
  document.querySelector('[data-auth-retry]').addEventListener('click', initializeAdmin);
  window.addEventListener('beforeunload', (event) => {
    if (!isDirty) return;
    event.preventDefault();
    event.returnValue = '';
  });

  initializeAdmin();
})();
