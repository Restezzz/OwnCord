/**
 * Унифицированный доступ к отображаемому имени и аватарке.
 * Если пользователь не задал displayName, показываем логин.
 * Для удалённых аккаунтов (deleted=true) — заглушка.
 */
export const DELETED_USER_LABEL = 'Удалённый пользователь';

export function isDeletedUser(user) {
  return !!(user && user.deleted);
}

export function getDisplayName(user) {
  if (!user) return '';
  if (isDeletedUser(user)) return DELETED_USER_LABEL;
  const name = user.displayName || user.username || '';
  if ((user.username || '').toLowerCase() === 'chieftiv') return `👑 ${name}`;
  return name;
}

export function getAvatarUrl(user) {
  if (!user) return null;
  if (isDeletedUser(user)) return null; // заставит компонент Avatar показать дефолт
  return user.avatarPath || null;
}

export function hasCustomDisplayName(user) {
  if (!user || !user.username || isDeletedUser(user)) return false;
  return !!user.displayName && user.displayName !== user.username;
}

export function formatDate(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return '';
  }
}

export function formatDuration(ms) {
  if (!ms || ms <= 0) return '0:00';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
