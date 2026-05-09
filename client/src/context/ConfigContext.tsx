import { createContext, useContext, useEffect, useState } from 'react';
import { api } from '../api';

const DEFAULTS = {
  // Дефолт на случай, если сервер не ответил:
  // 500 МБ — совпадает с дефолтом сервера.
  maxUploadBytes: 500 * 1024 * 1024,
};

const ConfigContext = createContext(DEFAULTS);

export function ConfigProvider({ children }) {
  const [cfg, setCfg] = useState(DEFAULTS);

  useEffect(() => {
    let cancelled = false;
    api
      .config()
      .then((r) => {
        if (cancelled || !r) return;
        setCfg({ ...DEFAULTS, ...r });
      })
      .catch(() => {
        /* используем дефолты */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return <ConfigContext.Provider value={cfg}>{children}</ConfigContext.Provider>;
}

export function useConfig() {
  return useContext(ConfigContext);
}
