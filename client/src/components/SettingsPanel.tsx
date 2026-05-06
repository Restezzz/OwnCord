import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  Mic, Volume2, X, Bell, BellOff, Upload, Trash2, User, ShieldCheck, Headphones, Play,
  KeyRound, Copy, Check, RefreshCw, Smartphone, UserX, AlertTriangle, Lock,
  Download, ExternalLink, Sliders, Video, MonitorUp, Activity, ChevronDown, ChevronRight,
} from 'lucide-react';
import { createMicPipeline, pickAudioFilterSettings } from '../utils/audioProcessing';
import { modalVariants, overlayVariants, reducedVariants } from '../utils/motion';
import {
  pushSupported, getPushStatus, enablePush, disablePush,
} from '../utils/push';
import { useSettings } from '../context/SettingsContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useSounds } from '../hooks/useSounds';
import Avatar from './Avatar';
import PasswordInput from './PasswordInput';
import { api } from '../api';
import { getAvatarUrl, getDisplayName } from '../utils/user';

const ALL_TABS = [
  { id: 'profile', label: 'Профиль', icon: User },
  { id: 'password', label: 'Пароль', icon: Lock },
  { id: 'audio', label: 'Звук', icon: Headphones },
  { id: 'notifications', label: 'Уведомления', icon: Bell },
  { id: 'privacy', label: 'Приватность', icon: ShieldCheck },
  { id: 'invites', label: 'Приглашения', icon: KeyRound, adminOnly: true },
];

export default function SettingsPanel({ open, onClose }) {
  const { auth } = useAuth();
  const isAdmin = !!auth?.user?.isAdmin;
  const TABS = ALL_TABS.filter((t) => !t.adminOnly || isAdmin);
  const [tab, setTab] = useState('profile');
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

// ---------------- Profile ---------------------------------------------------

function ProfileTab() {
  const { auth, updateUser, logout } = useAuth();
  const toast = useToast();
  const user = auth?.user;
  const [displayDraft, setDisplayDraft] = useState(getDisplayName(user));
  const [savingName, setSavingName] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const fileRef = useRef(null);

  const avatarUrl = getAvatarUrl(user);
  const currentName = getDisplayName(user);
  const nameDirty = (displayDraft || '').trim() !== currentName;

  useEffect(() => {
    setDisplayDraft(getDisplayName(user));
  }, [user]);

  const saveName = async () => {
    const next = (displayDraft || '').trim();
    if (!next) {
      toast.error('Ник не может быть пустым');
      return;
    }
    setSavingName(true);
    try {
      const { user: u } = await api.updateMe(auth.token, { displayName: next });
      updateUser(u);
      toast.success('Ник обновлён');
    } catch (e) {
      toast.error(e.message || 'Не удалось обновить ник');
    } finally {
      setSavingName(false);
    }
  };

  const resetName = async () => {
    setSavingName(true);
    try {
      const { user: u } = await api.updateMe(auth.token, { displayName: null });
      updateUser(u);
      setDisplayDraft(u.displayName || u.username);
      toast.info('Ник сброшен к логину');
    } catch (e) {
      toast.error(e.message || 'Не удалось сбросить ник');
    } finally {
      setSavingName(false);
    }
  };

  const onPickAvatar = () => fileRef.current?.click();

  const onAvatarChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) {
      toast.error('Файл больше 3 МБ');
      return;
    }
    if (!/^image\//.test(file.type)) {
      toast.error('Нужна картинка');
      return;
    }
    setUploadingAvatar(true);
    try {
      const { user: u } = await api.uploadAvatar(auth.token, file);
      updateUser(u);
      toast.success('Аватарка обновлена');
    } catch (err) {
      toast.error(err.message || 'Не удалось загрузить');
    } finally {
      setUploadingAvatar(false);
    }
  };

  const removeAvatar = async () => {
    if (!avatarUrl) return;
    setUploadingAvatar(true);
    try {
      const { user: u } = await api.deleteAvatar(auth.token);
      updateUser(u);
      toast.info('Аватарка удалена');
    } catch (err) {
      toast.error(err.message || 'Не удалось удалить');
    } finally {
      setUploadingAvatar(false);
    }
  };

  return (
    <section className="space-y-5">
      <div className="flex items-center gap-4">
        <Avatar name={currentName} src={avatarUrl} size={80} />
        <div className="flex flex-col gap-1.5">
          <button
            className="btn-primary text-sm h-8 px-3"
            onClick={onPickAvatar}
            disabled={uploadingAvatar}
            type="button"
          >
            <Upload size={14} className="mr-1" />
            {uploadingAvatar ? 'Загрузка…' : 'Загрузить фото'}
          </button>
          {avatarUrl && (
            <button
              className="text-xs text-slate-400 hover:text-red-400 flex items-center gap-1"
              onClick={removeAvatar}
              disabled={uploadingAvatar}
              type="button"
            >
              <Trash2 size={12} /> Удалить
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={onAvatarChange}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs text-slate-400 uppercase tracking-wider">
          Отображаемое имя (ник)
        </label>
        <div className="flex gap-2">
          <input
            className="input"
            value={displayDraft}
            onChange={(e) => setDisplayDraft(e.target.value)}
            maxLength={32}
            placeholder={user?.username}
          />
          <button
            onClick={saveName}
            disabled={!nameDirty || savingName}
            className="btn-primary h-10 px-4 shrink-0"
            type="button"
          >
            {savingName ? '…' : 'Сохранить'}
          </button>
        </div>
        <div className="text-[11px] text-slate-500 flex items-center justify-between">
          <span>Логин: <span className="text-slate-300">@{user?.username}</span></span>
          {currentName !== user?.username && (
            <button
              onClick={resetName}
              className="hover:text-slate-200"
              type="button"
            >
              сбросить к логину
            </button>
          )}
        </div>
      </div>

      {/* Опасная зона: удаление аккаунта. */}
      <div className="h-px bg-border" />
      <div className="space-y-2">
        <div className="text-xs text-red-400 uppercase tracking-wider flex items-center gap-1.5">
          <AlertTriangle size={12} /> Опасная зона
        </div>
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 space-y-2">
          <div className="text-sm font-medium">Удалить аккаунт</div>
          <p className="text-xs text-slate-400">
            Логин будет заблокирован, аватар и ник стёрты. Сообщения, которые
            ты отправлял, останутся в истории у собеседников, но твоё имя в
            них будет заменено на «Удалённый пользователь». Это действие
            необратимо.
          </p>
          <button
            type="button"
            className="h-9 px-3 rounded-lg bg-red-500/15 hover:bg-red-500/25 border border-red-500/30 text-red-300 text-sm inline-flex items-center gap-2"
            onClick={() => setDeleteOpen(true)}
          >
            <UserX size={14} /> Удалить аккаунт…
          </button>
        </div>
      </div>

      <DeleteAccountModal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        token={auth?.token}
        onDeleted={() => {
          toast.info('Аккаунт удалён');
          setDeleteOpen(false);
          logout();
        }}
      />
    </section>
  );
}

function DeleteAccountModal({ open, onClose, token, onDeleted }) {
  const toast = useToast();
  const reduce = useReducedMotion();
  const overlayV = reduce ? reducedVariants(overlayVariants) : overlayVariants;
  const panelV = reduce ? reducedVariants(modalVariants) : modalVariants;
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setPassword('');
      setConfirm('');
      setBusy(false);
    }
  }, [open]);

  const canSubmit = password.length > 0 && confirm.trim().toUpperCase() === 'УДАЛИТЬ' && !busy;

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      await api.deleteMe(token, password);
      onDeleted?.();
    } catch (err) {
      toast.error(err?.message || 'Не удалось удалить аккаунт');
      setBusy(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="delete-account"
          className="fixed inset-0 z-[60] grid place-items-center bg-black/60 backdrop-blur-sm p-4"
          onClick={onClose}
          variants={overlayV}
          initial="initial"
          animate="animate"
          exit="exit"
        >
          <motion.form
            className="card w-full max-w-md p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
            onSubmit={onSubmit}
            variants={panelV}
          >
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-red-500/15 grid place-items-center text-red-400 shrink-0">
            <AlertTriangle size={20} />
          </div>
          <div>
            <div className="text-base font-semibold">Удалить аккаунт навсегда?</div>
            <div className="text-xs text-slate-400 mt-0.5">
              Восстановить будет невозможно.
            </div>
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-slate-400">Текущий пароль</label>
          <input
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-slate-400">
            Чтобы подтвердить, напиши <span className="text-red-300 font-mono">УДАЛИТЬ</span>
          </label>
          <input
            className="input"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="УДАЛИТЬ"
            autoComplete="off"
            required
          />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            className="btn-ghost h-9 px-3"
            onClick={onClose}
            disabled={busy}
          >
            Отмена
          </button>
          <button
            type="submit"
            className="h-9 px-4 rounded-lg bg-red-500/80 hover:bg-red-500 text-white text-sm inline-flex items-center gap-2 disabled:opacity-50"
            disabled={!canSubmit}
          >
            <UserX size={14} />
            {busy ? 'Удаление…' : 'Удалить навсегда'}
          </button>
        </div>
          </motion.form>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------------- Password --------------------------------------------------

function PasswordTab() {
  const { auth } = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  // Простая валидация формы — всё на клиенте, чтобы кнопка disabled'илась
  // и пользователь видел очевидные ошибки до запроса. На сервере те же
  // проверки повторяются (POST /api/me/password).
  const tooShort = next.length > 0 && next.length < 6;
  const mismatch = confirm.length > 0 && confirm !== next;
  const sameAsCurrent = next.length > 0 && next === current;

  const canSubmit = current.length > 0
    && next.length >= 6
    && confirm === next
    && next !== current
    && !busy;

  const reset = () => {
    setCurrent('');
    setNext('');
    setConfirm('');
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      await api.changePassword(auth.token, current, next);
      toast.success('Пароль обновлён');
      reset();
    } catch (err) {
      const msg = err?.message;
      if (err?.status === 403) {
        toast.error('Текущий пароль введён неверно');
      } else {
        toast.error(msg || 'Не удалось сменить пароль');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-5 max-w-md">
      <p className="text-xs text-slate-400">
        После смены пароля уже выпущенные токены остаются действительными
        до своего срока (14 дней) — но злоумышленник без нового пароля
        не сможет войти заново.
      </p>

      <div className="space-y-1.5">
        <label className="text-xs text-slate-400 uppercase tracking-wider">
          Старый пароль
        </label>
        <PasswordInput
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
          required
          name="current-password"
          ariaLabel="Текущий пароль"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs text-slate-400 uppercase tracking-wider">
          Новый пароль
        </label>
        <PasswordInput
          value={next}
          onChange={(e) => setNext(e.target.value)}
          autoComplete="new-password"
          minLength={6}
          required
          name="new-password"
          ariaLabel="Новый пароль"
        />
        {tooShort && (
          <div className="text-[11px] text-amber-400">Минимум 6 символов</div>
        )}
        {sameAsCurrent && !tooShort && (
          <div className="text-[11px] text-amber-400">Должен отличаться от старого</div>
        )}
      </div>

      <div className="space-y-1.5">
        <label className="text-xs text-slate-400 uppercase tracking-wider">
          Повторить пароль
        </label>
        <PasswordInput
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
          name="new-password-confirm"
          ariaLabel="Подтверждение нового пароля"
        />
        {mismatch && (
          <div className="text-[11px] text-amber-400">Пароли не совпадают</div>
        )}
      </div>

      <div className="flex justify-end pt-1">
        <button
          type="submit"
          disabled={!canSubmit}
          className="btn-primary h-10 px-4 disabled:opacity-50"
        >
          {busy ? 'Сохранение…' : 'Сменить пароль'}
        </button>
      </div>
    </form>
  );
}

// ---------------- Audio -----------------------------------------------------

const PERMISSION_TEXT = {
  granted: 'Разрешено',
  denied: 'Запрещено',
  prompt: 'Нужно разрешение',
  unknown: 'Неизвестно',
};

function permissionClass(status) {
  if (status === 'granted') return 'text-emerald-400';
  if (status === 'denied') return 'text-red-400';
  return 'text-amber-300';
}

async function queryPermission(name) {
  if (!navigator.permissions?.query) return 'unknown';
  try {
    const result = await navigator.permissions.query({ name: name as PermissionName });
    return result.state || 'unknown';
  } catch {
    return 'unknown';
  }
}

function stopMediaStream(stream) {
  stream?.getTracks?.().forEach((track) => {
    try { track.stop(); } catch { /* ignore */ }
  });
}

function AudioTab() {
  const { settings, update } = useSettings();
  const toast = useToast();
  const [devices, setDevices] = useState({ input: [], output: [] });
  const [permissions, setPermissions] = useState({
    microphone: 'unknown',
    camera: 'unknown',
    screen: 'prompt',
  });
  const [permissionBusy, setPermissionBusy] = useState(null);
  const [permissionError, setPermissionError] = useState('');
  const [deviceRefreshKey, setDeviceRefreshKey] = useState(0);
  // micLevel.db — RMS уровень после всей цепочки фильтров (то, что услышит пир).
  // gateOpen — true когда noise gate сейчас пропускает звук (для индикатора).
  const [micLevel, setMicLevel] = useState({ percent: 0, db: -100, gateOpen: false });
  const [isTestingMic, setIsTestingMic] = useState(false);
  const [isTestingSpeaker, setIsTestingSpeaker] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Pipeline проживает на время теста микрофона. Тут лежат и AudioContext,
  // и MediaStream'ы — pipeline.destroy() сам всё закроет.
  const pipelineRef = useRef(null);
  // Невидимый <audio> для loopback'а: подключаем к outputStream pipeline'а,
  // чтобы юзер слышал ровно то, что услышит собеседник. Echo-cancellation
  // при getUserMedia'е сглаживает риск обратной связи.
  const loopbackAudioRef = useRef(null);
  const testAudioRef = useRef(null);

  const canPickOutput = typeof HTMLAudioElement !== 'undefined'
    && 'setSinkId' in HTMLAudioElement.prototype;

  const refreshPermissions = async () => {
    const [microphone, camera] = await Promise.all([
      queryPermission('microphone'),
      queryPermission('camera'),
    ]);
    setPermissions({
      microphone,
      camera,
      screen: 'prompt',
    });
  };

  useEffect(() => {
    refreshPermissions();
  }, []);

  const requestPermission = async (kind) => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices) {
      setPermissionError('Браузер не поддерживает доступ к медиаустройствам.');
      return;
    }
    if (kind !== 'screen' && !mediaDevices.getUserMedia) {
      setPermissionError('Браузер не поддерживает доступ к микрофону и камере.');
      return;
    }
    setPermissionBusy(kind);
    setPermissionError('');
    let stream = null;
    try {
      if (kind === 'microphone') {
        stream = await mediaDevices.getUserMedia({ audio: true });
        toast.success('Доступ к микрофону разрешён');
      } else if (kind === 'camera') {
        stream = await mediaDevices.getUserMedia({ video: true });
        toast.success('Доступ к камере разрешён');
      } else if (kind === 'media') {
        stream = await mediaDevices.getUserMedia({ audio: true, video: true });
        toast.success('Доступ к микрофону и камере разрешён');
      } else if (kind === 'screen') {
        if (!mediaDevices.getDisplayMedia) {
          throw new Error('Браузер не поддерживает демонстрацию экрана.');
        }
        stream = await mediaDevices.getDisplayMedia({ video: true, audio: true });
        toast.success('Доступ к демонстрации экрана проверен');
      }
      stopMediaStream(stream);
      await refreshPermissions();
      setDeviceRefreshKey((n) => n + 1);
    } catch (err) {
      stopMediaStream(stream);
      const denied = err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError';
      setPermissionError(
        denied
          ? 'Разрешение отклонено. Если браузер запомнил отказ, включите доступ в настройках сайта.'
          : err?.message || 'Не удалось запросить разрешение.',
      );
      await refreshPermissions();
    } finally {
      setPermissionBusy(null);
    }
  };

  // Визуализация уровня микрофона. Читаем pipeline.analyser, который стоит
  // в самом конце цепочки — то есть видим именно то, что услышит пир.
  // gateOpen вытягиваем из gateGain.gain.value: если ворота закрыты, индикатор
  // погаснет (так юзер на глаз видит, как порог режет паузы).
  useEffect(() => {
    if (!isTestingMic) return undefined;
    const pipeline = pipelineRef.current;
    if (!pipeline) return undefined;
    let raf = 0;
    let cancelled = false;
    const buf = new Float32Array(pipeline.analyser.fftSize);
    const tick = () => {
      if (cancelled) return;
      try {
        pipeline.analyser.getFloatTimeDomainData(buf as any);
        let sum = 0;
        for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const db = rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
        const percent = Math.min(100, Math.max(0, ((db + 60) / 60) * 100));
        // Грубо «ворота открыты» — если RMS заметно выше порога. Только UI.
        const threshold = settings.noiseThreshold ?? -55;
        const gateOpen = db >= threshold;
        setMicLevel({ percent, db: Math.round(db), gateOpen });
      } catch { /* */ }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [isTestingMic, settings.noiseThreshold]);

  // Очистка при размонтировании панели — на случай, если юзер закрыл
  // настройки, не остановив тест явно.
  useEffect(() => {
    return () => {
      if (pipelineRef.current) {
        try { pipelineRef.current.destroy(); } catch { /* */ }
        pipelineRef.current = null;
      }
      if (loopbackAudioRef.current) {
        try { loopbackAudioRef.current.pause(); } catch { /* */ }
        try { loopbackAudioRef.current.srcObject = null; } catch { /* */ }
        loopbackAudioRef.current = null;
      }
    };
  }, []);

  // Прокидывает новые настройки в живой pipeline во время теста.
  // Пользователь крутит ползунки — слышит результат сразу, без рестарта.
  useEffect(() => {
    if (!isTestingMic) return;
    const pipeline = pipelineRef.current;
    if (!pipeline) return;
    try {
      pipeline.updateSettings(pickAudioFilterSettings(settings));
    } catch { /* */ }
  }, [
    isTestingMic,
    settings.inputVolume,
    settings.noiseSuppression,
    settings.noiseThreshold,
    settings.noiseGateHoldMs,
    settings.noiseGateAttackMs,
    settings.noiseGateReleaseMs,
    settings.highPassFilter,
    settings.highPassFrequency,
    settings.compressorEnabled,
    settings.compressorThreshold,
    settings.compressorRatio,
    settings.compressorAttack,
    settings.compressorRelease,
    settings.compressorKnee,
    settings.makeupGainDb,
  ]);

  const startMicTest = async () => {
    try {
      const audioConstraints: any = {
        deviceId: settings.inputDeviceId && settings.inputDeviceId !== 'default'
          ? { exact: settings.inputDeviceId }
          : undefined,
        echoCancellation: true,
        // noiseSuppression на уровне браузера всегда включаем — наш gate
        // работает ПОВЕРХ него, отрезая то, что NS не догасил.
        noiseSuppression: true,
        autoGainControl: true,
      };
      const rawStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
      });
      // Тот же createMicPipeline, что в реальном звонке (см. useCall/useGroupCall).
      // Это гарантирует: что юзер слышит в тесте — то и услышит собеседник.
      const pipeline = await createMicPipeline(rawStream, pickAudioFilterSettings(settings));
      pipelineRef.current = pipeline;

      // Loopback: HTMLAudioElement с outputStream pipeline'а. По умолчанию
      // звук пойдёт в выбранное юзером устройство вывода (см. setSinkId).
      const audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      (audioEl as any).playsInline = true;
      audioEl.srcObject = pipeline.outputStream;
      // Делаем тише, чтобы не вызвать обратную связь с открытыми колонками.
      audioEl.volume = 0.6;
      if (canPickOutput && settings.outputDeviceId && settings.outputDeviceId !== 'default') {
        try { await (audioEl as any).setSinkId?.(settings.outputDeviceId); } catch { /* */ }
      }
      try { await audioEl.play(); } catch { /* autoplay-policy: контекст всё равно живой */ }
      loopbackAudioRef.current = audioEl;

      setIsTestingMic(true);
    } catch (err) {
      console.error('Mic test error:', err);
      toast.error?.('Не удалось начать тест микрофона. Проверьте разрешения.');
    }
  };

  const stopMicTest = () => {
    if (pipelineRef.current) {
      try { pipelineRef.current.destroy(); } catch { /* */ }
      pipelineRef.current = null;
    }
    if (loopbackAudioRef.current) {
      try { loopbackAudioRef.current.pause(); } catch { /* */ }
      try { loopbackAudioRef.current.srcObject = null; } catch { /* */ }
      loopbackAudioRef.current = null;
    }
    setMicLevel({ percent: 0, db: -100, gateOpen: false });
    setIsTestingMic(false);
  };

  const testSpeaker = () => {
    if (isTestingSpeaker) {
      testAudioRef.current?.stop();
      testAudioRef.current = null;
      setIsTestingSpeaker(false);
      return;
    }

    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    
    // Используем звук соединения как тест (два тона)
    const osc1 = audioContext.createOscillator();
    const osc2 = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    
    osc1.connect(gainNode);
    osc2.connect(gainNode);
    gainNode.connect(audioContext.destination);
    
    osc1.frequency.value = 660; // Первый тон
    osc2.frequency.value = 880; // Второй тон
    osc1.type = 'sine';
    osc2.type = 'sine';
    gainNode.gain.value = (settings.outputVolume ?? 1) * 0.3; // 30% от настроенной громкости
    
    const now = audioContext.currentTime;
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime((settings.outputVolume ?? 1) * 0.3, now + 0.01);
    gainNode.gain.linearRampToValueAtTime(0, now + 0.25);
    
    osc1.start(now);
    osc2.start(now + 0.1);
    osc1.stop(now + 0.25);
    osc2.stop(now + 0.25);
    
    // Остановить через 0.3 секунды
    setTimeout(() => {
      audioContext.close();
      setIsTestingSpeaker(false);
      testAudioRef.current = null;
    }, 300);
    
    testAudioRef.current = { stop: () => { osc1.stop(); osc2.stop(); } };
    setIsTestingSpeaker(true);
  };

  useEffect(() => {
    let cancelled = false;
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.enumerateDevices) return undefined;
    async function loadDevices() {
      try {
        const list = await mediaDevices.enumerateDevices();
        if (cancelled) return;
        const input = list.filter((d) => d.kind === 'audioinput');
        const output = list.filter((d) => d.kind === 'audiooutput');
        setDevices({ input, output });
      } catch { /* ignore */ }
    }
    loadDevices();
    const handler = () => loadDevices();
    mediaDevices.addEventListener?.('devicechange', handler);
    return () => {
      cancelled = true;
      mediaDevices.removeEventListener?.('devicechange', handler);
    };
  }, [deviceRefreshKey]);

  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <label className="text-xs text-slate-400 uppercase tracking-wider">
          Разрешения
        </label>
        <div className="rounded-lg border border-border bg-bg-2 divide-y divide-border">
          <PermissionRow
            icon={<Mic size={16} />}
            title="Микрофон"
            description="Нужен для голосовых сообщений и звонков"
            status={permissions.microphone}
            busy={permissionBusy === 'microphone' || permissionBusy === 'media'}
            onRequest={() => requestPermission('microphone')}
          />
          <PermissionRow
            icon={<Video size={16} />}
            title="Камера"
            description="Нужна для видеозвонков"
            status={permissions.camera}
            busy={permissionBusy === 'camera' || permissionBusy === 'media'}
            onRequest={() => requestPermission('camera')}
          />
          <PermissionRow
            icon={<MonitorUp size={16} />}
            title="Демонстрация экрана"
            description="Браузер спрашивает доступ каждый раз при запуске показа"
            status={permissions.screen}
            busy={permissionBusy === 'screen'}
            onRequest={() => requestPermission('screen')}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-primary h-9 px-3 text-xs disabled:opacity-50"
            onClick={() => requestPermission('media')}
            disabled={!!permissionBusy}
          >
            {permissionBusy === 'media' ? 'Запрашиваем…' : 'Разрешить микрофон и камеру'}
          </button>
          <button
            type="button"
            className="btn-ghost h-9 px-3 text-xs"
            onClick={() => {
              refreshPermissions();
              setDeviceRefreshKey((n) => n + 1);
            }}
            disabled={!!permissionBusy}
          >
            <RefreshCw size={12} className="mr-1" />
            Обновить
          </button>
        </div>
        {permissionError && (
          <div className="text-xs text-amber-300">
            {permissionError}
          </div>
        )}
      </div>

      <div className="h-px bg-border" />

      <div className="space-y-1.5">
        <label className="text-xs text-slate-400 uppercase tracking-wider">
          Микрофон (исходящий)
        </label>
        <select
          className="input"
          value={settings.inputDeviceId || 'default'}
          onChange={(e) => update({ inputDeviceId: e.target.value })}
        >
          <option value="default">По умолчанию</option>
          {devices.input.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Устройство ${d.deviceId.slice(0, 6)}`}
            </option>
          ))}
        </select>
        <SliderRow
          icon={<Mic size={14} className="text-slate-400" />}
          value={Math.round((settings.inputVolume ?? 1) * 100)}
          min={0}
          max={200}
          step={5}
          unit="%"
          onChange={(v) => update({ inputVolume: v / 100 })}
        />
        
        {/* Визуализация уровня микрофона */}
        {isTestingMic && (
          <div className="pt-2">
            <div className="flex items-center gap-2 mb-1">
              <div className="flex-1 h-2 bg-bg-3 rounded-full overflow-hidden relative">
                <div
                  className={`h-full transition-all duration-75 ${
                    micLevel.gateOpen ? 'bg-emerald-500' : 'bg-slate-500'
                  }`}
                  style={{ width: `${((micLevel.db + 100) / 100) * 100}%` }}
                />
                {/* Маркер порога ворот */}
                {settings.noiseSuppression !== false && (
                  <div
                    className="absolute top-0 h-full w-0.5 bg-red-400"
                    style={{ left: `${((settings.noiseThreshold ?? -55) + 100) / 100 * 100}%` }}
                    title={`Порог ворот: ${settings.noiseThreshold ?? -55} дБ`}
                  />
                )}
              </div>
              <span className="text-xs text-slate-400 w-20 text-right tabular-nums">
                {micLevel.db} дБ
              </span>
            </div>
            <div className="text-[10px] text-slate-500">
              {micLevel.gateOpen
                ? 'Ворота открыты — звук идёт собеседнику'
                : `Ниже порога ${settings.noiseThreshold ?? -55} дБ — пир сейчас слышит тишину`}
            </div>
          </div>
        )}
        
        {/* Кнопка проверки микрофона */}
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={isTestingMic ? stopMicTest : startMicTest}
            className={`btn-ghost h-8 px-3 text-xs ${
              isTestingMic ? 'text-red-400' : ''
            }`}
          >
            {isTestingMic ? 'Остановить тест' : 'Проверить микрофон'}
          </button>
          {isTestingMic && (
            <span className="text-[11px] text-slate-500">
              Вы должны слышать свой голос через динамики
            </span>
          )}
        </div>
        
        <div className="text-[11px] text-slate-500">
          Смена микрофона применится к следующему звонку.
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs text-slate-400 uppercase tracking-wider">
          Динамик / наушники (входящий)
        </label>
        {canPickOutput ? (
          <select
            className="input"
            value={settings.outputDeviceId || 'default'}
            onChange={(e) => update({ outputDeviceId: e.target.value })}
          >
            <option value="default">По умолчанию</option>
            {devices.output.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Устройство ${d.deviceId.slice(0, 6)}`}
              </option>
            ))}
          </select>
        ) : (
          <div className="text-xs text-slate-500">
            Выбор устройства вывода не поддерживается этим браузером.
          </div>
        )}
        <SliderRow
          icon={<Volume2 size={14} className="text-slate-400" />}
          value={Math.round((settings.outputVolume ?? 1) * 100)}
          min={0}
          max={100}
          step={1}
          unit="%"
          onChange={(v) => update({ outputVolume: v / 100 })}
        />
        
        {/* Кнопка проверки динамика */}
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={testSpeaker}
            className="btn-ghost h-8 px-3 text-xs"
          >
            <Play size={12} className="mr-1" />
            {isTestingSpeaker ? 'Остановить тест' : 'Тест динамика'}
          </button>
        </div>
      </div>

      <div className="space-y-3">
        <label className="text-xs text-slate-400 uppercase tracking-wider">
          Обработка микрофона
        </label>
        <div className="text-[11px] text-slate-500 -mt-1.5">
          Цепочка: HighPass → Compressor → NoiseGate → MakeupGain. Применяется
          к исходящему звуку звонка. Кнопка «Проверить микрофон» воспроизводит
          ровно тот же результат, что услышит собеседник.
        </div>

        {/* High-pass --------------------------------------------- */}
        <ToggleRow
          title="Высокочастотный фильтр"
          description="Срезает низкочастотный гул (вентилятор, гудение, бубнение в стол)"
          icon={<Sliders size={16} />}
          checked={settings.highPassFilter !== false}
          onChange={(v) => update({ highPassFilter: v })}
        />
        {settings.highPassFilter !== false && (
          <div className="pl-7">
            <label className="text-[11px] text-slate-500">
              Частота среза
            </label>
            <SliderRow
              icon={null}
              value={settings.highPassFrequency ?? 100}
              min={20}
              max={400}
              step={5}
              unit=" Гц"
              onChange={(v) => update({ highPassFrequency: v })}
            />
          </div>
        )}

        {/* Compressor -------------------------------------------- */}
        <ToggleRow
          title="Компрессор"
          description="Выравнивает громкость: тихое подтягивает, громкое прижимает (как в OBS / Discord)"
          icon={<Activity size={16} />}
          checked={settings.compressorEnabled !== false}
          onChange={(v) => update({ compressorEnabled: v })}
        />
        {settings.compressorEnabled !== false && (
          <div className="pl-7 space-y-2">
            <div>
              <label className="text-[11px] text-slate-500">Порог (threshold)</label>
              <SliderRow
                icon={null}
                value={settings.compressorThreshold ?? -24}
                min={-60}
                max={0}
                step={1}
                unit=" дБ"
                onChange={(v) => update({ compressorThreshold: v })}
              />
            </div>
            <div>
              <label className="text-[11px] text-slate-500">Степень сжатия (ratio)</label>
              <SliderRow
                icon={null}
                value={settings.compressorRatio ?? 4}
                min={1}
                max={20}
                step={0.5}
                unit=":1"
                onChange={(v) => update({ compressorRatio: v })}
              />
            </div>
            <div>
              <label className="text-[11px] text-slate-500">Атака</label>
              <SliderRow
                icon={null}
                value={settings.compressorAttack ?? 5}
                min={0}
                max={100}
                step={1}
                unit=" мс"
                onChange={(v) => update({ compressorAttack: v })}
              />
            </div>
            <div>
              <label className="text-[11px] text-slate-500">Спад (release)</label>
              <SliderRow
                icon={null}
                value={settings.compressorRelease ?? 50}
                min={0}
                max={500}
                step={5}
                unit=" мс"
                onChange={(v) => update({ compressorRelease: v })}
              />
            </div>
            <div>
              <label className="text-[11px] text-slate-500">Перегиб (knee)</label>
              <SliderRow
                icon={null}
                value={settings.compressorKnee ?? 30}
                min={0}
                max={40}
                step={1}
                unit=" дБ"
                onChange={(v) => update({ compressorKnee: v })}
              />
            </div>
          </div>
        )}

        {/* Noise gate -------------------------------------------- */}
        <ToggleRow
          title="Шумовые ворота (gate)"
          description="Полностью режет звук между фразами, когда вы молчите"
          icon={<Mic size={16} />}
          checked={settings.noiseSuppression !== false}
          onChange={(v) => update({ noiseSuppression: v })}
        />
        {settings.noiseSuppression !== false && (
          <div className="pl-7">
            <label className="text-[11px] text-slate-500">
              Порог открытия ворот
            </label>
            <SliderRow
              icon={null}
              value={settings.noiseThreshold ?? -55}
              min={-100}
              max={0}
              step={1}
              unit=" дБ"
              onChange={(v) => update({ noiseThreshold: v })}
            />
          </div>
        )}

        {/* Advanced (expandable) -------------------------------- */}
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200"
        >
          {advancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {advancedOpen ? 'Скрыть' : 'Показать'} расширенные параметры
        </button>
        {advancedOpen && (
          <div className="space-y-2 pl-1">
            <div>
              <label className="text-[11px] text-slate-500">Make-up gain (после компрессора)</label>
              <SliderRow
                icon={null}
                value={settings.makeupGainDb ?? 0}
                min={-12}
                max={12}
                step={0.5}
                unit=" дБ"
                onChange={(v) => update({ makeupGainDb: v })}
              />
            </div>
            {settings.noiseSuppression !== false && (
              <>
                <div>
                  <label className="text-[11px] text-slate-500">Hangover ворот (как долго держать открытыми после паузы)</label>
                  <SliderRow
                    icon={null}
                    value={settings.noiseGateHoldMs ?? 200}
                    min={0}
                    max={1000}
                    step={10}
                    unit=" мс"
                    onChange={(v) => update({ noiseGateHoldMs: v })}
                  />
                </div>
                <div>
                  <label className="text-[11px] text-slate-500">Атака ворот (плавность открытия)</label>
                  <SliderRow
                    icon={null}
                    value={settings.noiseGateAttackMs ?? 10}
                    min={0}
                    max={200}
                    step={1}
                    unit=" мс"
                    onChange={(v) => update({ noiseGateAttackMs: v })}
                  />
                </div>
                <div>
                  <label className="text-[11px] text-slate-500">Спад ворот (плавность закрытия)</label>
                  <SliderRow
                    icon={null}
                    value={settings.noiseGateReleaseMs ?? 80}
                    min={0}
                    max={500}
                    step={5}
                    unit=" мс"
                    onChange={(v) => update({ noiseGateReleaseMs: v })}
                  />
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------- Notifications --------------------------------------------

function NotificationsTab() {
  const { settings, update } = useSettings();
  const { auth } = useAuth();
  const toast = useToast();
  const sounds = useSounds(settings);
  const [pushStatus, setPushStatus] = useState(null);
  const [pushBusy, setPushBusy] = useState(false);

  const refreshPush = async () => {
    const s = await getPushStatus(auth?.token);
    setPushStatus(s);
  };
  useEffect(() => { refreshPush(); /* eslint-disable-line */ }, [auth?.token]);

  const onTogglePush = async (next) => {
    if (pushBusy) return;
    setPushBusy(true);
    try {
      if (next) {
        await enablePush(auth?.token);
      } else {
        await disablePush(auth?.token);
      }
      await refreshPush();
    } catch (e) {
      toast.error(e?.message || 'Не удалось изменить настройку push');
    } finally {
      setPushBusy(false);
    }
  };

  const items = [
    { key: 'soundMessage', label: 'Новое сообщение', preview: 'message' },
    { key: 'soundIncoming', label: 'Входящий звонок', preview: 'incoming' },
    { key: 'soundOutgoing', label: 'Гудки исходящего', preview: 'outgoing' },
    { key: 'soundConnect', label: 'Соединение установлено', preview: 'connect' },
    { key: 'soundDisconnect', label: 'Завершение звонка', preview: 'disconnect' },
  ];

  return (
    <section className="space-y-5">
      {/* Web Push */}
      <PushBlock
        status={pushStatus}
        busy={pushBusy}
        onToggle={onTogglePush}
      />

      <div className="h-px bg-border" />

      {/* Master switch */}
      <ToggleRow
        title="Звуки интерфейса"
        description="Главный переключатель UI-звуков"
        icon={settings.soundsEnabled ? <Bell size={16} /> : <BellOff size={16} />}
        checked={settings.soundsEnabled}
        onChange={(v) => update({ soundsEnabled: v })}
      />

      {/* UI volume */}
      <div className="space-y-1.5">
        <label className="text-xs text-slate-400 uppercase tracking-wider">
          Громкость UI-звуков
        </label>
        <SliderRow
          icon={<Volume2 size={14} className="text-slate-400" />}
          value={Math.round((settings.uiVolume ?? 0.8) * 100)}
          min={0}
          max={100}
          step={1}
          unit="%"
          disabled={!settings.soundsEnabled}
          onChange={(v) => update({ uiVolume: v / 100 })}
        />
      </div>

      <div className="h-px bg-border" />

      {/* Granular toggles */}
      <div className="space-y-1.5">
        <div className="text-xs text-slate-400 uppercase tracking-wider">События</div>
        <div className="rounded-lg border border-border divide-y divide-border bg-bg-2">
          {items.map((it) => (
            <div
              key={it.key}
              className={`flex items-center gap-3 px-3 py-2.5 ${
                !settings.soundsEnabled ? 'opacity-50' : ''
              }`}
            >
              <div className="flex-1 min-w-0 text-sm">{it.label}</div>
              <button
                type="button"
                onClick={() => sounds.preview(it.preview)}
                disabled={!settings.soundsEnabled}
                className="btn-ghost h-7 px-2 text-xs"
                title="Прослушать"
              >
                <Play size={12} className="mr-1" />
                <span>Тест</span>
              </button>
              <Switch
                checked={settings[it.key] !== false}
                onChange={(v) => update({ [it.key]: v })}
                disabled={!settings.soundsEnabled}
              />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function PushBlock({ status, busy, onToggle }) {
  if (!pushSupported()) {
    return (
      <div className="rounded-lg border border-border bg-bg-2 p-3 text-sm text-slate-400">
        <div className="flex items-center gap-2 mb-1">
          <Smartphone size={16} />
          <span className="font-medium text-slate-200">Системные уведомления</span>
        </div>
        Ваш браузер не поддерживает Web Push. На iOS Safari это работает только
        в режиме PWA (Добавить на главный экран).
      </div>
    );
  }
  if (status && status.configured === false) {
    return (
      <div className="rounded-lg border border-border bg-bg-2 p-3 text-sm text-slate-400">
        <div className="flex items-center gap-2 mb-1">
          <Smartphone size={16} />
          <span className="font-medium text-slate-200">Системные уведомления</span>
        </div>
        Push не настроен на сервере (отсутствует VAPID-конфигурация).
        Свяжитесь с администратором.
      </div>
    );
  }
  const subscribed = !!status?.subscribed;
  const denied = status?.permission === 'denied';
  return (
    <div className="rounded-lg border border-border bg-bg-2 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Smartphone size={16} className="opacity-70" />
          <div className="min-w-0">
            <div className="text-sm font-medium">Системные уведомления</div>
            <div className="text-xs text-slate-500">
              {denied
                ? 'Разрешение запрещено в браузере. Включите в настройках сайта.'
                : subscribed
                  ? 'Включены на этом устройстве. Вы будете получать уведомления о звонках и сообщениях.'
                  : 'Получайте уведомления, даже когда вкладка закрыта.'}
            </div>
          </div>
        </div>
        <Switch
          checked={subscribed}
          onChange={(v) => onToggle(v)}
          disabled={busy || denied}
        />
      </div>
    </div>
  );
}

// ---------------- Privacy ---------------------------------------------------

function PrivacyTab() {
  const { auth, updateUser } = useAuth();
  const toast = useToast();
  const user = auth?.user;
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Серверная конфигурация compliance-модуля. Запрашиваем один раз —
  // по `enabled` решаем, показывать ли ссылку на политику.
  const [privacyEnabled, setPrivacyEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/config')
      .then((r) => r.json())
      .then((cfg) => {
        if (!cancelled) setPrivacyEnabled(!!cfg?.privacy?.enabled);
      })
      .catch(() => { /* серверу плохо — оставим выключенным */ });
    return () => { cancelled = true; };
  }, []);

  const setHide = async (next) => {
    setSaving(true);
    try {
      const { user: u } = await api.updateMe(auth.token, { hideOnDelete: !!next });
      updateUser(u);
    } catch (e) {
      toast.error(e.message || 'Не удалось сохранить');
    } finally {
      setSaving(false);
    }
  };

  // Скачивание JSON-выгрузки. Сервер уже отдаёт правильный
  // Content-Disposition, нам остаётся только превратить blob в файл.
  const onExport = async () => {
    if (!auth?.token) return;
    setExporting(true);
    try {
      const blob = await api.dataExport(auth.token);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `owncord-data-${user?.username || 'me'}-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success('Данные выгружены');
    } catch (e) {
      toast.error(e.message || 'Не удалось скачать данные');
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className="space-y-4">
      <ToggleRow
        title="Полностью удалять мои сообщения"
        description="При удалении сообщение полностью исчезает у обеих сторон. Иначе остаётся плашка «сообщение удалено»."
        icon={<Trash2 size={16} />}
        checked={!!user?.hideOnDelete}
        onChange={setHide}
        disabled={saving}
      />

      <div className="h-px bg-border" />

      <div className="space-y-2">
        <div className="text-xs uppercase tracking-wider text-slate-500">
          Мои данные
        </div>
        <div className="rounded-lg border border-border bg-bg-2 p-3 space-y-3">
          <div>
            <div className="text-sm font-medium">Скачать мои данные</div>
            <p className="text-xs text-slate-400 mt-1">
              JSON со всеми данными вашей учётной записи: профиль, отправленные
              сообщения, группы, выпущенные приглашения, мьюты. Право,
              предусмотренное ст. 14 152-ФЗ.
            </p>
          </div>
          <button
            type="button"
            className="h-9 px-3 rounded-lg bg-bg-3 hover:bg-bg-4 border border-border text-sm inline-flex items-center gap-2 disabled:opacity-50"
            onClick={onExport}
            disabled={exporting}
          >
            <Download size={14} />
            {exporting ? 'Готовим…' : 'Скачать (JSON)'}
          </button>
          {privacyEnabled && (
            <div className="text-xs">
              <a
                href="/privacy"
                target="_blank"
                rel="noreferrer noopener"
                className="text-accent hover:underline inline-flex items-center gap-1"
              >
                Политика обработки персональных данных
                <ExternalLink size={11} />
              </a>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// ---------------- Invites (admin) ------------------------------------------

function InvitesTab() {
  const { auth } = useAuth();
  const toast = useToast();
  const token = auth?.token;
  const [codes, setCodes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  // Поля формы создания.
  const [note, setNote] = useState('');
  const [maxUses, setMaxUses] = useState('1');     // по умолчанию одноразовый
  const [expiresIn, setExpiresIn] = useState('7'); // дни; пусто = бессрочный
  const [customCode, setCustomCode] = useState('');

  const refresh = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await api.listInvites(token);
      setCodes(r.codes || []);
    } catch (e) {
      toast.error(e.message || 'Не удалось загрузить коды');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); /* eslint-disable-line */ }, [token]);

  const onCreate = async (e) => {
    e.preventDefault();
    setCreating(true);
    try {
      const body: Record<string, unknown> = {};
      const mu = maxUses.trim();
      if (mu) {
        const n = Number(mu);
        if (!Number.isFinite(n) || n < 1) {
          toast.error('Максимум использований должен быть ≥ 1');
          setCreating(false);
          return;
        }
        body.maxUses = n;
      }
      const ei = expiresIn.trim();
      if (ei) {
        const days = Number(ei);
        if (!Number.isFinite(days) || days <= 0) {
          toast.error('Срок жизни должен быть положительным числом дней');
          setCreating(false);
          return;
        }
        body.expiresAt = Date.now() + Math.floor(days * 24 * 3600 * 1000);
      }
      if (note.trim()) body.note = note.trim();
      if (customCode.trim()) body.code = customCode.trim();
      await api.createInvite(token, body);
      setNote('');
      setCustomCode('');
      await refresh();
      toast.success('Код создан');
    } catch (e) {
      toast.error(e.message || 'Не удалось создать код');
    } finally {
      setCreating(false);
    }
  };

  const onRevoke = async (code) => {
    if (!confirm(`Отозвать код «${code}»? Зарегистрироваться по нему уже не получится.`)) return;
    try {
      await api.revokeInvite(token, code);
      await refresh();
    } catch (e) {
      toast.error(e.message || 'Не удалось отозвать');
    }
  };

  return (
    <section className="space-y-5">
      <div className="text-xs text-slate-400">
        Здесь можно выпускать одноразовые или multi-use коды для регистрации
        новых пользователей. Они работают параллельно с общим кодом из
        <code className="mx-1">REGISTRATION_CODE</code> в <code>.env</code>.
      </div>

      {/* --- Форма создания --- */}
      <form onSubmit={onCreate} className="bg-bg-2 border border-border rounded-lg p-3 space-y-3">
        <div className="text-sm font-semibold">Создать новый код</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-slate-400">Подпись (для себя)</label>
            <input
              className="input"
              placeholder="например: для Васи"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={200}
            />
          </div>
          <div>
            <label className="text-xs text-slate-400">Свой код (необязательно)</label>
            <input
              className="input"
              placeholder="оставь пустым для авто"
              value={customCode}
              onChange={(e) => setCustomCode(e.target.value)}
              maxLength={64}
            />
          </div>
          <div>
            <label className="text-xs text-slate-400">Максимум использований</label>
            <input
              className="input"
              type="number"
              min="1"
              placeholder="без ограничения — оставь пустым"
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs text-slate-400">Срок жизни (дней)</label>
            <input
              className="input"
              type="number"
              min="1"
              placeholder="без ограничения — оставь пустым"
              value={expiresIn}
              onChange={(e) => setExpiresIn(e.target.value)}
            />
          </div>
        </div>
        <div className="flex justify-end">
          <button type="submit" className="btn-primary" disabled={creating}>
            {creating ? 'Создаём…' : 'Создать код'}
          </button>
        </div>
      </form>

      {/* --- Список кодов --- */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">Коды ({codes.length})</div>
          <button className="btn-ghost" onClick={refresh} title="Обновить" type="button">
            <RefreshCw size={14} />
          </button>
        </div>
        {loading && codes.length === 0 ? (
          <div className="text-sm text-slate-500">Загрузка…</div>
        ) : codes.length === 0 ? (
          <div className="text-sm text-slate-500">Пока ни одного кода. Создай первый выше.</div>
        ) : (
          <ul className="space-y-1.5">
            {codes.map((c) => <InviteRow key={c.code} code={c} onRevoke={onRevoke} />)}
          </ul>
        )}
      </div>
    </section>
  );
}

function InviteRow({ code, onRevoke }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard может быть запрещён */ }
  };

  let status = 'активен';
  let statusClass = 'text-emerald-400';
  if (code.revokedAt) {
    status = 'отозван';
    statusClass = 'text-slate-500';
  } else if (code.expiresAt && code.expiresAt <= Date.now()) {
    status = 'истёк';
    statusClass = 'text-amber-400';
  } else if (code.maxUses != null && code.usesCount >= code.maxUses) {
    status = 'исчерпан';
    statusClass = 'text-amber-400';
  }

  const usesLabel = code.maxUses == null
    ? `${code.usesCount} использований`
    : `${code.usesCount} / ${code.maxUses}`;
  const expiresLabel = code.expiresAt
    ? `до ${new Date(code.expiresAt).toLocaleDateString()}`
    : 'без срока';

  return (
    <li className="bg-bg-2 border border-border rounded-lg p-2.5 flex items-center gap-2">
      <button
        type="button"
        onClick={handleCopy}
        title="Скопировать"
        className="btn-ghost shrink-0"
      >
        {copied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="font-mono text-sm truncate">{code.code}</div>
        <div className="text-xs text-slate-500 truncate">
          <span className={statusClass}>{status}</span>
          {' · '}{usesLabel}{' · '}{expiresLabel}
          {code.note ? ` · ${code.note}` : ''}
        </div>
      </div>
      {!code.revokedAt && (
        <button
          type="button"
          onClick={() => onRevoke(code.code)}
          className="btn-ghost text-danger shrink-0"
          title="Отозвать"
        >
          <Trash2 size={14} />
        </button>
      )}
    </li>
  );
}

// ---------------- Atoms -----------------------------------------------------

function PermissionRow({ icon, title, description, status, busy, onRequest }) {
  const label = PERMISSION_TEXT[status] || PERMISSION_TEXT.unknown;
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
      <div className="flex items-center gap-3 min-w-0">
        <span className="opacity-70 shrink-0">{icon}</span>
        <div className="min-w-0">
          <div className="text-sm">{title}</div>
          <div className="text-xs text-slate-500">{description}</div>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className={`text-xs tabular-nums ${permissionClass(status)}`}>
          {label}
        </span>
        <button
          type="button"
          className="btn-ghost h-8 px-2 text-xs disabled:opacity-50"
          onClick={onRequest}
          disabled={busy}
        >
          {busy ? '…' : 'Разрешить'}
        </button>
      </div>
    </div>
  );
}

function SliderRow({ icon, value, min, max, step, unit = '', onChange, disabled = false }) {
  return (
    <div className={`flex items-center gap-2 pt-1 ${disabled ? 'opacity-50' : ''}`}>
      {icon}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
        className="range flex-1"
        style={{ '--range-progress': `${((value - min) / (max - min)) * 100}%` } as CSSProperties}
      />
      <span className="text-xs text-slate-400 w-16 text-right tabular-nums">
        {value}{unit}
      </span>
    </div>
  );
}

function ToggleRow({ title, description, icon, checked, onChange, disabled = false }) {
  return (
    <div className={`flex items-center justify-between gap-3 ${disabled ? 'opacity-60' : ''}`}>
      <div className="flex items-center gap-3 min-w-0">
        <span className="opacity-70 shrink-0">{icon}</span>
        <div className="min-w-0">
          <div className="text-sm">{title}</div>
          {description && (
            <div className="text-xs text-slate-500">{description}</div>
          )}
        </div>
      </div>
      <Switch checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

function Switch({ checked, onChange, disabled }) {
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${
        checked ? 'bg-accent' : 'bg-bg-3'
      } ${disabled ? 'cursor-not-allowed' : ''}`}
      role="switch"
      aria-checked={checked}
      type="button"
    >
      <span
        className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
          checked ? 'left-[22px]' : 'left-0.5'
        }`}
      />
    </button>
  );
}
