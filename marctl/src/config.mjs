import { createTranslator } from './i18n/index.mjs';

import { MarctlError } from './errors.mjs';

export async function loadConfig({ env = process.env, translate = createTranslator(env) } = {}) {
  const serverUrl = nonEmptyString(env.MAR_CTL_SERVER_URL);
  const token = nonEmptyString(env.MAR_CTL_USER_TOKEN);
  if (
    env.MAR_CTL_CONTEXT_REQUIRED !== '1' ||
    serverUrl === undefined ||
    token === undefined ||
    !/^marctl_user_[A-Za-z0-9_-]{43}$/u.test(token)
  )
    throw new MarctlError(translate('errors.userContextUnavailable'), {
      code: 'UNAUTHENTICATED',
      statusCode: 401
    });
  return Object.freeze({ serverUrl: validateServerUrl(serverUrl, translate), key: token });
}

export function validateServerUrl(value, translate = createTranslator()) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new MarctlError(translate('errors.serverUrlInvalid'));
  }

  const isLoopbackHttp =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '::1' ||
      url.hostname === '[::1]');
  if (url.protocol !== 'https:' && !isLoopbackHttp)
    throw new MarctlError(translate('errors.serverUrlTransport'));
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new MarctlError(translate('errors.serverUrlOrigin'));

  return url.origin;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
