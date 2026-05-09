// Главный компонент окна настроек: модалка со списком табов слева и
// контентом справа. Сами табы лежат в собственных файлах
// (см. ./ProfileTab, ./PasswordTab, …) — этот файл только роутит между
// ними и решает, какие пункты вообще показывать (admin/desktop only).

import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Bell, Headphones, KeyRound, Keyboard, Lock, ShieldCheck, User, X } from 'lucide-react';
import { modalVariants, overlayVariants, reducedVariants } from '../../utils/motion';
import { useAuth } from '../../context/AuthContext';
import { isDesktop, getDesktopVersion } from '../../utils/desktop';
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
              {/* Версия десктоп-приложения — только в Electron'е, прибита
                  к низу сайдбара. На вебе — пусто (на горизонтальном скролле
                  тоже скроется через hidden md:block). */}
              {desktopVersion && (
                <div className="hidden md:block mt-auto pt-3 px-2 text-[10px] text-slate-500 select-text">
                  OwnCord {desktopVersion}
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
