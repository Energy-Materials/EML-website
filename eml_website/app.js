(function () {
  const routes = ['home', 'research', 'members', 'publications', 'gallery', 'contact'];
  const app = document.getElementById('app');
  const modal = document.querySelector('[data-modal]');
  const modalContent = document.querySelector('[data-modal-content]');
  const lightbox = document.querySelector('[data-lightbox]');
  const siteShell = document.querySelector('.site-shell');
  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let particleFrame = null;
  let particleCanvas = null;
  let particleResize = null;
  let lightboxState = { itemIndex: 0, imageIndex: 0, touchX: null, touchY: null };
  let modalReturnFocus = null;
  let lightboxReturnFocus = null;

  const focusableSelector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  let data = clone(window.EML_DATA || {});

  function escapeHTML(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function escapeAttr(value) { return escapeHTML(value).replaceAll('`', '&#096;'); }

  function asset(path, fallback = '') {
    const raw = String(path || fallback || '').trim();
    if (!raw || /[\u0000-\u001f"'()\\]/.test(raw)) return fallback || '';
    if (/^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(raw)) return raw;
    try {
      const resolved = new URL(raw, window.location.href);
      return ['http:', 'https:'].includes(resolved.protocol) ? raw : (fallback || '');
    } catch (error) {
      return fallback || '';
    }
  }

  function routeFromHash() {
    const route = (location.hash || '#home').replace('#', '').split('/')[0];
    return routes.includes(route) ? route : 'home';
  }

  function setActiveRoute(route) {
    document.querySelectorAll('[data-route]').forEach((link) => {
      const isActive = link.dataset.route === route;
      link.classList.toggle('is-active', isActive);
      if (isActive) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  function navigate(route) {
    location.hash = route;
  }

  function parseDateValue(value) {
    const raw = String(value || '').replace(/[^0-9]/g, '');
    if (raw.length >= 8) return Number(raw.slice(0, 8));
    if (raw.length >= 6) return Number(raw.slice(0, 6) + '00');
    return 0;
  }

  function latestPublications(count = 3) {
    return [...(data.publications || [])]
      .sort((a, b) => Number(b.number || 0) - Number(a.number || 0))
      .slice(0, count);
  }

  function latestGallery(count = 3) {
    return [...(data.gallery || [])]
      .sort((a, b) => parseDateValue(b.date) - parseDateValue(a.date))
      .slice(0, count);
  }

  function imagesForGallery(item) {
    if (Array.isArray(item.images)) {
      return item.images.length ? item.images : ['assets/gallery-placeholder-1.svg'];
    }
    if (item.image) return [item.image];
    return ['assets/gallery-placeholder-1.svg'];
  }

  function updateShell() {
    const s = data.site || {};
    document.querySelectorAll('[data-brand-logo]').forEach((img) => { img.src = asset(s.logoWhite, 'assets/eml-logo-white.svg'); });
    document.querySelectorAll('[data-footer-logo]').forEach((img) => { img.src = asset(s.logoWhite, 'assets/eml-logo-white.svg'); });
    const addressEl = document.querySelector('[data-footer-address]');
    const emailEl = document.querySelector('[data-footer-email]');
    const copyrightEl = document.querySelector('[data-footer-copyright]');
    if (addressEl) addressEl.textContent = s.address || '';
    if (emailEl) {
      emailEl.textContent = s.email || '';
      emailEl.href = `mailto:${s.email || ''}`;
    }
    if (copyrightEl) copyrightEl.textContent = s.copyright || '';
  }

  function render(options = {}) {
    const resetView = options.resetView !== false;
    if (resetView) {
      closeModal();
      closeLightbox();
    }
    cancelParticles();
    const route = routeFromHash();
    setActiveRoute(route);
    document.querySelector('[data-header]').classList.toggle('force-solid', route !== 'home');
    const renderMap = {
      home: renderHome,
      research: renderResearch,
      members: renderMembers,
      publications: renderPublications,
      gallery: renderGallery,
      contact: renderContact,
    };
    app.innerHTML = renderMap[route]();
    if (options.focus !== false) app.focus({ preventScroll: true });
    bindPageEvents(route);
    initReveal();
    updateShell();
    if (options.scroll !== false) window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function renderHero() {
    const h = data.home || {};
    const s = data.site || {};
    const secondRoute = h.ctaSecondaryRoute || 'contact';
    const heroImage = asset(s.heroImage, 'assets/hero-concept-from-pdf.png');
    return `
      <section class="hero" aria-label="Main home banner" style="--hero-image: url('${escapeAttr(heroImage)}')">
        <canvas class="hero-particles" data-particles aria-hidden="true"></canvas>
        <div class="hero-content">
          <p class="hero-label"><img src="${escapeAttr(asset(s.knuLogo, 'assets/knu-logo.png'))}" alt="Kongju National University logo" />${escapeHTML(h.eyebrow || s.university || '')}</p>
          <h1 class="hero-title">
            ${(h.titleLines || ['Energy Materials', 'Laboratory']).map((line) => `<span>${escapeHTML(line)}</span>`).join('')}
          </h1>
          <p class="hero-subtitle">${escapeHTML(h.subtitleKr || s.labNameKr || '')}</p>
          <p class="hero-copy">${escapeHTML(h.intro || '')}</p>
          <div class="hero-actions">
            <button class="btn primary" type="button" data-go="research">${escapeHTML(h.ctaPrimary || 'Explore Research')} <span class="button-icon" aria-hidden="true">→</span></button>
            <button class="btn ghost" type="button" data-go="${escapeAttr(secondRoute)}">${escapeHTML(h.ctaSecondary || 'Contact')} <span class="button-icon" aria-hidden="true">→</span></button>
          </div>
        </div>
        <div class="scroll-indicator"><span></span> Scroll</div>
      </section>
    `;
  }

  function renderHome() {
    const topics = data.researchTopics || [];
    const publications = latestPublications(3);
    const gallery = latestGallery(3);
    return `
      ${renderHero()}
      <section class="section research-preview">
        <div class="container home-research-layout">
          <div class="home-research-copy reveal">
            <p class="section-kicker">Research Focus</p>
            <h2 class="section-title">Our Research</h2>
            <h3 class="research-theme-title">Battery materials and interface science</h3>
            <p class="section-lead">Research, Publications, and Gallery are connected from the home page so visitors can quickly enter the main content.</p>
            <button class="btn secondary" type="button" data-go="research" style="margin-top:24px">View Research <span class="button-icon" aria-hidden="true">→</span></button>
          </div>
          <div class="research-card-grid">
            ${topics.map((topic) => `
              <article class="research-card reveal">
                <img src="${escapeAttr(asset(topic.image, 'assets/research-electrode-interface.svg'))}" alt="${escapeAttr(topic.title)}" />
                <div class="research-card-body">
                  <h3>${escapeHTML(topic.title)}</h3>
                  <p>${escapeHTML(topic.short)}</p>
                  <button class="link-more" type="button" data-go="research" aria-label="View more about ${escapeAttr(topic.title || 'this research topic')}">View More <span class="button-icon" aria-hidden="true">→</span></button>
                </div>
              </article>
            `).join('')}
          </div>
        </div>
      </section>

      <section class="section highlight-band">
        <div class="container home-split">
          <div class="panel reveal">
            <p class="section-kicker">Publication</p>
            <h3>Recent Publications</h3>
            <div class="publication-list">
              ${publications.map((pub) => `
                <button class="pub-item" type="button" data-go="publications">
                  <b>${escapeHTML(pub.title)}</b>
                  <span>${escapeHTML(pub.journal)} · ${escapeHTML(pub.year)}</span>
                </button>
              `).join('')}
            </div>
            <button class="btn ghost" type="button" data-go="publications">View Publications <span class="button-icon" aria-hidden="true">→</span></button>
          </div>
          <div class="panel reveal">
            <p class="section-kicker">Gallery</p>
            <h3>Laboratory Gallery</h3>
            <div class="news-list">
              ${gallery.map((item) => {
                const realIndex = (data.gallery || []).indexOf(item);
                return `
                  <button class="news-item" type="button" data-gallery-index="${realIndex}">
                    <b>${escapeHTML(item.title)}</b>
                    <span>${escapeHTML(item.date)} · ${escapeHTML(item.summary)}</span>
                  </button>
                `;
              }).join('')}
            </div>
            <button class="btn ghost" type="button" data-go="gallery">View Gallery <span class="button-icon" aria-hidden="true">→</span></button>
          </div>
        </div>
      </section>
    `;
  }

  function renderSubHero(title, desc) {
    const s = data.site || {};
    const heroImage = asset(s.heroImage, 'assets/hero-concept-from-pdf.png');
    return `
      <section class="sub-hero" style="--hero-image: url('${escapeAttr(heroImage)}')">
        <div class="container">
          <p class="section-kicker">${escapeHTML(s.shortName || 'EML')}</p>
          <h1>${escapeHTML(title)}</h1>
          <p>${escapeHTML(desc || '')}</p>
        </div>
      </section>
    `;
  }

  function renderResearch() {
    return `
      ${renderSubHero('Research', 'Advanced energy materials, rational electrode interface design, and electrochemical reaction analysis.')}
      <div class="single-tab-label"><span>Research Topic</span></div>
      <section class="section compact">
        <div class="container">${renderResearchTopics()}</div>
      </section>
    `;
  }

  function renderResearchTopics() {
    const topics = data.researchTopics || [];
    return `
      <div class="statement-box reveal">
        <h2>Research Statement</h2>
        <p>${escapeHTML(data.researchStatement || '')}</p>
      </div>
      <div class="section-head reveal">
        <div>
          <p class="section-kicker">Research Topic</p>
          <h2 class="section-title">Materials, interfaces,<br />and reaction dynamics</h2>
        </div>
      </div>
      <div class="topic-list">
        ${topics.map((topic, index) => `
          <article class="topic-row reveal">
            <div class="topic-image"><img src="${escapeAttr(asset(topic.image, 'assets/research-electrode-interface.svg'))}" alt="${escapeAttr(topic.title)}" /></div>
            <div class="topic-content">
              <span class="num">${String(index + 1).padStart(2, '0')}</span>
              <h3>${escapeHTML(topic.title)}</h3>
              <p>${escapeHTML(topic.description)}</p>
            </div>
          </article>
        `).join('')}
      </div>
    `;
  }

  function renderMembers() {
    return `
      ${renderSubHero('Members', 'Professor, current members, and alumni in one consistent card system.')}
      <div class="sub-tabs" role="tablist" aria-label="Members tabs">
        <button class="sub-tab is-active" id="members-tab-professor" type="button" role="tab" aria-selected="true" aria-controls="members-tabpanel" tabindex="0" data-member-tab="professor">Professor</button>
        <button class="sub-tab" id="members-tab-members" type="button" role="tab" aria-selected="false" aria-controls="members-tabpanel" tabindex="-1" data-member-tab="members">Members</button>
        <button class="sub-tab" id="members-tab-alumni" type="button" role="tab" aria-selected="false" aria-controls="members-tabpanel" tabindex="-1" data-member-tab="alumni">Alumni</button>
      </div>
      <section class="section compact">
        <div class="container member-tabs-body" id="members-tabpanel" role="tabpanel" aria-labelledby="members-tab-professor" data-member-body>${renderProfessor()}</div>
      </section>
    `;
  }

  function renderProfessor() {
    const p = data.professor || {};
    return `
      <article class="prof-card reveal">
        <img class="prof-photo" src="${escapeAttr(asset(p.photo, 'assets/person-placeholder.svg'))}" alt="${escapeAttr(p.name || 'Professor')}" />
        <div class="prof-info">
          <h2>${escapeHTML(p.name || '')}</h2>
          <p class="role">${escapeHTML(p.role || '')}</p>
          <p class="department">${escapeHTML(p.department || '')}</p>
          <div class="info-pill-row">
            <a class="info-pill" href="mailto:${escapeAttr(p.email || '')}">E-mail: ${escapeHTML(p.email || '')}</a>
            ${(p.interest || []).map((v) => `<span class="info-pill">${escapeHTML(v)}</span>`).join('')}
          </div>
          <div class="cv-grid">
            <div>
              <h3>Education</h3>
              <ul>${(p.education || []).map((v) => `<li>${escapeHTML(v)}</li>`).join('')}</ul>
            </div>
            <div>
              <h3>Research Experience</h3>
              <ul>${(p.experience || []).map((v) => `<li>${escapeHTML(v)}</li>`).join('')}</ul>
            </div>
          </div>
        </div>
      </article>
    `;
  }

  function renderMemberCards() {
    const members = data.members || [];
    return `
      <div class="member-grid">
        ${members.map((m) => `
          <article class="member-card reveal">
            <img src="${escapeAttr(asset(m.photo, 'assets/person-placeholder.svg'))}" alt="${escapeAttr(m.name)}" />
            <div>
              <h3>${escapeHTML(m.name)}</h3>
              <p class="role">${escapeHTML(m.role)}</p>
              <p><strong>Period</strong><br />${escapeHTML(m.period || '')}</p>
              ${m.email ? `<p><strong>E-mail</strong><br /><a href="mailto:${escapeAttr(m.email)}">${escapeHTML(m.email)}</a></p>` : ''}
              <p><strong>Research Interest</strong><br />${escapeHTML(m.research || 'Energy materials')}</p>
            </div>
          </article>
        `).join('')}
      </div>
    `;
  }

  function renderAlumni() {
    return `
      <div class="alumni-grid">
        ${(data.alumni || []).map((a) => `
          <article class="alumni-card reveal">
            <span class="date">${escapeHTML(a.date)}</span>
            <h3>${escapeHTML(a.name)}</h3>
            <p>${escapeHTML(a.next)}</p>
          </article>
        `).join('')}
      </div>
    `;
  }

  function renderPublications() {
    return `
      ${renderSubHero('Publications', 'Journal articles and patents are organized for easy update from admin data.')}
      <div class="sub-tabs" role="tablist" aria-label="Publication tabs">
        <button class="sub-tab is-active" id="publications-tab-papers" type="button" role="tab" aria-selected="true" aria-controls="publications-tabpanel" tabindex="0" data-pub-tab="papers">Papers</button>
        <button class="sub-tab" id="publications-tab-patents" type="button" role="tab" aria-selected="false" aria-controls="publications-tabpanel" tabindex="-1" data-pub-tab="patents">Patents</button>
      </div>
      <section class="section compact">
        <div class="container" id="publications-tabpanel" role="tabpanel" aria-labelledby="publications-tab-papers" data-publication-panel>
          <div class="publication-controls reveal">
            <input class="search-input" type="search" aria-label="Search publications" placeholder="Search title, author, journal..." data-publication-search />
          </div>
          <div data-publication-body aria-live="polite">${renderPaperList(data.publications || [])}</div>
        </div>
      </section>
    `;
  }

  function renderPaperList(list) {
    if (!list.length) return '<div class="empty-state" role="status"><strong>표시할 논문이 없습니다.</strong><p>검색어를 바꾸거나 관리자에서 논문을 추가해 주세요.</p></div>';
    return `<div class="publication-stack">
      ${list.map((pub) => `
        <article class="publication-card reveal">
          <div class="year-badge"><small>#${escapeHTML(pub.number ?? '')}</small>${escapeHTML(pub.year)}</div>
          <div>
            <h3>${escapeHTML(pub.title)}</h3>
            <p>${escapeHTML(pub.authors)}</p>
            <p><strong>${escapeHTML(pub.journal)}</strong></p>
            ${pub.note ? `<span class="note">${escapeHTML(pub.note)}</span>` : ''}
          </div>
        </article>
      `).join('')}
    </div>`;
  }

  function renderPatentList() {
    if (!(data.patents || []).length) return '<div class="empty-state" role="status"><strong>표시할 특허가 없습니다.</strong><p>관리자에서 특허를 추가하면 이곳에 표시됩니다.</p></div>';
    return `<div class="publication-stack">
      ${(data.patents || []).map((patent, index) => `
        <article class="publication-card reveal">
          <div class="year-badge"><small>#${(data.patents || []).length - index}</small>${escapeHTML(patent.year || '')}</div>
          <div>
            <h3>${escapeHTML(patent.title)}</h3>
            <p>${escapeHTML(patent.inventors)}</p>
            <p><strong>${escapeHTML(patent.number)}</strong></p>
          </div>
        </article>
      `).join('')}
    </div>`;
  }

  function renderGallery() {
    return `
      ${renderSubHero('Gallery', 'Lab seminars, conferences, awards, and group events in clickable card format.')}
      <section class="section compact">
        <div class="container">
          <div class="section-head reveal">
            <div>
              <p class="section-kicker">Lab Gallery</p>
              <h2 class="section-title small-title">Click a card<br />to view photos</h2>
            </div>
            <p class="section-lead">Each gallery post can contain multiple photos. Click a card to open a larger carousel with keyboard, swipe, and previous/next controls.</p>
          </div>
          <div class="gallery-grid" aria-live="polite">
            ${(data.gallery || []).length ? (data.gallery || []).map((item, index) => {
              const imgs = imagesForGallery(item);
              return `
                <button class="gallery-card reveal" type="button" data-gallery-index="${index}">
                  <img src="${escapeAttr(asset(imgs[0], 'assets/gallery-placeholder-1.svg'))}" alt="" />
                  <div class="gallery-card-body">
                    <div class="gallery-date">${escapeHTML(item.date)} · ${imgs.length} photos</div>
                    <h3>${escapeHTML(item.title)}</h3>
                    <p>${escapeHTML(item.summary || '')}</p>
                  </div>
                </button>
              `;
            }).join('') : '<div class="empty-state" role="status"><strong>등록된 갤러리가 없습니다.</strong><p>새 소식과 사진이 등록되면 이곳에 표시됩니다.</p></div>'}
          </div>
        </div>
      </section>
    `;
  }

  function renderContact() {
    const s = data.site || {};
    const mapImage = asset(s.mapImage);
    const mapEmbed = asset(s.mapEmbed);
    const map = mapImage
      ? `<img src="${escapeAttr(mapImage)}" alt="Kongju National University map" />`
      : mapEmbed
        ? `<iframe src="${escapeAttr(mapEmbed)}" loading="lazy" allowfullscreen referrerpolicy="no-referrer-when-downgrade" title="Kongju National University map"></iframe>`
        : `<div class="map-fallback"><div><h3>Kongju National University</h3><p>Replace this panel with Google Map embed or campus map image from admin.</p></div></div>`;
    return `
      ${renderSubHero('Contact', 'Join us and contact the Energy Materials Laboratory.')}
      <section class="section compact">
        <div class="container contact-grid">
          <div class="contact-card reveal">
            <p class="section-kicker">Contact</p>
            <h2>Get in touch</h2>
            <div class="contact-row"><strong>Lab</strong><span>${escapeHTML(s.labName)}<br />${escapeHTML(s.labNameKr)}</span></div>
            <div class="contact-row"><strong>Address</strong><span>${escapeHTML(s.address)}</span></div>
            ${s.phone ? `<div class="contact-row"><strong>Phone</strong><span>${escapeHTML(s.phone)}</span></div>` : ''}
            <div class="contact-row"><strong>E-mail</strong><span><a href="mailto:${escapeAttr(s.email)}">${escapeHTML(s.email)}</a></span></div>
            <div class="contact-row"><strong>Join Us</strong><span>${escapeHTML(s.joinMessage || '')}</span></div>
          </div>
          <div class="map-card reveal">${map}</div>
        </div>
      </section>
    `;
  }

  function bindTabList(tabList, onActivate) {
    if (!tabList) return;
    const tabs = Array.from(tabList.querySelectorAll('[role="tab"]'));
    if (!tabs.length) return;

    function activateTab(tab, options = {}) {
      if (!tabs.includes(tab)) return;
      const changed = tab.getAttribute('aria-selected') !== 'true';
      tabs.forEach((item) => {
        const isSelected = item === tab;
        item.classList.toggle('is-active', isSelected);
        item.setAttribute('aria-selected', String(isSelected));
        item.tabIndex = isSelected ? 0 : -1;
      });
      if (changed) onActivate(tab);
      if (options.focus) tab.focus({ preventScroll: true });
    }

    tabs.forEach((tab) => {
      tab.addEventListener('click', () => activateTab(tab));
      tab.addEventListener('keydown', (event) => {
        if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
        const currentIndex = tabs.indexOf(event.currentTarget);
        let nextIndex = currentIndex;
        if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = tabs.length - 1;
        else return;
        event.preventDefault();
        activateTab(tabs[nextIndex], { focus: true });
      });
    });
  }

  function bindPageEvents(route) {
    app.querySelectorAll('[data-go]').forEach((button) => {
      button.addEventListener('click', () => navigate(button.dataset.go));
    });

    if (route === 'home') initParticles();

    if (route === 'members') {
      const body = app.querySelector('[data-member-body]');
      const tabRender = { professor: renderProfessor, members: renderMemberCards, alumni: renderAlumni };
      bindTabList(app.querySelector('[role="tablist"]'), (tab) => {
        body.setAttribute('aria-labelledby', tab.id);
        body.innerHTML = tabRender[tab.dataset.memberTab]();
        initReveal();
      });
    }

    if (route === 'publications') {
      const body = app.querySelector('[data-publication-body]');
      const panel = app.querySelector('[data-publication-panel]');
      const controls = app.querySelector('.publication-controls');
      let active = 'papers';
      const search = app.querySelector('[data-publication-search]');
      function updateList() {
        const term = (search.value || '').toLowerCase();
        if (active === 'patents') {
          body.innerHTML = renderPatentList();
        } else {
          const filtered = (data.publications || []).filter((pub) => JSON.stringify(pub).toLowerCase().includes(term));
          body.innerHTML = renderPaperList(filtered);
        }
        initReveal();
      }
      search.addEventListener('input', updateList);
      bindTabList(app.querySelector('[role="tablist"]'), (tab) => {
        active = tab.dataset.pubTab;
        panel.setAttribute('aria-labelledby', tab.id);
        controls.hidden = active !== 'papers';
        updateList();
      });
    }

    app.querySelectorAll('[data-gallery-index]').forEach((button) => {
      button.addEventListener('click', () => openGalleryLightbox(Number(button.dataset.galleryIndex), 0));
    });
  }

  function isOverlayOpen(overlay) {
    return Boolean(overlay && overlay.classList.contains('is-open'));
  }

  function getActiveOverlay() {
    if (isOverlayOpen(lightbox)) return lightbox;
    if (isOverlayOpen(modal)) return modal;
    return null;
  }

  function getFocusableElements(overlay) {
    return Array.from(overlay.querySelectorAll(focusableSelector)).filter((element) => (
      !element.hasAttribute('disabled')
      && !element.hasAttribute('hidden')
      && element.getAttribute('aria-hidden') !== 'true'
    ));
  }

  function focusOverlay(overlay) {
    if (!isOverlayOpen(overlay)) return;
    const preferred = overlay === lightbox
      ? overlay.querySelector('.lightbox-close')
      : overlay.querySelector('.modal-close');
    const target = preferred || getFocusableElements(overlay)[0] || overlay.querySelector('[role="dialog"]');
    if (target) target.focus({ preventScroll: true });
  }

  function queueOverlayFocus(overlay) {
    window.requestAnimationFrame(() => focusOverlay(overlay));
  }

  function syncOverlayState() {
    const hasOpenOverlay = Boolean(getActiveOverlay());
    document.body.classList.toggle('no-scroll', hasOpenOverlay);
    if (siteShell) siteShell.inert = hasOpenOverlay;
  }

  function restoreFocusAfterClose(returnFocus) {
    window.requestAnimationFrame(() => {
      const activeOverlay = getActiveOverlay();
      if (activeOverlay) {
        focusOverlay(activeOverlay);
        return;
      }
      if (returnFocus && returnFocus.isConnected && !returnFocus.hasAttribute('disabled')) {
        returnFocus.focus({ preventScroll: true });
      }
    });
  }

  function trapOverlayFocus(event, overlay) {
    const focusable = getFocusableElements(overlay);
    if (!focusable.length) {
      event.preventDefault();
      focusOverlay(overlay);
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (!overlay.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus({ preventScroll: true });
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }

  function openModal(html) {
    if (!modal || !modalContent) return;
    if (!isOverlayOpen(modal)) modalReturnFocus = document.activeElement;
    modalContent.innerHTML = html;
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    syncOverlayState();
    queueOverlayFocus(modal);
  }

  function closeModal(options = {}) {
    if (!modal) return;
    const wasOpen = isOverlayOpen(modal);
    const returnFocus = modalReturnFocus;
    modal.classList.remove('is-open');
    modal.setAttribute('aria-hidden', 'true');
    if (modalContent) modalContent.innerHTML = '';
    modalReturnFocus = null;
    syncOverlayState();
    if (wasOpen && options.restoreFocus !== false) restoreFocusAfterClose(returnFocus);
  }

  function openGalleryLightbox(itemIndex, imageIndex) {
    const item = (data.gallery || [])[itemIndex];
    if (!item) return;
    if (!isOverlayOpen(lightbox)) lightboxReturnFocus = document.activeElement;
    lightboxState = { itemIndex, imageIndex, touchX: null, touchY: null };
    lightbox.classList.add('is-open');
    lightbox.setAttribute('aria-hidden', 'false');
    updateLightbox();
    syncOverlayState();
    queueOverlayFocus(lightbox);
  }

  function updateLightbox() {
    const item = (data.gallery || [])[lightboxState.itemIndex];
    if (!item) return;
    const images = imagesForGallery(item);
    if (lightboxState.imageIndex < 0) lightboxState.imageIndex = images.length - 1;
    if (lightboxState.imageIndex >= images.length) lightboxState.imageIndex = 0;
    const img = lightbox.querySelector('[data-lightbox-image]');
    img.src = images[lightboxState.imageIndex];
    img.alt = item.title || 'Gallery image';
    lightbox.querySelector('[data-lightbox-count]').textContent = `${lightboxState.imageIndex + 1} / ${images.length}`;
    lightbox.querySelector('[data-lightbox-title]').textContent = item.title || '';
    lightbox.querySelector('[data-lightbox-meta]').textContent = `${item.date || ''}${item.summary ? ' · ' + item.summary : ''}`;
    lightbox.querySelector('[data-lightbox-body]').textContent = item.body || '';
    lightbox.querySelectorAll('[data-lightbox-prev], [data-lightbox-next]').forEach((button) => {
      button.hidden = images.length < 2;
      button.disabled = images.length < 2;
    });
  }

  function nextLightbox(delta) {
    const item = (data.gallery || [])[lightboxState.itemIndex];
    if (!item) return;
    lightboxState.imageIndex += delta;
    updateLightbox();
  }

  function closeLightbox(options = {}) {
    if (!lightbox) return;
    const wasOpen = isOverlayOpen(lightbox);
    const returnFocus = lightboxReturnFocus;
    lightbox.classList.remove('is-open');
    lightbox.setAttribute('aria-hidden', 'true');
    lightboxState.touchX = null;
    lightboxState.touchY = null;
    lightboxReturnFocus = null;
    syncOverlayState();
    if (wasOpen && options.restoreFocus !== false) restoreFocusAfterClose(returnFocus);
  }

  function initHeader() {
    const header = document.querySelector('[data-header]');
    const nav = document.querySelector('[data-nav]');
    const menu = document.querySelector('[data-menu-toggle]');
    function setMenuOpen(open, options = {}) {
      nav.classList.toggle('is-open', open);
      menu.setAttribute('aria-expanded', String(open));
      menu.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      if (!open && options.restoreFocus) menu.focus({ preventScroll: true });
    }
    function onScroll() {
      header.classList.toggle('is-scrolled', window.scrollY > 40);
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    menu.addEventListener('click', () => {
      setMenuOpen(!nav.classList.contains('is-open'));
    });
    nav.addEventListener('click', (event) => {
      if (event.target.closest('a')) setMenuOpen(false);
    });
    document.addEventListener('click', (event) => {
      if (nav.classList.contains('is-open') && !header.contains(event.target)) setMenuOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && nav.classList.contains('is-open') && !getActiveOverlay()) {
        event.preventDefault();
        setMenuOpen(false, { restoreFocus: true });
      }
    });
    window.addEventListener('resize', () => {
      if (window.innerWidth > 1040 && nav.classList.contains('is-open')) setMenuOpen(false);
    });
  }

  function initReveal() {
    const elements = Array.from(document.querySelectorAll('.reveal'));
    if (!('IntersectionObserver' in window)) {
      elements.forEach((el) => el.classList.add('in'));
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    elements.forEach((el) => observer.observe(el));
  }

  function initParticles() {
    const canvas = document.querySelector('[data-particles]');
    if (!canvas || reducedMotionQuery.matches) return;
    particleCanvas = canvas;
    const ctx = canvas.getContext('2d');
    const particles = [];
    const count = Math.min(88, Math.floor(window.innerWidth / 18));
    function resize() {
      canvas.width = window.innerWidth * window.devicePixelRatio;
      canvas.height = canvas.offsetHeight * window.devicePixelRatio;
      ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
    }
    particleResize = resize;
    function resetParticle(p) {
      p.x = Math.random() * window.innerWidth * 0.78;
      p.y = Math.random() * canvas.offsetHeight;
      p.r = Math.random() * 2.4 + 0.7;
      p.vx = Math.random() * 0.58 + 0.22;
      p.vy = (Math.random() - 0.5) * 0.42;
      p.alpha = Math.random() * 0.52 + 0.18;
    }
    resize();
    for (let i = 0; i < count; i += 1) {
      const p = {};
      resetParticle(p);
      particles.push(p);
    }
    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      particles.forEach((p, i) => {
        p.x += p.vx;
        p.y += Math.sin((Date.now() / 900) + i) * 0.16 + p.vy;
        if (p.x > window.innerWidth || p.y < -20 || p.y > canvas.offsetHeight + 20) resetParticle(p);
        const gradient = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 8);
        gradient.addColorStop(0, `rgba(167, 219, 255, ${p.alpha})`);
        gradient.addColorStop(1, 'rgba(95, 145, 191, 0)');
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * 8, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.restore();
      particleFrame = requestAnimationFrame(draw);
    }
    window.addEventListener('resize', resize, { passive: true });
    draw();
  }

  function cancelParticles() {
    if (particleFrame) cancelAnimationFrame(particleFrame);
    if (particleResize) window.removeEventListener('resize', particleResize);
    particleFrame = null;
    particleCanvas = null;
    particleResize = null;
  }

  modal.addEventListener('click', (event) => {
    if (event.target.closest('[data-modal-close]')) closeModal();
  });
  lightbox.addEventListener('click', (event) => {
    if (event.target.closest('[data-lightbox-close]')) closeLightbox();
  });
  lightbox.querySelector('[data-lightbox-prev]').addEventListener('click', () => nextLightbox(-1));
  lightbox.querySelector('[data-lightbox-next]').addEventListener('click', () => nextLightbox(1));
  lightbox.addEventListener('touchstart', (event) => {
    const touch = event.touches[0];
    if (!touch || !event.target.closest('[data-lightbox-image]')) {
      lightboxState.touchX = null;
      lightboxState.touchY = null;
      return;
    }
    lightboxState.touchX = touch.clientX;
    lightboxState.touchY = touch.clientY;
  }, { passive: true });
  lightbox.addEventListener('touchend', (event) => {
    const touch = event.changedTouches[0];
    if (lightboxState.touchX === null || lightboxState.touchY === null || !touch) return;
    const deltaX = touch.clientX - lightboxState.touchX;
    const deltaY = touch.clientY - lightboxState.touchY;
    if (Math.abs(deltaX) > 44 && Math.abs(deltaX) > Math.abs(deltaY) * 1.25) {
      nextLightbox(deltaX > 0 ? -1 : 1);
    }
    lightboxState.touchX = null;
    lightboxState.touchY = null;
  }, { passive: true });
  lightbox.addEventListener('touchcancel', () => {
    lightboxState.touchX = null;
    lightboxState.touchY = null;
  }, { passive: true });
  document.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    const activeOverlay = getActiveOverlay();
    if (!activeOverlay) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (activeOverlay === lightbox) closeLightbox();
      else closeModal();
      return;
    }
    if (event.key === 'Tab') {
      trapOverlayFocus(event, activeOverlay);
      return;
    }
    if (activeOverlay === lightbox && !event.altKey && !event.ctrlKey && !event.metaKey) {
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        nextLightbox(1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        nextLightbox(-1);
      }
    }
  });

  window.addEventListener('hashchange', () => {
    render();
  });
  reducedMotionQuery.addEventListener?.('change', () => {
    if (routeFromHash() !== 'home') return;
    cancelParticles();
    if (!reducedMotionQuery.matches) initParticles();
  });
  initHeader();
  render();
})();
