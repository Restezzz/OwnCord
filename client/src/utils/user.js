/**
 * Унифицированный доступ к отображаемому имени и аватарке.
 * Если пользователь не задал displayName, показываем логин.
 */
export function getDisplayName(user) {
  if (!user) return '';
  return user.displayName || user.username || '';
}

export function getAvatarUrl(user) {
  if (!user) return null;
  return user.avatarPath || null;
}

export function hasCustomDisplayName(user) {
  if (!user || !user.username) return false;
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
