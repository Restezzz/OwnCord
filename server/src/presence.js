// Reference-counted отслеживание онлайн-юзеров (userId -> количество сокетов).
const counts = new Map();

export function addUserSocket(userId) {
  counts.set(userId, (counts.get(userId) || 0) + 1);
  return counts.get(userId) === 1; // true если пользователь только что стал онлайн
}

export function removeUserSocket(userId) {
  const n = counts.get(userId) || 0;
  if (n <= 1) {
    counts.delete(userId);
    return true; // пользователь ушёл в оффлайн
  }
  counts.set(userId, n - 1);
  return false;
}

export function getOnlineUserIds() {
  return new Set(counts.keys());
}

export function isOnline(userId) {
  return counts.has(userId);
}
