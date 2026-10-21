/**
 * Where the app keeps keys and secret values: the system keychain, or, in a
 * development server started with `-secrets memory`, memory for the session
 * (`GET /api/me` says which: `features.secretsInKeychain`). Copy that says
 * where a secret is kept names the place with this, never "the keychain" alone.
 */
export const SECRETS_IN_KEYCHAIN = 'the system keychain';
export const SECRETS_IN_MEMORY = 'memory for this session (development server)';

export const secretsHome = (inKeychain: boolean): string =>
  inKeychain ? SECRETS_IN_KEYCHAIN : SECRETS_IN_MEMORY;
