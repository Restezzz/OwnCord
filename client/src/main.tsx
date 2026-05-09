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
