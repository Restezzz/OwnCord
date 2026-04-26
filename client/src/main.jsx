import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import { ToastProvider } from './context/ToastContext.jsx';
import { SettingsProvider } from './context/SettingsContext.jsx';
import { MutesProvider } from './context/MutesContext.jsx';
import { ConfigProvider } from './context/ConfigContext.jsx';
import { GroupsProvider } from './context/GroupsContext.jsx';
import { attachNotificationClickHandler } from './utils/push.js';
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
                </GroupsProvider>
              </MutesProvider>
            </AuthProvider>
          </SettingsProvider>
        </ConfigProvider>
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
