import { Phone, PhoneOff, Video } from 'lucide-react';
import Avatar from './Avatar.jsx';
import { getAvatarUrl, getDisplayName, hasCustomDisplayName } from '../utils/user.js';

export default function IncomingCallModal({ call }) {
  if (call.state !== 'incoming') return null;
  const { peer, withVideo, accept, reject } = call;
  const name = getDisplayName(peer);
  const avatarUrl = getAvatarUrl(peer);

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm grid place-items-center p-6">
      <div className="card w-full max-w-sm p-6 flex flex-col items-center text-center">
        <div className="pulse-ring rounded-full mb-4">
          <Avatar name={name} src={avatarUrl} size={88} />
        </div>
        <div className="text-xs uppercase tracking-wider text-slate-400 mb-1">
          Входящий {withVideo ? 'видео-звонок' : 'звонок'}
        </div>
        <div className="text-xl font-semibold">{name}</div>
        {hasCustomDisplayName(peer) && (
          <div className="text-sm text-slate-500 mb-6">@{peer.username}</div>
        )}
        {!hasCustomDisplayName(peer) && <div className="mb-6" />}

        <div className="flex items-center justify-center gap-8">
          <button
            onClick={reject}
            className="btn-icon bg-danger hover:bg-danger-hover text-white"
            style={{ width: 56, height: 56 }}
            title="Отклонить"
          >
            <PhoneOff size={22} />
          </button>
          <button
            onClick={accept}
            className="btn-icon bg-success hover:bg-green-500 text-white"
            style={{ width: 56, height: 56 }}
            title="Принять"
          >
            {withVideo ? <Video size={22} /> : <Phone size={22} />}
          </button>
        </div>
      </div>
    </div>
  );
}
