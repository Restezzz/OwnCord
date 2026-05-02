import { colorFor, initialsFor } from '../utils/avatar';

type AvatarProps = {
  name?: string | null;
  src?: string | null;
  size?: number;
  online?: boolean;
  showStatus?: boolean;
};

export default function Avatar({ name = '', src, size = 36, online, showStatus = false }: AvatarProps) {
  const bg = colorFor(name);
  const fontSize = Math.round(size * 0.4);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      {src ? (
        <img
          src={src}
          alt={name}
          className="avatar object-cover"
          style={{ width: size, height: size }}
          draggable={false}
        />
      ) : (
        <div
          className="avatar"
          style={{
            width: size,
            height: size,
            background: `linear-gradient(135deg, ${bg}, ${bg}cc)`,
            fontSize,
          }}
        >
          {initialsFor(name)}
        </div>
      )}
      {showStatus && (
        <span
          className={`absolute bottom-0 right-0 rounded-full ring-2 ring-bg-1 ${
            online ? 'bg-success' : 'bg-slate-500'
          }`}
          style={{ width: Math.max(10, size * 0.28), height: Math.max(10, size * 0.28) }}
        />
      )}
    </div>
  );
}
