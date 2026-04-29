import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { UserPlus, Lock } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import PasswordInput from '../components/PasswordInput.jsx';
import { api } from '../api.js';

export default function Register() {
  const { register } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [invite, setInvite] = useState('');
  const [consent, setConsent] = useState(false);
  const [info, setInfo] = useState({
    disabled: false,
    inviteRequired: false,
    privacyEnabled: false,
    requirePrivacyConsent: false,
  });
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // Узнаём режим регистрации у сервера: открыта/закрыта, нужен ли код.
  useEffect(() => {
    let cancelled = false;
    api.registrationInfo()
      .then((r) => { if (!cancelled) setInfo(r); })
      .catch(() => { /* серверу плохо — оставим дефолты */ });
    return () => { cancelled = true; };
  }, []);

  const onSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    if (password !== password2) {
      setError('Пароли не совпадают');
      return;
    }
    if (info.requirePrivacyConsent && !consent) {
      setError('Нужно подтвердить согласие на обработку персональных данных');
      return;
    }
    setLoading(true);
    try {
      await register(
        username.trim(),
        password,
        invite.trim() || undefined,
        { privacyConsent: consent },
      );
    } catch (err) {
      setError(err.message || 'Ошибка регистрации');
    } finally {
      setLoading(false);
    }
  };

  if (info.disabled) {
    return (
      <div className="min-h-full grid place-items-center p-6">
        <div className="card w-full max-w-sm p-6 space-y-4 text-center">
          <div className="flex flex-col items-center gap-2 mb-2">
            <div className="w-12 h-12 rounded-2xl bg-bg-2 grid place-items-center shadow-soft">
              <Lock size={22} />
            </div>
            <h1 className="text-xl font-semibold">Регистрация закрыта</h1>
            <p className="text-slate-400 text-sm">
              На этом сервере регистрация новых пользователей отключена.
              Обратитесь к администратору.
            </p>
          </div>
          <Link to="/login" className="btn-primary w-full inline-block text-center">
            Войти
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full grid place-items-center p-6">
      <form onSubmit={onSubmit} className="card w-full max-w-sm p-6 space-y-4">
        <div className="flex flex-col items-center gap-2 mb-2">
          <div className="w-12 h-12 rounded-2xl bg-accent grid place-items-center shadow-soft">
            <UserPlus size={22} />
          </div>
          <h1 className="text-xl font-semibold">Регистрация</h1>
          <p className="text-slate-400 text-sm text-center">
            3–24 символа: буквы, цифры, <code>_ . -</code>
          </p>
        </div>

        <div className="space-y-2">
          <label className="text-sm text-slate-300">Имя пользователя</label>
          <input
            className="input"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm text-slate-300">Пароль</label>
          <PasswordInput
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={6}
            required
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm text-slate-300">Повторите пароль</label>
          <PasswordInput
            value={password2}
            onChange={(e) => setPassword2(e.target.value)}
            autoComplete="new-password"
            minLength={6}
            required
          />
        </div>

        {info.inviteRequired && (
          <div className="space-y-2">
            <label className="text-sm text-slate-300">Код приглашения</label>
            <input
              className="input"
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
              placeholder="Запросите у администратора"
              required
            />
            <p className="text-xs text-slate-500">
              На этом сервере регистрация только по приглашению.
            </p>
          </div>
        )}

        {info.requirePrivacyConsent && (
          <label className="flex items-start gap-2 text-xs text-slate-400 cursor-pointer select-none">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              required
            />
            <span>
              Я ознакомлен(а) и согласен(на) с{' '}
              <a
                href="/privacy"
                target="_blank"
                rel="noreferrer noopener"
                className="text-accent hover:underline"
              >
                политикой обработки персональных данных
              </a>
              {' '}(152-ФЗ).
            </span>
          </label>
        )}

        {error && <div className="text-sm text-danger">{error}</div>}

        <button type="submit" className="btn-primary w-full" disabled={loading}>
          {loading ? 'Создаём…' : 'Создать аккаунт'}
        </button>

        <div className="text-sm text-slate-400 text-center space-y-1">
          <div>
            Уже есть аккаунт?{' '}
            <Link to="/login" className="text-accent hover:underline">
              Войти
            </Link>
          </div>
          {info.privacyEnabled && !info.requirePrivacyConsent && (
            <div className="text-xs text-slate-500">
              <a
                href="/privacy"
                target="_blank"
                rel="noreferrer noopener"
                className="hover:underline"
              >
                Политика конфиденциальности
              </a>
            </div>
          )}
        </div>
      </form>
    </div>
  );
}
