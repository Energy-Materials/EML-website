(function () {
  const storageKey = 'emlDataV2';
  const sidebar = document.querySelector('[data-sidebar]');
  const content = document.querySelector('[data-admin-content]');
  const authShell = document.querySelector('[data-auth-shell]');
  const authLoading = document.querySelector('[data-auth-loading]');
  const setupPanel = document.querySelector('[data-setup-panel]');
  const loginForm = document.querySelector('[data-login-form]');
  const authError = document.querySelector('[data-auth-error]');
  const adminApp = document.querySelector('[data-admin-app]');
  const adminActions = document.querySelector('[data-admin-actions]');
  const cloudState = document.querySelector('[data-cloud-state]');
  const adminUser = document.querySelector('[data-admin-user]');
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
  let editorEpoch = 0;
  let authWatcherStarted = false;
  let busyOwner = null;
  const embeddedUploadCache = new Map();

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

  function setCloudState(message, type = '') {
    cloudState.textContent = message;
    cloudState.classList.toggle('is-saving', type === 'saving');
    cloudState.classList.toggle('is-error', type === 'error');
  }

  function setBusy(busy, message = 'Cloud 연결됨') {
    document.body.classList.toggle('is-busy', busy);
    adminApp.inert = busy;
    adminActions.inert = busy;
    adminApp.setAttribute('aria-busy', String(busy));
    if (busy) setCloudState(message, 'saving');
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
    editSequence += 1;
    setCloudState('저장되지 않은 변경', 'saving');
  }

  function formatUpdatedAt(value) {
    if (!value) return '';
    try {
      return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
    } catch (error) {
      return String(value);
    }
  }

  function updateCloudNotice(message = '') {
    const heading = document.querySelector('[data-cloud-heading]');
    const detail = document.querySelector('[data-cloud-detail]');
    if (heading) heading.textContent = hasPublishedContent ? '클라우드 홈페이지 관리' : '첫 게시 준비 완료';
    if (detail) {
      detail.textContent = message || (hasPublishedContent
        ? `현재 클라우드 버전 ${loadedRevision} · 마지막 저장 ${formatUpdatedAt(loadedUpdatedAt)}`
        : '아직 게시된 클라우드 데이터가 없습니다. 기본 데이터를 확인한 뒤 Save Changes를 눌러 처음 게시하세요.');
    }
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
    if (typeof value === 'string' && /^data:image\/(jpeg|png|webp|gif);base64,/i.test(value)) {
      setCloudState('기존 이미지 업로드 중', 'saving');
      if (!embeddedUploadCache.has(value)) {
        const upload = window.EMLCloud
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
    const saveBusyOwner = beginBusy('Cloud 저장 중');
    const operation = { epoch: snapshotEpoch, promise: null };
    saveInFlight = operation;
    operation.promise = (async () => {
      try {
        window.EMLDataSchema.assertValid(snapshot);
        const prepared = await migrateEmbeddedImages(snapshot);
        if (editorEpoch !== snapshotEpoch || activeUserId !== snapshotUserId || !editorReady) {
          return false;
        }
        const saved = await window.EMLCloud.saveContent(prepared, snapshotRevision);
        if (editorEpoch !== snapshotEpoch || activeUserId !== snapshotUserId || !editorReady) {
          return false;
        }
        loadedRevision = saved.revision;
        loadedUpdatedAt = saved.updatedAt;
        hasPublishedContent = true;
        if (editSequence === snapshotSequence) {
          data = clone(saved.content);
          isDirty = false;
          setCloudState('Cloud 저장 완료');
          updateCloudNotice();
          render();
          if (show) toast('저장되었습니다. 모든 방문자에게 반영됩니다.');
          return true;
        }
        setCloudState('추가 변경 저장 필요', 'saving');
        updateCloudNotice('저장 중 생긴 추가 변경사항이 남아 있습니다. Save Changes를 다시 눌러주세요.');
        return false;
      } catch (error) {
        console.error(error);
        if (editorEpoch !== snapshotEpoch || activeUserId !== snapshotUserId || !editorReady) {
          return false;
        }
        const message = error.code === 'EML_CONTENT_CONFLICT'
          ? error.message
          : `저장 실패: ${error.message}`;
        setCloudState('저장 실패', 'error');
        updateCloudNotice(message);
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

  function inputField(path, label, value = '', type = 'text') {
    return `<label class="field"><span>${escapeHTML(label)}</span><input type="${escapeAttr(type)}" value="${escapeAttr(value ?? '')}" data-path="${escapeAttr(path)}" /></label>`;
  }

  function textareaField(path, label, value = '') {
    return `<label class="field"><span>${escapeHTML(label)}</span><textarea data-path="${escapeAttr(path)}">${escapeHTML(value ?? '')}</textarea></label>`;
  }

  function arrayField(path, label, value = []) {
    return `<label class="field array-field"><span>${escapeHTML(label)}</span><textarea data-array-path="${escapeAttr(path)}">${escapeHTML((value || []).join('\n'))}</textarea><p class="help">한 줄에 하나씩 입력하세요.</p></label>`;
  }

  function uploadField(path, label, value = '', options = {}) {
    const preview = value || options.placeholder || 'assets/gallery-placeholder-1.svg';
    const wide = options.wide ? ' preview-wide' : '';
    return `<div class="upload-field" data-upload-field data-upload-path="${escapeAttr(path)}">
      <span class="upload-label">${escapeHTML(label)}</span>
      <div class="dropzone${wide}" data-dropzone>
        <img src="${escapeAttr(preview)}" alt="${escapeAttr(label)} preview" data-upload-preview />
        <div class="dropzone-text">
          <strong>이미지를 드래그하거나 파일을 선택하세요.</strong>
          <p>JPG, PNG, WebP, GIF 파일을 선택하면 클라우드 저장소에 업로드됩니다.</p>
          <button class="secondary" type="button" data-upload-button>Choose Image</button>
          <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" data-upload-input hidden />
          <input class="path-input" type="text" value="${escapeAttr(value ?? '')}" data-path="${escapeAttr(path)}" placeholder="assets/example.png 또는 이미지 URL" />
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
          '로고, 공주대학교 로고, 메인 배경 이미지 교체 가능',
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
      ${header('Brand & Assets', '홈페이지 전반에서 사용하는 로고, 배너, 지도 이미지를 관리합니다.')}
      <div class="grid-2">
        ${uploadField('site.logoWhite', 'Header / Footer White Logo', s.logoWhite, { placeholder: 'assets/eml-logo-white.svg' })}
        ${uploadField('site.logoDark', 'Dark Logo', s.logoDark, { placeholder: 'assets/eml-logo-dark.svg' })}
        ${uploadField('site.knuLogo', 'Kongju National University Logo', s.knuLogo, { placeholder: 'assets/knu-logo.png' })}
        ${uploadField('site.heroImage', 'Main Hero / Sub Banner Image', s.heroImage, { wide: true, placeholder: 'assets/hero-concept-from-pdf.png' })}
      </div>
      <div class="hero-preview" style="background-image: linear-gradient(90deg, rgba(5,16,28,.82), rgba(5,16,28,.26)), url('${escapeAttr(s.heroImage || 'assets/hero-concept-from-pdf.png')}')"><div><p class="help" style="color:rgba(255,255,255,.76);margin:0 0 6px">Preview</p><h3>Energy Materials Laboratory</h3></div></div>
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
          <summary>#${escapeHTML(p.number || '')} · ${escapeHTML(p.year)} · ${escapeHTML(p.title)}</summary>
          <div class="item-fields">
            <div class="grid-3">
              ${inputField(`publications.${i}.number`, 'No.', p.number || '')}
              ${inputField(`publications.${i}.year`, 'Year', p.year)}
              ${inputField(`publications.${i}.journal`, 'Journal', p.journal)}
            </div>
            ${textareaField(`publications.${i}.title`, 'Title', p.title)}
            ${textareaField(`publications.${i}.authors`, 'Authors', p.authors)}
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
      ${(images || []).map((src, index) => `<div class="image-tile" draggable="true" data-image-path="${escapeAttr(path)}" data-image-index="${index}">
        <img src="${escapeAttr(src)}" alt="Gallery image ${index + 1}" />
        <div class="tile-actions">
          <button type="button" data-image-action="up" data-image-path="${escapeAttr(path)}" data-index="${index}">↑</button>
          <button type="button" data-image-action="down" data-image-path="${escapeAttr(path)}" data-index="${index}">↓</button>
          <button type="button" data-image-action="delete" data-image-path="${escapeAttr(path)}" data-index="${index}">Delete</button>
        </div>
      </div>`).join('')}
    </div>`;
  }

  function multiUploadField(path, label) {
    return `<div class="upload-field" data-multi-upload data-images-path="${escapeAttr(path)}">
      <span class="upload-label">${escapeHTML(label)}</span>
      <div class="dropzone preview-wide" data-dropzone>
        <img src="assets/gallery-placeholder-1.svg" alt="Upload preview" />
        <div class="dropzone-text">
          <strong>여러 장의 이미지를 드래그하거나 선택하세요.</strong>
          <p>첫 번째 이미지가 대표 썸네일로 사용됩니다. 아래 이미지 타일을 드래그하거나 버튼으로 순서를 변경할 수 있습니다.</p>
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
                ${inputField(`gallery.${i}.date`, 'Date', g.date)}
                ${inputField(`gallery.${i}.title`, 'Title', g.title)}
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

  function bindCommon() {
    content.querySelectorAll('[data-path]').forEach((field) => {
      field.addEventListener('input', () => {
        setPath(field.dataset.path, field.value);
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
      const saved = await saveData(false);
      if (saved && previewWindow) previewWindow.location.href = new URL('index.html#home', window.location.href).href;
      if (!saved && previewWindow) previewWindow.close();
      if (saved && !previewWindow) toast('저장되었지만 팝업이 차단되었습니다. 상단 Preview Site를 눌러주세요.');
    }));
    content.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', async () => addItem(button.dataset.add)));
    content.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', async () => deleteItem(button.dataset.delete, Number(button.dataset.index))));
    content.querySelectorAll('[data-move]').forEach((button) => button.addEventListener('click', async () => moveItem(button.dataset.move, Number(button.dataset.index), Number(button.dataset.dir))));
    bindUploads();
    bindMultiUploads();
    bindImageActions();
    const rawApply = content.querySelector('[data-apply-raw]');
    if (rawApply) rawApply.addEventListener('click', applyRaw);
    content.querySelectorAll('[data-export]').forEach((button) => button.addEventListener('click', exportData));
  }

  function bindUploads() {
    content.querySelectorAll('[data-upload-field]').forEach((field) => {
      const path = field.dataset.uploadPath;
      const input = field.querySelector('[data-upload-input]');
      const button = field.querySelector('[data-upload-button]');
      const dropzone = field.querySelector('[data-dropzone]');
      const preview = field.querySelector('[data-upload-preview]');
      button.addEventListener('click', () => input.click());
      input.addEventListener('change', () => readSingleFile(input.files[0], path, preview));
      dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('is-dragover'); });
      dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-dragover'));
      dropzone.addEventListener('drop', (event) => {
        event.preventDefault();
        dropzone.classList.remove('is-dragover');
        readSingleFile(event.dataTransfer.files[0], path, preview);
      });
    });
  }

  async function readSingleFile(file, path, preview) {
    if (!file) return;
    const uploadEpoch = editorEpoch;
    const uploadUserId = activeUserId;
    const uploadBusyOwner = beginBusy('이미지 업로드 중');
    try {
      const imageUrl = await window.EMLCloud.uploadImage(file);
      if (editorEpoch !== uploadEpoch || activeUserId !== uploadUserId || !editorReady) return;
      setPath(path, imageUrl);
      markDirty();
      if (preview) preview.src = imageUrl;
      const pathInput = Array.from(content.querySelectorAll('[data-path]')).find((el) => el.dataset.path === path);
      if (pathInput) pathInput.value = imageUrl;
      endBusy(uploadBusyOwner);
      const saved = await saveData(false);
      if (saved) toast('이미지가 업로드되고 저장되었습니다.');
    } catch (error) {
      console.error(error);
      if (editorEpoch !== uploadEpoch || activeUserId !== uploadUserId || !editorReady) return;
      setCloudState('이미지 업로드 실패', 'error');
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
      input.addEventListener('change', () => addFilesToImages(path, Array.from(input.files || [])));
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
    const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    const imageFiles = files.filter((file) => allowedTypes.has(file.type));
    if (!imageFiles.length) {
      toast('JPG, PNG, WebP 또는 GIF 이미지를 선택하세요.');
      return;
    }
    try {
      imageFiles.forEach((file) => window.EMLCloud.validateImage(file));
    } catch (error) {
      toast(error.message);
      return;
    }
    const uploadBusyOwner = beginBusy(`${imageFiles.length}개 이미지 업로드 중`);
    try {
      const results = await Promise.allSettled(imageFiles.map((file) => window.EMLCloud.uploadImage(file)));
      const imageUrls = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
      const failures = results.filter((result) => result.status === 'rejected');
      if (!imageUrls.length) throw failures[0].reason;
      if (editorEpoch !== uploadEpoch || activeUserId !== uploadUserId || !editorReady) return;
      setPath(path, [...images, ...imageUrls]);
      markDirty();
      render();
      endBusy(uploadBusyOwner);
      const saved = await saveData(false);
      if (saved && !failures.length) toast(`${imageFiles.length}개 이미지가 업로드되고 저장되었습니다.`);
      if (saved && failures.length) toast(`${imageUrls.length}개는 저장했고 ${failures.length}개는 업로드하지 못했습니다.`);
    } catch (error) {
      console.error(error);
      if (editorEpoch !== uploadEpoch || activeUserId !== uploadUserId || !editorReady) return;
      setCloudState('이미지 업로드 실패', 'error');
      toast(`이미지 업로드 실패: ${error.message}`);
    } finally {
      endBusy(uploadBusyOwner);
    }
  }

  function bindImageActions() {
    content.querySelectorAll('[data-image-action]').forEach((button) => {
      button.addEventListener('click', async () => {
        const path = button.dataset.imagePath;
        const index = Number(button.dataset.index);
        const images = getPath(path) || [];
        if (button.dataset.imageAction === 'delete') images.splice(index, 1);
        if (button.dataset.imageAction === 'up' && index > 0) [images[index - 1], images[index]] = [images[index], images[index - 1]];
        if (button.dataset.imageAction === 'down' && index < images.length - 1) [images[index + 1], images[index]] = [images[index], images[index + 1]];
        setPath(path, images);
        markDirty();
        render();
        await saveData(false);
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
      tile.addEventListener('drop', async (event) => {
        event.preventDefault();
        if (!dragImage || dragImage.path !== tile.dataset.imagePath) return;
        const targetIndex = Number(tile.dataset.imageIndex);
        const images = getPath(dragImage.path) || [];
        const [moved] = images.splice(dragImage.index, 1);
        images.splice(targetIndex, 0, moved);
        setPath(dragImage.path, images);
        dragImage = null;
        markDirty();
        render();
        await saveData(false);
      });
    });
  }

  async function addItem(type) {
    const now = new Date().toISOString().slice(0, 10).replaceAll('-', '.');
    if (type === 'research') data.researchTopics.push({ id: `topic-${Date.now()}`, title: 'New Research Topic', short: 'Short description', image: 'assets/research-electrode-interface.svg', description: 'Detailed description.' });
    if (type === 'member') data.members.push({ name: 'New Member', role: 'Graduate Student', period: '2026.03. - present', email: '', research: 'Research interest', photo: 'assets/person-placeholder.svg' });
    if (type === 'alumni') data.alumni.push({ date: '2026.02', name: 'Name', next: '-' });
    if (type === 'publication') data.publications.unshift({ number: (data.publications[0]?.number || data.publications.length) + 1, year: String(new Date().getFullYear()), title: 'New paper title', authors: 'Authors', journal: 'Journal information', note: '' });
    if (type === 'patent') data.patents.unshift({ year: String(new Date().getFullYear()), title: 'New patent title', inventors: 'Inventors', number: 'Patent number' });
    if (type === 'gallery') data.gallery.unshift({ date: now, title: 'New gallery post', summary: 'Short summary', image: 'assets/gallery-placeholder-1.svg', images: ['assets/gallery-placeholder-1.svg'], body: 'Detailed content.' });
    markDirty();
    render();
    const saved = await saveData(false);
    if (saved) toast('새 항목이 추가되고 저장되었습니다.');
  }

  async function deleteItem(type, index) {
    const map = { research: 'researchTopics', member: 'members', alumni: 'alumni', publication: 'publications', patent: 'patents', gallery: 'gallery' };
    const key = map[type];
    if (!key || !Array.isArray(data[key])) return;
    if (!confirm('삭제할까요?')) return;
    data[key].splice(index, 1);
    markDirty();
    render();
    const saved = await saveData(false);
    if (saved) toast('삭제되었습니다.');
  }

  async function moveItem(type, index, dir) {
    const map = { research: 'researchTopics', member: 'members', alumni: 'alumni', publication: 'publications', patent: 'patents', gallery: 'gallery' };
    const key = map[type];
    const arr = data[key];
    if (!Array.isArray(arr)) return;
    const next = index + dir;
    if (next < 0 || next >= arr.length) return;
    [arr[index], arr[next]] = [arr[next], arr[index]];
    markDirty();
    render();
    await saveData(false);
  }

  async function applyRaw() {
    try {
      const parsed = JSON.parse(content.querySelector('[data-raw-json]').value);
      window.EMLDataSchema.assertValid(parsed);
      data = parsed;
      markDirty();
      render();
      const saved = await saveData(false);
      if (saved) toast('JSON 데이터가 적용되고 저장되었습니다.');
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
      `eml-session-draft-revision-${sessionDraft.baseRevision}.json`,
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
        toast('JSON을 초안으로 불러왔습니다. Save Changes를 눌러 게시하세요.');
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
    editorEpoch += 1;
    busyOwner = null;
    setBusy(false);
    [authLoading, setupPanel, loginForm, authError].forEach((element) => {
      element.hidden = element !== panel;
    });
    authShell.hidden = false;
    adminApp.hidden = true;
    adminActions.hidden = true;
    editorReady = false;
  }

  function showLogin(message = '') {
    showAuthPanel(loginForm);
    document.querySelector('[data-auth-message]').textContent = message;
    const loginId = String(window.EMLCloud?.config?.adminLoginId || '').trim();
    if (loginId) document.querySelector('[data-login-id]').value = loginId;
    document.querySelector('[data-login-password]').value = '';
  }

  function showAuthError(message) {
    showAuthPanel(authError);
    document.querySelector('[data-auth-error-message]').textContent = message;
  }

  function applyRemoteData(remote) {
    const nextData = remote.content || window.EML_DATA || {};
    window.EMLDataSchema.assertValid(nextData);
    hasPublishedContent = Boolean(remote.content);
    data = clone(nextData);
    loadedRevision = remote.revision;
    loadedUpdatedAt = remote.updatedAt;
    isDirty = false;
    editSequence += 1;
  }

  async function openEditor(session) {
    showAuthPanel(authLoading);
    const openEpoch = editorEpoch;
    activeUserId = session.user.id || null;
    const allowed = await window.EMLCloud.isAdmin();
    if (editorEpoch !== openEpoch) return;
    if (!allowed) {
      await window.EMLCloud.signOut();
      showLogin('이 계정에는 홈페이지 관리자 권한이 없습니다.');
      return;
    }
    const remote = await window.EMLCloud.loadContent();
    if (editorEpoch !== openEpoch) return;
    applyRemoteData(remote);
    let restoredDraft = false;
    let conflictedDraft = false;
    if (sessionDraft && sessionDraft.userId === activeUserId) {
      if (Number(sessionDraft.baseRevision) === loadedRevision) {
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
    adminUser.textContent = window.EMLCloud.config.adminLoginId || session.user.email || 'Administrator';
    sessionDraftExport.hidden = !conflictedDraft;
    setCloudState('Cloud 연결됨');
    updateCloudNotice();
    if (restoredDraft) {
      setCloudState('복구된 초안 · 저장 필요', 'saving');
      updateCloudNotice('로그인 세션이 끝나기 전의 초안을 복구했습니다. 내용을 확인하고 Save Changes를 누르세요.');
    } else if (conflictedDraft) {
      setCloudState('초안 충돌 · 확인 필요', 'error');
      updateCloudNotice(`세션이 종료된 사이 클라우드 버전이 ${sessionDraft.baseRevision}에서 ${loadedRevision}(으)로 변경되었습니다. 예전 초안은 자동 복구하지 않았습니다. JSON을 내려받아 최신 내용과 비교하세요.`);
    }
    document.querySelector('[data-import-legacy]').hidden = !getLegacyDraft();
    render();
  }

  async function initializeAdmin() {
    showAuthPanel(authLoading);
    if (!window.EMLCloud || !window.EMLCloud.isConfigured()) {
      showAuthPanel(setupPanel);
      return;
    }
    const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
    if (window.location.protocol !== 'https:' && !localHost) {
      showAuthError('관리자 로그인은 HTTPS 주소에서만 사용할 수 있습니다. 운영 서버에 HTTPS를 적용하세요.');
      return;
    }
    try {
      if (!authWatcherStarted) {
        window.EMLCloud.onAuthStateChange((event) => {
          if (event !== 'SIGNED_OUT') return;
          if (editorReady && isDirty) {
            sessionDraft = {
              content: clone(data),
              baseRevision: loadedRevision,
              userId: activeUserId,
            };
          }
          activeUserId = null;
          showLogin(sessionDraft
            ? '로그인 세션이 종료되었습니다. 다시 로그인하면 저장하지 않은 초안을 복구합니다.'
            : '로그인 세션이 종료되었습니다. 다시 로그인하세요.');
        });
        authWatcherStarted = true;
      }
      const session = await window.EMLCloud.getSession();
      if (!session) {
        showLogin();
        return;
      }
      await openEditor(session);
    } catch (error) {
      console.error(error);
      showAuthError(`${error.message} 설정 파일과 setup.sql 실행 여부를 확인하세요.`);
    }
  }

  async function reloadCloudData() {
    if (isDirty && !confirm('저장하지 않은 변경사항을 버리고 클라우드의 최신 내용을 다시 불러올까요?')) return;
    const reloadEpoch = editorEpoch;
    const reloadUserId = activeUserId;
    const reloadBusyOwner = beginBusy('최신 내용 불러오는 중');
    try {
      const remote = await window.EMLCloud.loadContent();
      if (editorEpoch !== reloadEpoch || activeUserId !== reloadUserId || !editorReady) return;
      applyRemoteData(remote);
      setCloudState('Cloud 연결됨');
      updateCloudNotice();
      render();
      toast('클라우드의 최신 내용을 불러왔습니다.');
    } catch (error) {
      console.error(error);
      if (editorEpoch !== reloadEpoch || activeUserId !== reloadUserId || !editorReady) return;
      setCloudState('불러오기 실패', 'error');
      updateCloudNotice(`불러오기 실패: ${error.message}`);
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
  });
  document.querySelector('[data-export]').addEventListener('click', exportData);
  document.querySelector('[data-import-trigger]').addEventListener('click', () => {
    document.querySelector('[data-import]').click();
  });
  document.querySelector('[data-import]').addEventListener('change', (event) => {
    importData(event.target.files[0]);
    event.target.value = '';
  });
  document.querySelector('[data-reset]').addEventListener('click', () => {
    if (!confirm('현재 편집 내용을 기본 데이터로 바꿀까요? Save Changes를 누르기 전에는 클라우드에 반영되지 않습니다.')) return;
    data = clone(window.EML_DATA || {});
    markDirty();
    render();
    toast('기본 데이터를 초안으로 불러왔습니다.');
  });
  document.querySelector('[data-reload-cloud]').addEventListener('click', reloadCloudData);
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
    toast('기존 초안을 불러왔습니다. Save Changes를 눌러 클라우드에 게시하세요.');
  });
  document.querySelector('[data-logout]').addEventListener('click', async () => {
    if (isDirty && !confirm('저장하지 않은 변경사항이 있습니다. 로그아웃할까요?')) return;
    isDirty = false;
    sessionDraft = null;
    sessionDraftExport.hidden = true;
    const logoutBusyOwner = beginBusy('로그아웃 중');
    try {
      await window.EMLCloud.signOut();
      showLogin('로그아웃되었습니다.');
    } catch (error) {
      toast(`로그아웃 실패: ${error.message}`);
    } finally {
      endBusy(logoutBusyOwner);
    }
  });
  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = document.querySelector('[data-login-submit]');
    const message = document.querySelector('[data-auth-message]');
    submit.disabled = true;
    message.textContent = '로그인 중입니다.';
    try {
      const session = await window.EMLCloud.signIn(
        document.querySelector('[data-login-id]').value.trim(),
        document.querySelector('[data-login-password]').value,
      );
      if (!session) throw new Error('로그인 세션을 만들지 못했습니다.');
      await openEditor(session);
    } catch (error) {
      console.error(error);
      showLogin(`로그인 실패: ${error.message}`);
    } finally {
      submit.disabled = false;
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
