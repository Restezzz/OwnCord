import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { connectSocket, disconnectSocket } from '../socket.js';

const AuthContext = createContext(null);

const STORAGE_KEY = 'owncord.auth';

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.token && parsed.user) return parsed;
  } catch {
    /* ignore */
  }
  return null;
}

function writeStored(auth) {
  if (auth) localStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
  else localStorage.removeItem(STORAGE_KEY);
}

export function AuthProvider({ children }) {
  const [auth, setAuth] = useState(() => readStored());
  const [ready, setReady] = useState(false);

  // При монтировании проверяем токен (если есть) через /me
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = readStored();
      if (!stored) {
        setReady(true);
        return;
      }
      try {
        const { user } = await api.me(stored.token);
        if (cancelled) return;
        const next = { token: stored.token, user };
        setAuth(next);
        writeStored(next);
      } catch {
        if (!cancelled) {
          setAuth(null);
          writeStored(null);
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Управляем жизненным циклом сокета
  useEffect(() => {
    if (auth?.token) {
      const sock = connectSocket(auth.token);
      // Сервер присылает `account:deleted`, если аккаунт удалили из
      // другой вкладки или админом. Мгновенно гасим текущую сессию.
      const onDeleted = () => {
        setAuth(null);
        writeStored(null);
        try { disconnectSocket(); } catch { /* */ }
      };
      sock.on?.('account:deleted', onDeleted);
      return () => {
        try { sock.off?.('account:deleted', onDeleted); } catch { /* */ }
      };
    }
    disconnectSocket();
    return undefined;
  }, [auth?.token]);

  const login = useCallback(async (username, password) => {
    const res = await api.login(username, password);
    const next = { token: res.token, user: res.user };
    setAuth(next);
    writeStored(next);
    return next;
  }, []);

  const register = useCallback(async (username, password, invite) => {
    const res = await api.register(username, password, invite);
    const next = { token: res.token, user: res.user };
    setAuth(next);
    writeStored(next);
    return next;
  }, []);

  const logout = useCallback(() => {
    disconnectSocket();
    setAuth(null);
    writeStored(null);
  }, []);

  const updateUser = useCallback((user) => {
    setAuth((prev) => {
      if (!prev) return prev;
      const next = { ...prev, user: { ...prev.user, ...user } };
      writeStored(next);
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ auth, ready, login, register, logout, updateUser }),
    [auth, ready, login, register, logout, updateUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
