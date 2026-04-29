import type {
  ApiOk,
  AuthSession,
  Group,
  IceServerConfig,
  Message,
  User,
} from './types';

const BASE = '';

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// AuthContext регистрирует здесь обработчик 401, чтобы при истечении/отзыве
// JWT клиент сам выкинул пользователя на экран логина и не зацикливался на
// «HTTP 401» в тостах. Регистрируется один раз — повторные вызовы заменяют.
let onAuthExpired: ((body: unknown) => void) | null = null;
export function setAuthExpiredHandler(fn: ((body: unknown) => void) | null) {
  onAuthExpired = typeof fn === 'function' ? fn : null;
}

function isErrorBody(body: unknown): body is { error?: string } {
  return !!body && typeof body === 'object' && 'error' in body;
}

function handle401(path: string, status: number, body: unknown) {
  if (status !== 401) return;
  // /auth/login и /auth/register отдают 401 как нормальный сценарий
  // «неверные креды», а не как «токен истёк». Их игнорируем.
  if (path.startsWith('/api/auth/')) return;
  if (onAuthExpired) {
    try { onAuthExpired(body); } catch { /* */ }
  }
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  token?: string | null;
};

async function request<T>(path: string, { method = 'GET', body, token }: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  if (!res.ok) {
    handle401(path, res.status, data);
    throw new ApiError((isErrorBody(data) && data.error) || `HTTP ${res.status}`, res.status);
  }
  return data as T;
}

async function requestMultipart<T>(
  path: string,
  { token, formData, method = 'POST' }: { token?: string | null; formData: FormData; method?: string },
): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: formData });
  let data: unknown = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    handle401(path, res.status, data);
    throw new ApiError((isErrorBody(data) && data.error) || `HTTP ${res.status}`, res.status);
  }
  return data as T;
}

export const api = {
  register: (username: string, password: string, invite?: string, opts: { privacyConsent?: boolean } = {}) =>
    request<AuthSession>('/api/auth/register', {
      method: 'POST',
      body: {
        username,
        password,
        invite: invite || undefined,
        // Передаём только если действительно поставили чекбокс — чтобы
        // случайно не зашить `false` в payload и не сломать сценарий
        // «модуль выключен». Сервер всё равно делает строгую проверку.
        privacyConsent: opts.privacyConsent === true ? true : undefined,
      },
    }),
  login: (username: string, password: string) =>
    request<AuthSession>('/api/auth/login', { method: 'POST', body: { username, password } }),
  registrationInfo: () => request<{
    disabled: boolean;
    inviteRequired: boolean;
    privacyEnabled: boolean;
    requirePrivacyConsent: boolean;
  }>('/api/auth/registration-info'),
  me: (token: string) => request<{ user: User }>('/api/me', { token }),
  updateMe: (token: string, patch: Partial<User>) =>
    request<{ user: User }>('/api/me', { method: 'PATCH', body: patch, token }),
  uploadAvatar: (token: string, file: File) => {
    const fd = new FormData();
    fd.append('avatar', file);
    return requestMultipart<{ user: User }>('/api/me/avatar', { token, formData: fd });
  },
  deleteAvatar: (token: string) => request<{ user: User }>('/api/me/avatar', { method: 'DELETE', token }),
  users: (token: string) => request<{ users: User[] }>('/api/users', { token }),
  user: (token: string, id: number) => request<{ user: User }>(`/api/users/${id}`, { token }),
  history: (token: string, peerId: number) => request<{ messages: Message[] }>(`/api/messages/${peerId}`, { token }),
  sendVoice: (token: string, to: number, blob: Blob, durationMs: number) => {
    const fd = new FormData();
    fd.append('to', String(to));
    fd.append('durationMs', String(durationMs || 0));
    fd.append('voice', blob, `voice-${Date.now()}.webm`);
    return requestMultipart<{ ok: true; message: Message }>('/api/messages/voice', { token, formData: fd });
  },
  editMessage: (token: string, id: number, content: string) =>
    request<{ ok: true; message: Message }>(`/api/messages/${id}`, { method: 'PATCH', body: { content }, token }),
  deleteMessage: (token: string, id: number) =>
    request<{ ok: true; message?: Message; removed?: boolean }>(`/api/messages/${id}`, { method: 'DELETE', token }),
  sendFile: (token: string, to: number, file: File, content = '') => {
    const fd = new FormData();
    fd.append('to', String(to));
    if (content) fd.append('content', content);
    fd.append('file', file, file.name);
    return requestMultipart<{ ok: true; message: Message }>('/api/messages/file', { token, formData: fd });
  },
  listMutes: (token: string) => request<{ ids: number[] }>('/api/mutes', { token }),
  addMute: (token: string, targetId: number) =>
    request<{ ids: number[] }>(`/api/mutes/${targetId}`, { method: 'POST', token }),
  removeMute: (token: string, targetId: number) =>
    request<{ ids: number[] }>(`/api/mutes/${targetId}`, { method: 'DELETE', token }),
  iceServers: () => request<IceServerConfig>('/api/ice'),
  config: () => request<{ maxUploadBytes: number; registrationDisabled?: boolean; privacyRequired?: boolean }>('/api/config'),

  // --- Группы -------------------------------------------------------------
  listGroups: (token: string) => request<{ groups: Group[] }>('/api/groups', { token }),
  createGroup: (token: string, name: string, memberIds: number[]) =>
    request<{ group: Group }>('/api/groups', { method: 'POST', body: { name, memberIds }, token }),
  getGroup: (token: string, id: number) => request<{ group: Group }>(`/api/groups/${id}`, { token }),
  updateGroup: (token: string, id: number, patch: Partial<Group>) =>
    request<{ group: Group }>(`/api/groups/${id}`, { method: 'PATCH', body: patch, token }),
  deleteGroup: (token: string, id: number) => request<ApiOk & { deleted?: true; left?: true }>(`/api/groups/${id}`, { method: 'DELETE', token }),
  addGroupMembers: (token: string, id: number, memberIds: number[]) =>
    request<{ group: Group }>(`/api/groups/${id}/members`, { method: 'POST', body: { memberIds }, token }),
  removeGroupMember: (token: string, id: number, userId: number) =>
    request<ApiOk & { group?: Group }>(`/api/groups/${id}/members/${userId}`, { method: 'DELETE', token }),
  uploadGroupAvatar: (token: string, id: number, file: File) => {
    const fd = new FormData();
    fd.append('avatar', file);
    return requestMultipart<{ group: Group }>(`/api/groups/${id}/avatar`, { token, formData: fd });
  },
  deleteGroupAvatar: (token: string, id: number) =>
    request<{ group: Group }>(`/api/groups/${id}/avatar`, { method: 'DELETE', token }),
  groupHistory: (token: string, id: number) => request<{ messages: Message[] }>(`/api/groups/${id}/messages`, { token }),

  // Удалить собственный аккаунт (требует пароль).
  deleteMe: (token: string, password: string) =>
    request<ApiOk>('/api/me', { method: 'DELETE', body: { password }, token }),

  // Сменить собственный пароль (требует текущий + новый).
  changePassword: (token: string, currentPassword: string, newPassword: string) =>
    request<ApiOk>('/api/me/password', {
      method: 'POST',
      body: { currentPassword, newPassword },
      token,
    }),

  // 152-ФЗ право на доступ к своим данным. Возвращает Promise<Blob>,
  // который вызывающий код сохраняет как файл (через FileSaver/anchor).
  dataExport: async (token: string): Promise<Blob> => {
    const res = await fetch(`${BASE}/api/me/data-export`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        msg = (isErrorBody(body) && body.error) || msg;
      } catch { /* */ }
      throw new ApiError(msg, res.status);
    }
    return res.blob();
  },

  // --- Web Push -----------------------------------------------------------
  pushConfig: () => request<{ enabled: boolean; publicKey?: string }>('/api/push/config'),
  pushSubscribe: (token: string, subscription: PushSubscriptionJSON) =>
    request<ApiOk>('/api/push/subscribe', { method: 'POST', body: { subscription }, token }),
  pushUnsubscribe: (token: string, endpoint: string) =>
    request<ApiOk>('/api/push/unsubscribe', { method: 'POST', body: { endpoint }, token }),

  // --- Инвайт-коды (admin only) -------------------------------------------
  listInvites: (token: string) => request<{ codes: Array<{ code: string; maxUses?: number | null; uses?: number; expiresAt?: number | null; createdAt?: number }> }>('/api/invites', { token }),
  createInvite: (token: string, body: Record<string, unknown>) =>
    request<{ code: { code: string } }>('/api/invites', { method: 'POST', body: body || {}, token }),
  revokeInvite: (token: string, code: string) =>
    request<ApiOk>(`/api/invites/${encodeURIComponent(code)}`, { method: 'DELETE', token }),
  sendGroupVoice: (token: string, id: number, blob: Blob, durationMs: number) => {
    const fd = new FormData();
    fd.append('durationMs', String(durationMs || 0));
    fd.append('voice', blob, `voice-${Date.now()}.webm`);
    return requestMultipart<{ ok: true; message: Message }>(`/api/groups/${id}/messages/voice`, { token, formData: fd });
  },
  sendGroupFile: (token: string, id: number, file: File, content = '') => {
    const fd = new FormData();
    if (content) fd.append('content', content);
    fd.append('file', file, file.name);
    return requestMultipart<{ ok: true; message: Message }>(`/api/groups/${id}/messages/file`, { token, formData: fd });
  },
};
