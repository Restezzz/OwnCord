import type { Socket } from 'socket.io-client';

export type User = {
  id: number;
  username: string | null;
  displayName?: string | null;
  avatarPath?: string | null;
  createdAt?: number;
  lastActivityAt?: number | null;
  online?: boolean;
  deleted?: boolean;
  self?: boolean;
  isAdmin?: boolean;
  hideOnDelete?: boolean;
};

export type GroupMember = User & {
  role?: 'owner' | 'admin' | 'member' | string;
  joinedAt?: number;
};

export type Group = {
  id: number;
  name: string;
  avatarPath?: string | null;
  ownerId?: number;
  createdAt?: number;
  updatedAt?: number;
  members?: GroupMember[];
};

export type CallPayload = {
  callId?: string;
  withVideo?: boolean;
  status?: 'active' | 'waiting' | 'ended' | string;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  outcome?: 'completed' | 'missed' | 'rejected' | 'cancelled' | 'expired' | string;
  reconnectUntil?: number;
};

export type GroupCallPayload = {
  type?: 'groupcall';
  status?: 'active' | 'ended' | string;
  callId?: string;
  startedBy?: number;
  startedAt?: number;
  endedAt?: number;
  withVideo?: boolean;
};

export type SystemPayload = {
  type?: 'group_created' | 'member_added' | 'member_removed' | 'member_left' | string;
  actorId?: number;
  targetIds?: number[];
};

export type MessageKind =
  | 'text'
  | 'voice'
  | 'image'
  | 'video'
  | 'file'
  | 'call'
  | 'system'
  | 'groupcall';

export type MessageReaction = {
  emoji: string;
  count: number;
  users: number[];
};

export type Message = {
  id: number;
  senderId: number;
  receiverId: number | null;
  groupId: number | null;
  content: string;
  createdAt: number;
  editedAt: number | null;
  deleted: boolean;
  kind: MessageKind;
  attachmentPath: string | null;
  durationMs: number | null;
  attachmentName: string | null;
  attachmentSize: number | null;
  attachmentMime: string | null;
  payload: CallPayload | GroupCallPayload | SystemPayload | null;
  reactions?: MessageReaction[];
};

export type AuthSession = {
  token: string;
  user: User;
};

export type Settings = {
  inputDeviceId: string;
  outputDeviceId: string;
  inputVolume: number;
  outputVolume: number;
  soundsEnabled: boolean;
  soundMessage: boolean;
  soundIncoming: boolean;
  soundOutgoing: boolean;
  soundConnect: boolean;
  soundDisconnect: boolean;
  soundMicMute: boolean;
  soundDeafen: boolean;
  uiVolume: number;
  userVolumes?: Record<number, number>;
  streamVolumes?: Record<number, number>;
  screenQuality?: string;
  // Карта десктоп-биндингов. Применяется только в Electron-обёртке;
  // в браузере поля просто хранятся в localStorage.
  keybinds?: {
    toggleMute?: string | null;
    toggleDeafen?: string | null;
  };
};

export type ChatSelection = { kind: 'user'; id: number } | { kind: 'group'; id: number };

export type UnreadMap = Record<string, number>;
export type UserIdMap<T> = Record<number, T>;

export type ApiOk = { ok: true };
export type ApiErrorBody = { error?: string };
export type ApiAck<T = unknown> = ({ ok: true } & T) | ({ error: string } & Partial<T>);

export type IceServerConfig = { iceServers: RTCIceServer[] };

export type MediaState = {
  mic: boolean;
  camera: boolean;
  screen: boolean;
  // true когда аудио-сендер сейчас транслирует звук экрана, а не микрофон.
  // Получатель смотрит на этот флаг, чтобы deafen глушил только голоса,
  // а для входящего трека применялась громкость стрима.
  screenAudio?: boolean;
};

export type CallState = 'idle' | 'calling' | 'incoming' | 'connecting' | 'in-call' | 'waiting';
export type GroupCallState = 'idle' | 'joining' | 'in-call';

export type ClientToServerEvents = {
  'chat:typing': (payload: { to?: number; groupId?: number; typing: boolean }) => void;
  'dm:send': (
    payload: { to?: number; groupId?: number; content: string },
    ack?: (ack: ApiAck<{ message?: Message }>) => void,
  ) => void;
  'call:invite': (payload: { to: number; callId: string; withVideo: boolean }) => void;
  'call:accept': (payload: { to: number; callId: string }) => void;
  'call:reject': (payload: { to: number; callId: string; reason?: string }) => void;
  'call:cancel': (payload: { to: number; callId: string }) => void;
  'call:end': (payload: { to: number; callId: string; reason?: string }) => void;
  'call:terminate': (payload: { to: number; callId: string }) => void;
  'rtc:offer': (payload: {
    to: number;
    callId: string;
    groupId?: number;
    sdp: RTCSessionDescription | null;
  }) => void;
  'rtc:answer': (payload: {
    to: number;
    callId: string;
    groupId?: number;
    sdp: RTCSessionDescription | null;
  }) => void;
  'rtc:ice': (payload: {
    to: number;
    callId: string;
    groupId?: number;
    candidate: RTCIceCandidate;
  }) => void;
  'media:state': (payload: { to: number; callId: string; state: MediaState }) => void;
  'groupcall:media:state': (payload: {
    groupId: number;
    callId: string;
    state: MediaState;
  }) => void;
  'groupcall:join': (
    payload: { groupId: number; withVideo: boolean },
    ack?: (
      ack: ApiAck<{ callId: string; peers: number[]; withVideo: boolean; startedBy: number }>,
    ) => void,
  ) => void;
  'groupcall:leave': (payload: { groupId: number }, ack?: (ack: ApiAck) => void) => void;
  'groupcall:state': (
    payload: { groupId: number },
    ack?: (
      ack:
        | { active: false }
        | {
            active: true;
            callId: string;
            withVideo: boolean;
            startedAt: number;
            startedBy: number;
            participants: number[];
          }
        | ApiErrorBody,
    ) => void,
  ) => void;
};

export type ServerToClientEvents = {
  connect: () => void;
  'presence:list': (payload: { online: number[] }) => void;
  presence: (payload: { userId: number; online: boolean }) => void;
  'dm:new': (message: Message) => void;
  'dm:update': (message: Message) => void;
  'dm:delete': (payload: {
    id: number;
    senderId: number;
    receiverId: number | null;
    groupId: number | null;
  }) => void;
  'dm:remove': (payload: {
    id: number;
    senderId: number;
    receiverId: number | null;
    groupId: number | null;
  }) => void;
  'dm:reaction': (payload: { messageId: number; reactions: MessageReaction[] }) => void;
  'chat:typing': (payload: { from: number; groupId?: number; typing: boolean }) => void;
  'profile:self': (user: User) => void;
  'mutes:update': (payload: { ids: number[] }) => void;
  'account:deleted': () => void;
  'group:new': (group: Group) => void;
  'group:update': (group: Group) => void;
  'group:delete': (payload: { id: number }) => void;
  'call:invite': (payload: {
    callId: string;
    withVideo: boolean;
    from: number;
    fromUsername: string;
    fromDisplayName?: string;
    fromAvatarPath?: string | null;
  }) => void;
  'call:invite:sent': (payload: { callId: string; calleeMuted: boolean }) => void;
  'call:accept': (payload: { from: number; callId: string }) => void;
  'call:reject': (payload: { from: number; callId: string; reason?: string }) => void;
  'call:cancel': (payload: { from: number; callId: string }) => void;
  'call:end': (payload: { from: number; callId: string; reason?: string }) => void;
  'call:terminate': (payload: { from: number; callId: string }) => void;
  'rtc:offer': (payload: {
    from: number;
    callId: string;
    groupId?: number;
    sdp: RTCSessionDescriptionInit;
  }) => void;
  'rtc:answer': (payload: {
    from: number;
    callId: string;
    groupId?: number;
    sdp: RTCSessionDescriptionInit;
  }) => void;
  'rtc:ice': (payload: {
    from: number;
    callId: string;
    groupId?: number;
    candidate: RTCIceCandidateInit;
  }) => void;
  'media:state': (payload: { from: number; callId: string; state: MediaState }) => void;
  'groupcall:media:state': (payload: {
    from: number;
    groupId: number;
    callId: string;
    state: MediaState;
  }) => void;
  'groupcall:active': (payload: {
    groupId: number;
    callId: string;
    startedBy: number;
    withVideo: boolean;
    startedAt: number;
  }) => void;
  'groupcall:ended': (payload: { groupId: number; callId: string }) => void;
  'groupcall:peer-joined': (payload: { groupId: number; callId: string; userId: number }) => void;
  'groupcall:peer-left': (payload: { groupId: number; callId: string; userId: number }) => void;
};

export type OwnCordSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
