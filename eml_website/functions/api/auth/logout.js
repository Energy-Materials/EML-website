import {
  assertSameOriginMutation,
  clearOAuthCookie,
  clearSessionCookie,
  errorResponse,
  jsonResponse,
} from './session.js';

export async function onRequestPost({ request }) {
  try {
    assertSameOriginMutation(request);
    return jsonResponse(
      { authenticated: false, user: null },
      { cookies: [clearSessionCookie(), clearOAuthCookie()] },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
