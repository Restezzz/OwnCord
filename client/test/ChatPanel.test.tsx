import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ChatPanel from '../src/components/ChatPanel';

const peer = {
  id: 2,
  username: 'bob',
  displayName: 'Bob',
  online: true,
};

const baseProps = {
  group: null,
  messages: [],
  selfId: 1,
  loading: false,
  onSend: vi.fn(),
  onSendVoice: vi.fn(),
  onSendFile: vi.fn(),
  onEditMessage: vi.fn(),
  onDeleteMessage: vi.fn(),
  onRejoinCall: vi.fn(),
  onCallAudio: vi.fn(),
  onCallVideo: vi.fn(),
  onBack: null,
  onShowProfile: vi.fn(),
  onShowGroupSettings: vi.fn(),
  onShowGroupMemberProfile: vi.fn(),
  onStartGroupCall: vi.fn(),
  onJoinGroupCall: vi.fn(),
  firstUnreadId: null,
  groupCallActive: false,
  inGroupCall: false,
  usersById: {},
};

describe('ChatPanel', () => {
  it('renders deleted peer chat as read-only', () => {
    render(
      <ChatPanel
        {...baseProps}
        peer={{ ...peer, deleted: true, username: null, displayName: null }}
      />,
    );

    expect(screen.getByText(/аккаунт был удалён/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Сообщение для/i)).toBeNull();
  });

  it('reports file-too-large through onSendFile callback', () => {
    const onSendFile = vi.fn();
    const { container } = render(
      <ChatPanel
        {...baseProps}
        peer={peer}
        onSendFile={onSendFile}
        maxFileBytes={4}
      />,
    );

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['too large'], 'large.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });

    expect(onSendFile).toHaveBeenCalledWith(null, { error: 'too-large', limit: 4 });
  });
});
