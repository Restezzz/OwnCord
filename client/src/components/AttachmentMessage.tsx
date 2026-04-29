import { useState } from 'react';
import { File as FileIcon, Download, ExternalLink } from 'lucide-react';

function formatBytes(b) {
  if (!b && b !== 0) return '';
  if (b < 1024) return `${b} Б`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} КБ`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} МБ`;
  return `${(b / 1024 / 1024 / 1024).toFixed(1)} ГБ`;
}

/**
 * Превью прикреплённого файла внутри сообщения.
 * Поддерживает kind ∈ { 'image', 'video', 'file' }.
 *
 * У image/video — оверлей с кнопками "Скачать" и "Открыть в новой вкладке",
 * появляется при наведении/тапе.
 */
export default function AttachmentMessage({ message, mine }) {
  const { kind, attachmentPath, attachmentName, attachmentSize, attachmentMime } = message;
  const [imgZoom, setImgZoom] = useState(false);

  if (!attachmentPath) return null;

  const fileName = attachmentName || 'file';

  if (kind === 'image') {
    return (
      <>
        <div className="group relative inline-block max-w-xs rounded-lg overflow-hidden">
          <button
            type="button"
            className="block cursor-zoom-in"
            onClick={() => setImgZoom(true)}
            title={fileName}
          >
            <img
              src={attachmentPath}
              alt={fileName}
              className="block max-h-64 w-auto object-contain"
              loading="lazy"
            />
          </button>
          <MediaActions path={attachmentPath} name={fileName} />
        </div>
        {imgZoom && (
          <div
            className="fixed inset-0 z-[90] bg-black/85 grid place-items-center p-4 cursor-zoom-out"
            onClick={() => setImgZoom(false)}
            role="dialog"
          >
            <img
              src={attachmentPath}
              alt={fileName}
              className="max-h-[90vh] max-w-[95vw] object-contain"
            />
            <div
              className="absolute top-4 right-4 flex items-center gap-2"
              onClick={(e) => e.stopPropagation()}
            >
              <OpenButton path={attachmentPath} />
              <DownloadButton path={attachmentPath} name={fileName} />
            </div>
          </div>
        )}
      </>
    );
  }

  if (kind === 'video') {
    return (
      <div className="group relative inline-block max-w-xs rounded-lg overflow-hidden">
        <video
          src={attachmentPath}
          controls
          className="block max-h-72 max-w-xs bg-black"
        >
          <track kind="captions" />
        </video>
        <MediaActions path={attachmentPath} name={fileName} />
      </div>
    );
  }

  return (
    <a
      href={attachmentPath}
      download={fileName}
      target="_blank"
      rel="noopener noreferrer"
      className={`flex items-center gap-3 rounded-lg px-3 py-2 max-w-[280px] no-underline transition-colors
        ${mine ? 'bg-white/10 hover:bg-white/20' : 'bg-bg-3 hover:bg-bg-2'}`}
      title={attachmentMime || ''}
    >
      <span className={`grid place-items-center w-9 h-9 rounded-md shrink-0
        ${mine ? 'bg-white/15' : 'bg-bg-2'}`}
      >
        <FileIcon size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm truncate">{fileName}</div>
        <div className="text-[11px] opacity-70">{formatBytes(attachmentSize)}</div>
      </div>
      <Download size={14} className="shrink-0 opacity-70" />
    </a>
  );
}

/* ---------- внутренние компоненты ---------- */

function MediaActions({ path, name }) {
  return (
    <div
      className="absolute top-1.5 right-1.5 flex items-center gap-1
                 opacity-0 group-hover:opacity-100 focus-within:opacity-100
                 transition-opacity"
      onClick={(e) => e.stopPropagation()}
    >
      <OpenButton path={path} />
      <DownloadButton path={path} name={name} />
    </div>
  );
}

function OpenButton({ path }) {
  return (
    <a
      href={path}
      target="_blank"
      rel="noopener noreferrer"
      title="Открыть в новой вкладке"
      className="inline-grid place-items-center w-8 h-8 rounded-md bg-black/60 hover:bg-black/80 text-white"
    >
      <ExternalLink size={14} />
    </a>
  );
}

function DownloadButton({ path, name }) {
  return (
    <a
      href={path}
      download={name}
      title="Скачать"
      className="inline-grid place-items-center w-8 h-8 rounded-md bg-black/60 hover:bg-black/80 text-white"
    >
      <Download size={14} />
    </a>
  );
}
