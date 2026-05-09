// Главный компонент окна настроек: модалка со списком табов слева и
// контентом справа. Сами табы лежат в собственных файлах
// (см. ./ProfileTab, ./PasswordTab, …) — этот файл только роутит между
// ними и решает, какие пункты вообще показывать (admin/desktop only).

import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  Bell,
  Download,
  Headphones,
  KeyRound,
  Keyboard,
  Lock,
  RefreshCw,
  ShieldCheck,
  User,
  X,
} from 'lucide-react';
import { modalVariants, overlayVariants, reducedVariants } from '../../utils/motion';
import { useAuth } from '../../context/AuthContext';
import {
  isDesktop,
  getDesktopVersion,
  checkForUpdates,
  installUpdate,
  onUpdateEvent,
  type UpdateEvent,
} from '../../utils/desktop';
import { ProfileTab } from './ProfileTab';
import { PasswordTab } from './PasswordTab';
import { AudioTab } from './AudioTab';
import { NotificationsTab } from './NotificationsTab';
import { KeybindsTab } from './KeybindsTab';
import { PrivacyTab } from './PrivacyTab';
import { InvitesTab } from './InvitesTab';

// adminOnly — видна только админам; desktopOnly — только в Electron-обёртке.
// Логика фильтрации в render'е панели (см. TABS).
const ALL_TABS = [
  { id: 'profile', label: 'Профиль', icon: User },
  { id: 'password', label: 'Пароль', icon: Lock },
  { id: 'audio', label: 'Звук', icon: Headphones },
  { id: 'notifications', label: 'Уведомления', icon: Bell },
  { id: 'keybinds', label: 'Горячие клавиши', icon: Keyboard, desktopOnly: true },
  { id: 'privacy', label: 'Приватность', icon: ShieldCheck },
  { id: 'invites', label: 'Приглашения', icon: KeyRound, adminOnly: true },
];

export default function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { auth } = useAuth();
  const isAdmin = !!auth?.user?.isAdmin;
  const desktop = isDesktop();
  const TABS = ALL_TABS.filter((t) => {
    if (t.adminOnly && !isAdmin) return false;
    if (t.desktopOnly && !desktop) return false;
    return true;
  });
  const [tab, setTab] = useState('profile');
  // Версия десктоп-приложения (null на вебе) — показываем мелким шрифтом
  // в подвале сайдбара. На веб-версии футер с версией не рендерим вовсе.
  const [desktopVersion, setDesktopVersion] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void getDesktopVersion().then((v) => {
      if (alive) setDesktopVersion(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Локальное состояние ручной проверки обновлений (только в десктопе).
  // updateState отражает последнее событие из onUpdateEvent — этого
  // достаточно для inline-фидбэка в подвале сайдбара. Полный UI прогресса
  // и кнопка перезапуска живут в UpdateToast, чтобы не дублировать логику.
  const [updateState, setUpdateState] = useState<UpdateEvent | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (!desktop) return;
    return onUpdateEvent((ev) => {
      setUpdateState(ev);
      // 'checking' приходит от main и снаружи (фоновая периодическая
      // проверка). Сбросим локальный флаг только на терминальных
      // состояниях, чтобы кнопка не разблокировалась раньше времени.
      if (ev.kind !== 'checking') setChecking(false);
    });
  }, [desktop]);

  const updateInFlight =
    checking ||
    updateState?.kind === 'checking' ||
    updateState?.kind === 'available' ||
    updateState?.kind === 'progress';
  const updateReady = updateState?.kind === 'downloaded';

  const onUpdateButton = useCallback(async () => {
    if (updateReady) {
      void installUpdate();
      return;
    }
    if (updateInFlight) return;
    setChecking(true);
    setUpdateState({ kind: 'checking' });
    const res = await checkForUpdates();
    if (!res) {
      // Не в десктопе либо preload без хендлера — просто откатываем.
      setChecking(false);
      setUpdateState(null);
      return;
    }
    if (!res.ok) {
      setChecking(false);
      setUpdateState({ kind: 'error', message: res.error || 'Не удалось проверить' });
    }
    // При ok=true финальный стейт ('available'/'none'/'downloaded'/'error')
    // придёт через onUpdateEvent — там и обновим UI.
  }, [updateReady, updateInFlight]);

  const updateStatusText = (() => {
    if (!updateState) return null;
    switch (updateState.kind) {
      case 'checking':
        return 'Проверяю…';
      case 'available':
        return updateState.version
          ? `Доступна ${updateState.version}, скачиваю…`
          : 'Доступно обновление, скачиваю…';
      case 'progress':
        return `Загрузка ${Math.max(0, Math.min(100, Math.round(updateState.percent)))}%`;
      case 'downloaded':
        return updateState.version
          ? `Готово к установке (${updateState.version})`
          : 'Готово к установке';
      case 'none':
        return 'Установлена последняя версия';
      case 'error':
        return `Ошибка: ${updateState.message}`;
      default:
        return null;
    }
  })();
  const reduce = useReducedMotion();
  const overlayV = reduce ? reducedVariants(overlayVariants) : overlayVariants;
  const panelV = reduce ? reducedVariants(modalVariants) : modalVariants;
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="settings"
          className="fixed inset-0 z-[55] bg-black/60 backdrop-blur-sm grid place-items-center p-4"
          onClick={onClose}
          variants={overlayV}
          initial="initial"
          animate="animate"
          exit="exit"
        >
          <motion.div
            className="card w-full max-w-3xl h-[min(640px,90vh)] overflow-hidden flex flex-col md:flex-row"
            onClick={(e) => e.stopPropagation()}
            variants={panelV}
          >
            {/* Sidebar */}
            <aside className="md:w-56 shrink-0 bg-bg-2 md:border-r border-b md:border-b-0 border-border p-3 flex md:flex-col gap-1 overflow-x-auto md:overflow-x-visible">
              <div className="hidden md:block text-xs uppercase tracking-wider text-slate-500 px-2 mb-2">
                Настройки
              </div>
              {TABS.map((t) => {
                const Icon = t.icon;
                const active = tab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    type="button"
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm whitespace-nowrap transition-colors
                  ${active ? 'bg-accent text-white' : 'text-slate-200 hover:bg-bg-3'}`}
                  >
                    <Icon size={16} />
                    <span>{t.label}</span>
                  </button>
                );
              })}
              {/* Подвал сайдбара — только в Electron'е, прибит к низу.
                  Содержит: версию приложения, кнопку ручной проверки
                  обновлений и короткий статус. На вебе/мобильном горизонтальном
                  скролле скрыт через hidden md:flex. */}
              {desktop && (
                <div className="hidden md:flex mt-auto pt-3 px-2 flex-col gap-1.5">
                  {desktopVersion && (
                    <div className="text-[10px] text-slate-500 select-text">
                      OwnCord {desktopVersion}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={onUpdateButton}
                    disabled={updateInFlight && !updateReady}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] transition-colors ${
                      updateReady
                        ? 'bg-accent text-white hover:bg-accent-hover'
                        : 'bg-bg-3 text-slate-200 hover:bg-bg-3/70'
                    } disabled:opacity-60 disabled:cursor-not-allowed`}
                    title={
                      updateReady
                        ? 'Перезапустить и применить обновление'
                        : 'Проверить наличие обновлений сейчас'
                    }
                  >
                    {updateReady ? (
                      <Download size={12} className="flex-shrink-0" />
                    ) : (
                      <RefreshCw
                        size={12}
                        className={`flex-shrink-0 ${updateInFlight ? 'animate-spin' : ''}`}
                      />
                    )}
                    <span>
                      {updateReady ? 'Перезапустить и обновить' : 'Проверить обновления'}
                    </span>
                  </button>
                  {updateStatusText && (
                    <div
                      className={`text-[10px] leading-snug break-words ${
                        updateState?.kind === 'error'
                          ? 'text-danger'
                          : updateState?.kind === 'downloaded'
                            ? 'text-success'
                            : 'text-slate-500'
                      }`}
                    >
                      {updateStatusText}
                    </div>
                  )}
                </div>
              )}
            </aside>

            {/* Content */}
            <div className="flex-1 min-w-0 flex flex-col">
              <div className="flex items-center justify-between px-5 py-3 border-b border-border">
                <div className="text-base font-semibold">
                  {TABS.find((t) => t.id === tab)?.label}
                </div>
                <button className="btn-ghost" onClick={onClose} title="Закрыть">
                  <X size={18} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-5">
                {tab === 'profile' && <ProfileTab />}
                {tab === 'password' && <PasswordTab />}
                {tab === 'audio' && <AudioTab />}
                {tab === 'notifications' && <NotificationsTab />}
                {tab === 'keybinds' && desktop && <KeybindsTab />}
                {tab === 'privacy' && <PrivacyTab />}
                {tab === 'invites' && isAdmin && <InvitesTab />}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
