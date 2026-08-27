import {
  ApiError,
  OAUTH_COOKIE,
  OAUTH_STATE_SECONDS,
  SESSION_COOKIE,
  clearSessionCookie,
  errorResponse,
  getOAuthConfig,
  getRequestOrigin,
  jsonResponse,
  randomBase64Url,
  redirectResponse,
  safeReturnTo,
  sealCookiePayload,
  serializeCookie,
  sha256Base64Url,
} from './session.js';

export async function onRequestGet({ request, env }) {
  try {
    const config = getOAuthConfig(env);
    const requestOrigin = new URL(request.url).origin;
    const origin = getRequestOrigin(request, env);

    // Keep the OAuth state cookie and callback on the same canonical host.
    if (origin !== requestOrigin) {
      const current = new URL(request.url);
      const canonical = new URL('/api/auth/login', origin);
      if (current.searchParams.has('returnTo')) canonical.searchParams.set('returnTo', current.searchParams.get('returnTo'));
      return redirectResponse(canonical.toString(), { status: 302 });
    }

    const requestUrl = new URL(request.url);
    const returnTo = safeReturnTo(requestUrl.searchParams.get('returnTo'));
    const state = randomBase64Url(32);
    const codeVerifier = randomBase64Url(48);
    const codeChallenge = await sha256Base64Url(codeVerifier);
    const now = Math.floor(Date.now() / 1000);
    const oauthPayload = await sealCookiePayload(
      { v: 1, state, codeVerifier, returnTo, origin, iat: now, exp: now + OAUTH_STATE_SECONDS },
      env,
      'eml-oauth-state',
    );
    const redirectUri = `${origin}/api/auth/callback`;
    const authorization = new URL('https://github.com/login/oauth/authorize');
    authorization.searchParams.set('client_id', config.clientId);
    authorization.searchParams.set('redirect_uri', redirectUri);
    authorization.searchParams.set('state', state);
    authorization.searchParams.set('code_challenge', codeChallenge);
    authorization.searchParams.set('code_challenge_method', 'S256');
    authorization.searchParams.set('allow_signup', 'false');

    return redirectResponse(authorization.toString(), {
      status: 302,
      cookies: [
        serializeCookie(OAUTH_COOKIE, oauthPayload, { maxAge: OAUTH_STATE_SECONDS }),
        clearSessionCookie(),
      ],
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function onRequest({ request, env }) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResponse(
      { error: 'method_not_allowed', code: 'method_not_allowed', message: 'GET 요청만 허용됩니다.' },
      { status: 405, headers: { Allow: 'GET, HEAD' } },
    );
  }
  if (request.method === 'HEAD') {
    return errorResponse(new ApiError(405, 'method_not_allowed', 'OAuth 로그인은 GET 요청으로 시작해야 합니다.'));
  }
  return onRequestGet({ request, env });
}
