export const oauthErrorsEnUS: Readonly<Record<string, string>> = {
  OAUTH_PROVIDER_INVALID: 'The OAuth identity provider is invalid.',
  OAUTH_CALLBACK_INVALID: 'OAuth authorization was not completed or was cancelled. Try again.',
  OAUTH_STATE_INVALID: 'OAuth authorization has expired or is invalid. Start it again.',
  OAUTH_BINDING_USER_MISMATCH:
    'The signed-in account differs from the account that started binding. Start again.',
  OAUTH_ACCOUNT_BINDING_FROZEN:
    'The enterprise license is frozen, so OAuth identities cannot be bound.',
  OAUTH_IDENTITY_ALREADY_BOUND:
    'This OAuth identity is bound to another account. Sign in with that account or contact an administrator.',
  OAUTH_PROVIDER_ALREADY_BOUND: 'This account is already bound to this OAuth identity provider.',
  OAUTH_ACCOUNT_NOT_BOUND:
    'This OAuth identity is not bound to an account. Use password sign-in or contact an administrator.',
  OAUTH_EMAIL_AMBIGUOUS: 'The OAuth email matches multiple accounts. Contact an administrator.',
  OAUTH_TOKEN_EXCHANGE_FAILED:
    'OAuth authorization verification failed. Try again or contact an administrator.',
  OAUTH_ACCESS_TOKEN_INVALID: 'The OAuth access token is invalid. Try again.',
  OAUTH_USERINFO_FAILED: 'OAuth account information could not be loaded. Try again later.',
  OAUTH_EXTERNAL_USER_ID_INVALID:
    'The OAuth account information is invalid. Ask an administrator to check the configuration.',
  OAUTH_PROVIDER_NOT_FOUND: 'The OAuth identity provider does not exist or is disabled.',
  OAUTH_BINDING_NOT_FOUND: 'This account is not bound to this OAuth identity provider.',
  OAUTH_CLIENT_SECRET_REQUIRED: 'OAuth Client Secret is required.',
  OAUTH_PROVIDER_KEY_IMMUTABLE: 'The OAuth identity provider key cannot be changed after creation.',
  OAUTH_AUTHORIZATION_ENDPOINT_UNAVAILABLE:
    'The OAuth authorization endpoint is unavailable. Ask an administrator to check the configuration.',
  OAUTH_TOKEN_ENDPOINT_INVALID:
    'The OAuth Token endpoint returned an invalid result. Ask an administrator to check the configuration.',
  OAUTH_USERINFO_ENDPOINT_INVALID:
    'The OAuth UserInfo endpoint returned an invalid result. Ask an administrator to check the configuration.',
  OAUTH_PROVIDER_TEST_REQUIRED: 'Test the OAuth configuration successfully before enabling it.',
  OAUTH_PROVIDER_CONFIGURATION_INVALID:
    'The OAuth configuration is invalid. Check it and try again.',
  OAUTH_HTTPS_REQUIRED: 'OAuth service URLs must use HTTPS.',
  OAUTH_RESPONSE_TOO_LARGE:
    'The OAuth service response is too large. Ask an administrator to check the configuration.',
  OAUTH_RESPONSE_INVALID:
    'The OAuth service response is invalid. Ask an administrator to check the configuration.',
  OAUTH_USERNAME_EXHAUSTED:
    'A local username could not be created for this OAuth account. Contact an administrator.',
  UNAUTHENTICATED: 'Your sign-in session has expired. Sign in again.',
  PASSWORD_CHANGE_REQUIRED: 'Change your password before binding an OAuth identity.'
};
