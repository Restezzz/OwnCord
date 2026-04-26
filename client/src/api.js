const BASE = '';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  if (!res.ok) {
    throw new ApiError((data && data.error) || `HTTP ${res.status}`, res.status);
  }
  return data;
}

async function requestMultipart(path, { token, formData, method = 'POST' } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: formData });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    throw new ApiError((data && data.error) || `HTTP ${res.status}`, res.status);
  }
  return data;
}

export const api = {
  register: (username, password, invite) =>
    request('/api/auth/register', {
      method: 'POST',
      body: { username, password, invite: invite || undefined },
    }),
  login: (username, password) =>
    request('/api/auth/login', { method: 'POST', body: { username, password } }),
  registrationInfo: () => request('/api/auth/registration-info'),
  me: (token) => request('/api/me', { token }),
  updateMe: (token, patch) =>
    request('/api/me', { method: 'PATCH', body: patch, token }),
  uploadAvatar: (token, file) => {
    const fd = new FormData();
    fd.append('avatar', file);
    return requestMultipart('/api/me/avatar', { token, formData: fd });
  },
  deleteAvatar: (token) => request('/api/me/avatar', { method: 'DELETE', token }),
  users: (token) => request('/api/users', { token }),
  user: (token, id) => request(`/api/users/${id}`, { token }),
  history: (token, peerId) => request(`/api/messages/${peerId}`, { token }),
  sendVoice: (token, to, blob, durationMs) => {
    const fd = new FormData();
    fd.append('to', String(to));
    fd.append('durationMs', String(durationMs || 0));
    fd.append('voice', blob, `voice-${Date.now()}.webm`);
    return requestMultipart('/api/messages/voice', { token, formData: fd });
  },
  editMessage: (token, id, content) =>
    request(`/api/messages/${id}`, { method: 'PATCH', body: { content }, token }),
  deleteMessage: (token, id) =>
    request(`/api/messages/${id}`, { method: 'DELETE', token }),
  sendFile: (token, to, file, content = '') => {
    const fd = new FormData();
    fd.append('to', String(to));
    if (content) fd.append('content', content);
    fd.append('file', file, file.name);
    return requestMultipart('/api/messages/file', { token, formData: fd });
  },
  listMutes: (token) => request('/api/mutes', { token }),
  addMute: (token, targetId) =>
    request(`/api/mutes/${targetId}`, { method: 'POST', token }),
  removeMute: (token, targetId) =>
    request(`/api/mutes/${targetId}`, { method: 'DELETE', token }),
  iceServers: () => request('/api/ice'),
  config: () => request('/api/config'),

  // --- Группы -------------------------------------------------------------
  listGroups: (token) => request('/api/groups', { token }),
  createGroup: (token, name, memberIds) =>
    request('/api/groups', { method: 'POST', body: { name, memberIds }, token }),
  getGroup: (token, id) => request(`/api/groups/${id}`, { token }),
  updateGroup: (token, id, patch) =>
    request(`/api/groups/${id}`, { method: 'PATCH', body: patch, token }),
  deleteGroup: (token, id) => request(`/api/groups/${id}`, { method: 'DELETE', token }),
  addGroupMembers: (token, id, memberIds) =>
    request(`/api/groups/${id}/members`, { method: 'POST', body: { memberIds }, token }),
  removeGroupMember: (token, id, userId) =>
    request(`/api/groups/${id}/members/${userId}`, { method: 'DELETE', token }),
  uploadGroupAvatar: (token, id, file) => {
    const fd = new FormData();
    fd.append('avatar', file);
    return requestMultipart(`/api/groups/${id}/avatar`, { token, formData: fd });
  },
  deleteGroupAvatar: (token, id) =>
    request(`/api/groups/${id}/avatar`, { method: 'DELETE', token }),
  groupHistory: (token, id) => request(`/api/groups/${id}/messages`, { token }),

  // --- Web Push -----------------------------------------------------------
  pushConfig: () => request('/api/push/config'),
  pushSubscribe: (token, subscription) =>
    request('/api/push/subscribe', { method: 'POST', body: { subscription }, token }),
  pushUnsubscribe: (token, endpoint) =>
    request('/api/push/unsubscribe', { method: 'POST', body: { endpoint }, token }),

  // --- Инвайт-коды (admin only) -------------------------------------------
  listInvites: (token) => request('/api/invites', { token }),
  createInvite: (token, body) =>
    request('/api/invites', { method: 'POST', body: body || {}, token }),
  revokeInvite: (token, code) =>
    request(`/api/invites/${encodeURIComponent(code)}`, { method: 'DELETE', token }),
  sendGroupVoice: (token, id, blob, durationMs) => {
    const fd = new FormData();
    fd.append('durationMs', String(durationMs || 0));
    fd.append('voice', blob, `voice-${Date.now()}.webm`);
    return requestMultipart(`/api/groups/${id}/messages/voice`, { token, formData: fd });
  },
  sendGroupFile: (token, id, file, content = '') => {
    const fd = new FormData();
    if (content) fd.append('content', content);
    fd.append('file', file, file.name);
    return requestMultipart(`/api/groups/${id}/messages/file`, { token, formData: fd });
  },
};
