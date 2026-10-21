import { useQuery } from '@tanstack/react-query';
import { type AuthConfig, api, type FeatureId, type Me } from '~/api/client';
import { secretsHome } from '~/lib/secrets';

/**
 * Pi Local has one local user: no sign-in, no session. `GET /api/me` names
 * them (the OS user's full name); until it answers, or if it fails, the
 * constant LOCAL_ME stands in, so everything keyed by the user (the inbox
 * store) works from the first render.
 */
export const ME_KEY = ['me'] as const;
export const AUTH_CONFIG_KEY = ['auth-config'] as const;

export const LOCAL_USER_ID = 'local';

export const LOCAL_ME: Me = {
  user: { id: LOCAL_USER_ID, name: '', email: '', role: 'admin' },
  features: {},
};

export const LOCAL_AUTH_CONFIG: AuthConfig = {
  oidcEnabled: false,
  devAuthEnabled: false,
  devAccounts: [],
  instance: {
    name: 'Pi Local',
    logoUrl: null,
    colorTheme: 'neutral',
    defaultTheme: 'system',
    orgName: '',
    supportUrl: null,
  },
};

async function fetchMe(): Promise<Me> {
  const me = await api.get<Me | null>('/api/me');
  // The user's ID stays "local" whatever the server says: the inbox store is keyed by it.
  return me ? { ...me, user: { ...me.user, id: LOCAL_USER_ID } } : LOCAL_ME;
}

export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: fetchMe,
    staleTime: Number.POSITIVE_INFINITY,
    placeholderData: LOCAL_ME,
  });
}

/** The local user: always there. */
export function useCurrentUser(): Me {
  return useMe().data ?? LOCAL_ME;
}

/**
 * Whether an optional feature is on. The platform's (usage, connected usage,
 * message search) are off locally until the backend offers them.
 */
export function useFeature(id: FeatureId): boolean {
  return useCurrentUser().features?.[id] ?? false;
}

/**
 * Where keys and secret values are kept, for copy: "the system keychain", or
 * "memory for this session (development server)" when the server says it keeps
 * them in memory. The keychain until it says otherwise.
 */
export function useSecretsHome(): string {
  return secretsHome(useCurrentUser().features?.secretsInKeychain !== false);
}

/** The instance's name and default look; Pi Local's own until the server answers. */
export function useAuthConfig() {
  return useQuery<AuthConfig>({
    queryKey: AUTH_CONFIG_KEY,
    queryFn: () => api.get<AuthConfig>('/api/auth/config'),
    staleTime: Number.POSITIVE_INFINITY,
    placeholderData: LOCAL_AUTH_CONFIG,
  });
}
