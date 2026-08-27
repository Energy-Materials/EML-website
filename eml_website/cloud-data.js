(function (global) {
  'use strict';

  const config = global.EML_CLOUD_CONFIG || {};
  const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  const extensionByType = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  let client = null;
  let activeChannel = null;

  function keyLooksSecret(key) {
    if (/^sb_secret_/i.test(key)) return true;
    if (!key.startsWith('eyJ') || typeof global.atob !== 'function') return false;
    try {
      const rawPayload = key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = rawPayload.padEnd(Math.ceil(rawPayload.length / 4) * 4, '=');
      const role = JSON.parse(global.atob(payload)).role;
      return role === 'service_role' || role === 'supabase_admin';
    } catch (error) {
      return false;
    }
  }

  function isConfigured() {
    const url = String(config.supabaseUrl || '').trim();
    const key = String(config.supabasePublishableKey || '').trim();
    return /^https:\/\//i.test(url)
      && !url.includes('YOUR_PROJECT_REF')
      && key.length > 20
      && !key.includes('YOUR_SUPABASE_PUBLISHABLE_KEY')
      && !keyLooksSecret(key);
  }

  function getClient() {
    if (!isConfigured()) {
      throw new Error('Supabase 연결 정보가 아직 설정되지 않았습니다.');
    }
    if (!global.supabase || typeof global.supabase.createClient !== 'function') {
      throw new Error('Supabase SDK를 불러오지 못했습니다. 네트워크 연결을 확인하세요.');
    }
    if (!client) {
      client = global.supabase.createClient(
        String(config.supabaseUrl).trim().replace(/\/$/, ''),
        String(config.supabasePublishableKey).trim(),
        {
          auth: {
            autoRefreshToken: true,
            persistSession: true,
            detectSessionInUrl: true,
          },
        },
      );
    }
    return client;
  }

  function throwIfError(error, fallbackMessage) {
    if (!error) return;
    const wrapped = new Error(error.message || fallbackMessage);
    wrapped.code = error.code || '';
    wrapped.details = error.details || '';
    throw wrapped;
  }

  async function loadContent() {
    const db = getClient();
    const { data, error } = await db
      .from(config.contentTable || 'site_content')
      .select('content, revision, updated_at')
      .eq('id', config.contentId || 'main')
      .maybeSingle();
    throwIfError(error, '홈페이지 데이터를 불러오지 못했습니다.');
    if (!data) throw new Error('site_content의 main 행이 없습니다. setup.sql을 다시 실행하세요.');
    return {
      content: data.content || null,
      revision: Number(data.revision || 0),
      updatedAt: data.updated_at || null,
    };
  }

  async function saveContent(content, expectedRevision) {
    const db = getClient();
    const { data, error } = await db
      .from(config.contentTable || 'site_content')
      .update({ content })
      .eq('id', config.contentId || 'main')
      .eq('revision', Number(expectedRevision || 0))
      .select('content, revision, updated_at')
      .maybeSingle();
    throwIfError(error, '홈페이지 데이터를 저장하지 못했습니다.');
    if (!data) {
      const conflict = new Error('다른 관리자 화면에서 먼저 저장했습니다. 최신 내용을 다시 불러온 뒤 수정하세요.');
      conflict.code = 'EML_CONTENT_CONFLICT';
      throw conflict;
    }
    return {
      content: data.content,
      revision: Number(data.revision || 0),
      updatedAt: data.updated_at || null,
    };
  }

  async function getSession() {
    const { data, error } = await getClient().auth.getSession();
    throwIfError(error, '로그인 상태를 확인하지 못했습니다.');
    return data.session || null;
  }

  async function signIn(identifier, password) {
    const configuredLoginId = String(config.adminLoginId || '').trim();
    const identifierValue = String(identifier || '').trim();
    let email = identifierValue;
    if (configuredLoginId) {
      if (identifierValue !== configuredLoginId) {
        throw new Error('아이디 또는 비밀번호가 올바르지 않습니다.');
      }
      email = String(config.adminAuthEmail || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error('supabase-config.js의 내부 관리자 이메일 설정을 확인하세요.');
      }
    }
    const { data, error } = await getClient().auth.signInWithPassword({ email, password });
    throwIfError(error, '로그인하지 못했습니다.');
    return data.session || null;
  }

  async function signOut() {
    const { error } = await getClient().auth.signOut({ scope: 'local' });
    throwIfError(error, '로그아웃하지 못했습니다.');
  }

  async function isAdmin() {
    const { data, error } = await getClient()
      .from('admin_users')
      .select('user_id')
      .maybeSingle();
    throwIfError(error, '관리자 권한을 확인하지 못했습니다.');
    return Boolean(data && data.user_id);
  }

  function onAuthStateChange(callback) {
    return getClient().auth.onAuthStateChange((event, session) => callback(event, session));
  }

  function validateImage(file) {
    if (!file || !allowedImageTypes.has(file.type)) {
      throw new Error('JPG, PNG, WebP 또는 GIF 이미지만 업로드할 수 있습니다.');
    }
    const maxBytes = Number(config.maxImageBytes || 10 * 1024 * 1024);
    if (file.size > maxBytes) {
      throw new Error(`이미지는 ${Math.round(maxBytes / 1024 / 1024)}MB 이하여야 합니다.`);
    }
  }

  function randomId() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
  }

  function createObjectPath(file) {
    const now = new Date();
    const year = String(now.getUTCFullYear());
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const extension = extensionByType[file.type] || 'bin';
    const folder = String(config.storageFolder || 'uploads').replace(/^\/+|\/+$/g, '');
    return `${folder}/${year}/${month}/${randomId()}.${extension}`;
  }

  async function uploadImage(file) {
    validateImage(file);
    const db = getClient();
    const bucket = config.storageBucket || 'site-media';
    const path = createObjectPath(file);
    const { error } = await db.storage
      .from(bucket)
      .upload(path, file, {
        cacheControl: '31536000',
        contentType: file.type,
        upsert: false,
      });
    throwIfError(error, '이미지를 업로드하지 못했습니다.');
    const { data } = db.storage.from(bucket).getPublicUrl(path);
    if (!data || !data.publicUrl) throw new Error('업로드한 이미지 주소를 만들지 못했습니다.');
    return data.publicUrl;
  }

  async function uploadDataUrl(dataUrl, label = 'legacy-image') {
    const response = await fetch(dataUrl);
    if (!response.ok) throw new Error('기존 브라우저 이미지를 변환하지 못했습니다.');
    const blob = await response.blob();
    const extension = extensionByType[blob.type] || 'bin';
    const file = new File([blob], `${label}.${extension}`, { type: blob.type });
    return uploadImage(file);
  }

  function subscribeContent(onContent, onStatus) {
    const db = getClient();
    if (activeChannel) db.removeChannel(activeChannel);
    activeChannel = db
      .channel(`site-content-${config.contentId || 'main'}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: config.contentTable || 'site_content',
          filter: `id=eq.${config.contentId || 'main'}`,
        },
        (payload) => {
          const row = payload.new || {};
          if (row.content) {
            onContent({
              content: row.content,
              revision: Number(row.revision || 0),
              updatedAt: row.updated_at || null,
            });
          }
        },
      )
      .subscribe((status) => {
        if (typeof onStatus === 'function') onStatus(status);
      });
    return () => {
      if (activeChannel) db.removeChannel(activeChannel);
      activeChannel = null;
    };
  }

  global.EMLCloud = Object.freeze({
    config,
    isConfigured,
    loadContent,
    saveContent,
    getSession,
    signIn,
    signOut,
    isAdmin,
    onAuthStateChange,
    validateImage,
    uploadImage,
    uploadDataUrl,
    subscribeContent,
  });
})(window);
