import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, type Me } from '../api/client';

interface AuthState {
  me: Me | null;
  loading: boolean;
  error: string | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Product ids this user may act on. Empty only if genuinely unscoped. */
  tenantName: (productId: string | null) => string | null;
  tenantColor: (productId: string | null) => string | undefined;
  can: (...roles: Me['role'][]) => boolean;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The session is an httpOnly cookie, so on load we ask the server who we
  // are rather than reading a token — the page has no way to read it.
  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setLoading(false));
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      me,
      loading,
      error,
      async signIn(email, password) {
        setError(null);
        try {
          await api.login(email, password);
          setMe(await api.me());
        } catch (err) {
          setError(
            err instanceof ApiError
              ? err.message
              : 'Could not sign in. Please try again.',
          );
          throw err;
        }
      },
      async signOut() {
        await api.logout().catch(() => undefined);
        setMe(null);
      },
      tenantName: (productId) =>
        productId ? (me?.tenants.find((t) => t.id === productId)?.name ?? null) : null,
      tenantColor: (productId) =>
        productId ? me?.tenants.find((t) => t.id === productId)?.primary_color : undefined,
      can: (...roles) => Boolean(me && roles.includes(me.role)),
    }),
    [me, loading, error],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
