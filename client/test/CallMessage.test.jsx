import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CallMessage from '../src/components/CallMessage.jsx';

const baseMsg = {
  id: 1,
  senderId: 1,
  receiverId: 2,
  createdAt: Date.now(),
  kind: 'call',
};

describe('CallMessage', () => {
  it('shows duration for completed call', () => {
    render(
      <CallMessage
        message={{
          ...baseMsg,
          payload: {
            callId: 'c1', withVideo: false, status: 'ended', outcome: 'completed', durationMs: 65000,
          },
        }}
        selfId={1}
      />,
    );
    expect(screen.getByText(/Звонок/)).toBeInTheDocument();
    expect(screen.getByText(/длительность 1:05/)).toBeInTheDocument();
  });

  it('shows missed for missed outgoing', () => {
    render(
      <CallMessage
        message={{
          ...baseMsg,
          payload: { callId: 'c2', withVideo: false, status: 'ended', outcome: 'missed' },
        }}
        selfId={1}
      />,
    );
    expect(screen.getByText(/не отвечен/)).toBeInTheDocument();
  });

  it('renders Rejoin button only when status=waiting and reconnect window is open', async () => {
    const onRejoin = vi.fn();
    render(
      <CallMessage
        message={{
          ...baseMsg,
          payload: {
            callId: 'c3',
            withVideo: true,
            status: 'waiting',
            startedAt: Date.now() - 10000,
            reconnectUntil: Date.now() + 60_000,
          },
        }}
        selfId={1}
        onRejoin={onRejoin}
      />,
    );
    const btn = screen.getByRole('button', { name: /Подключиться/i });
    expect(btn).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(btn);
    // Рут получает (callId, message) — message нужен, чтобы корректно
    // открыть нужный чат при reconnect.
    expect(onRejoin).toHaveBeenCalledTimes(1);
    expect(onRejoin.mock.calls[0][0]).toBe('c3');
  });

  it('does not render Rejoin when call already ended', () => {
    render(
      <CallMessage
        message={{
          ...baseMsg,
          payload: {
            callId: 'c4', withVideo: false, status: 'ended', outcome: 'expired',
          },
        }}
        selfId={1}
        onRejoin={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: /Подключиться/i })).toBeNull();
  });
});
