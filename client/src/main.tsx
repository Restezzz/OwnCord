import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';
import { SettingsProvider } from './context/SettingsContext';
import { MutesProvider } from './context/MutesContext';
import { ConfigProvider } from './context/ConfigContext';
import { GroupsProvider } from './context/GroupsContext';
import UpdateToast from './components/UpdateToast';
import { attachNotificationClickHandler } from './utils/push';
import './index.css';

// Слушать клики по push-уведомлениям и эмитить кастомное событие, на
// которое подписан Home.jsx (для открытия нужного чата).
attachNotificationClickHandler();

// Регистрируем service worker сразу при загрузке (не лениво) — это нужно,
// чтобы Chrome/Edge показывали «Install app» баннер и работал A2HS на iOS.
// Существующая ленивая регистрация в utils/push.ts остаётся как fallback —
// register() идемпотентен, вернёт ту же registration.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch(() => {
        /* silently ignore — на http (dev без proxy) SW недоступен */
      });
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <ConfigProvider>
          <SettingsProvider>
            <AuthProvider>
              <MutesProvider>
                <GroupsProvider>
                  <App />
                  <UpdateToast />
                </GroupsProvider>
              </MutesProvider>
            </AuthProvider>
          </SettingsProvider>
        </ConfigProvider>
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
