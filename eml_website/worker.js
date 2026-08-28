import { onRequest as loginRoute } from './functions/api/auth/login.js';
import { onRequestGet as callbackRoute } from './functions/api/auth/callback.js';
import {
  errorResponse,
  jsonResponse,
  onRequestGet as sessionRoute,
} from './functions/api/auth/session.js';
import { onRequestPost as logoutRoute } from './functions/api/auth/logout.js';
import { onRequest as contentRoute } from './functions/api/content.js';

function methodNotAllowed(allowed) {
  return jsonResponse(
    {
      error: 'method_not_allowed',
      code: 'method_not_allowed',
      message: `${allowed.join(' 또는 ')} 요청만 허용됩니다.`,
    },
    { status: 405, headers: { Allow: allowed.join(', ') } },
  );
}

async function routeApi(request, env, executionContext) {
  const { pathname } = new URL(request.url);
  const context = { request, env, waitUntil: executionContext.waitUntil.bind(executionContext) };

  if (pathname === '/api/auth/login') return loginRoute(context);
  if (pathname === '/api/auth/callback') {
    return request.method === 'GET' ? callbackRoute(context) : methodNotAllowed(['GET']);
  }
  if (pathname === '/api/auth/session') {
    return request.method === 'GET' ? sessionRoute(context) : methodNotAllowed(['GET']);
  }
  if (pathname === '/api/auth/logout') {
    return request.method === 'POST' ? logoutRoute(context) : methodNotAllowed(['POST']);
  }
  if (pathname === '/api/content') return contentRoute(context);

  return jsonResponse(
    { error: 'not_found', code: 'not_found', message: '요청한 관리자 API를 찾을 수 없습니다.' },
    { status: 404 },
  );
}

async function serveUploadedAsset(request, assets) {
  const response = await assets.fetch(request);
  const headers = new Headers(response.headers);
  headers.set(
    'Cache-Control',
    response.status >= 200 && response.status < 400
      ? 'public, max-age=31536000, immutable'
      : 'no-store, max-age=0',
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env, executionContext) {
    try {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        return await routeApi(request, env, executionContext);
      }
      if (pathname.startsWith('/assets/uploads/')) {
        return await serveUploadedAsset(request, env.ASSETS);
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      return errorResponse(error);
    }
  },
};
