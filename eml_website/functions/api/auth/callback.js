import {
  ApiError,
  OAUTH_COOKIE,
  clearOAuthCookie,
  clearSessionCookie,
  constantTimeEqual,
  createSessionCookie,
  getOAuthConfig,
  getRequestOrigin,
  normalizeError,
  openCookiePayload,
  parseCookies,
  redirectResponse,
  safeReturnTo,
  verifyAuthorizedUser,
} from './session.js';

function authResultLocation(origin, returnTo, result, reason = '') {
  const destination = new URL(safeReturnTo(returnTo), origin);
  destination.searchParams.set('auth', result);
  if (reason) destination.searchParams.set('reason', reason);
  return destination.toString();
}

function callbackFailure(origin, returnTo, error) {
  const normalized = normalizeError(error);
  return redirectResponse(authResultLocation(origin, returnTo, 'error', normalized.code), {
    cookies: [clearOAuthCookie(), clearSessionCookie()],
  });
}

async function exchangeAuthorizationCode({ code, codeVerifier, redirectUri, config }) {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  if (config.repositoryId) body.set('repository_id', config.repositoryId);

  let response;
  try {
    response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        'User-Agent': 'EML-Website-Admin',
      },
      body: body.toString(),
    });
  } catch {
    throw new ApiError(502, 'github_oauth_unavailable', 'GitHub 로그인 서버에 연결하지 못했습니다. 잠시 후 다시 시도하세요.');
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(502, 'invalid_oauth_response', 'GitHub 로그인 응답을 확인하지 못했습니다.');
  }
  if (!response.ok || payload.error) {
    const codeName = typeof payload.error === 'string' ? payload.error : 'oauth_exchange_failed';
    console.warn('GitHub App token exchange failed', { status: response.status, code: codeName });
    throw new ApiError(401, 'oauth_exchange_failed', 'GitHub 인증 코드를 사용할 수 없거나 만료되었습니다. 다시 로그인하세요.');
  }
  if (typeof payload.access_token !== 'string' || !payload.access_token.startsWith('ghu_')) {
    throw new ApiError(500, 'github_app_required', 'GitHub App user access token을 받지 못했습니다. GitHub App 설정을 확인하세요.');
  }
  if (payload.scope && String(payload.scope).trim() !== '') {
    throw new ApiError(500, 'github_app_required', '광범위한 OAuth scope가 감지되었습니다. 저장소 전용 GitHub App을 사용하세요.');
  }
  return payload;
}

export async function onRequestGet({ request, env }) {
  let origin;
  let returnTo = '/admin.html';
  try {
    const config = getOAuthConfig(env);
    origin = getRequestOrigin(request, env);
    if (new URL(request.url).origin !== origin) {
      throw new ApiError(400, 'callback_origin_mismatch', 'OAuth callback이 등록된 공개 주소와 일치하지 않습니다.');
    }

    const sealedState = parseCookies(request)[OAUTH_COOKIE];
    const oauth = await openCookiePayload(sealedState, env, 'eml-oauth-state');
    if (oauth && typeof oauth.returnTo === 'string') returnTo = safeReturnTo(oauth.returnTo);

    const callbackUrl = new URL(request.url);
    if (callbackUrl.searchParams.has('error')) {
      throw new ApiError(401, 'oauth_denied', 'GitHub 로그인이 취소되었거나 승인되지 않았습니다.');
    }
    const code = callbackUrl.searchParams.get('code');
    const state = callbackUrl.searchParams.get('state');
    const now = Math.floor(Date.now() / 1000);
    if (
      !oauth || oauth.v !== 1 || typeof oauth.state !== 'string' || typeof oauth.codeVerifier !== 'string'
      || !Number.isInteger(oauth.iat) || !Number.isInteger(oauth.exp) || oauth.iat > now + 60 || oauth.exp <= now
      || oauth.exp - oauth.iat > 10 * 60 || oauth.origin !== origin
    ) {
      throw new ApiError(401, 'invalid_oauth_state', '로그인 요청이 만료되었거나 유효하지 않습니다. 다시 로그인하세요.');
    }
    if (!code || code.length > 512 || !state || !constantTimeEqual(state, oauth.state)) {
      throw new ApiError(401, 'oauth_state_mismatch', 'GitHub 로그인 state 검증에 실패했습니다. 다시 로그인하세요.');
    }

    const token = await exchangeAuthorizationCode({
      code,
      codeVerifier: oauth.codeVerifier,
      redirectUri: `${origin}/api/auth/callback`,
      config,
    });
    const verified = await verifyAuthorizedUser(token.access_token, config);
    const session = await createSessionCookie(
      {
        token: token.access_token,
        tokenExpiresIn: token.expires_in,
        user: verified.user,
        repositoryId: verified.repositoryId,
      },
      env,
    );

    return redirectResponse(authResultLocation(origin, returnTo, 'success'), {
      cookies: [clearOAuthCookie(), session.cookie],
    });
  } catch (error) {
    if (!origin) {
      try {
        origin = new URL(request.url).origin;
      } catch {
        origin = 'https://invalid.local';
      }
    }
    return callbackFailure(origin, returnTo, error);
  }
}
