(function (global) {
  'use strict';

  // Supabase Dashboard > Project Settings > API에서 아래 두 값을 복사하세요.
  // Publishable key(sb_publishable_...)는 브라우저에 공개해도 되는 키입니다.
  // Secret key 또는 service_role key는 절대로 이 파일에 넣지 마세요.
  global.EML_CLOUD_CONFIG = Object.freeze({
    supabaseUrl: 'https://xwhiwnanxuuywsqyfmxm.supabase.co',
    supabasePublishableKey: 'sb_publishable_tSiGUxI_SkNp6qX9Go8K2g_IZRwpXd6',
    // 로그인 화면에서는 아래 아이디만 받습니다. 내부 이메일은 Supabase Auth 연결용입니다.
    adminLoginId: 'eml2022##',
    adminAuthEmail: 'eml-admin@example.com',
    contentTable: 'site_content',
    contentId: 'main',
    storageBucket: 'site-media',
    storageFolder: 'uploads',
    maxImageBytes: 10 * 1024 * 1024,
  });
})(window);
