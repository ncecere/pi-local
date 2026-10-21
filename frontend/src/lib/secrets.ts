/**
 * Where the app keeps keys and secret values: the system keychain, or, in a
 * development server started with `-secrets memory`, memory until that server
 * stops (`GET /api/me` says which: `features.secretsInKeychain`). Copy that
 * says where a secret is kept names the place with this, never "the keychain"
 * alone.
 */
export const SECRETS_IN_KEYCHAIN = 'the system keychain';
export const SECRETS_IN_MEMORY = 'memory until this server stops';

export const secretsHome = (inKeychain: boolean): string =>
  inKeychain ? SECRETS_IN_KEYCHAIN : SECRETS_IN_MEMORY;

/**
 * "kept in the system keychain" or "kept only until this server stops": for a
 * sentence such as "The key is {kept}." or "Keys are {kept}."
 */
export const secretsKept = (inKeychain: boolean): string =>
  inKeychain ? `kept in ${SECRETS_IN_KEYCHAIN}` : 'kept only until this server stops';
