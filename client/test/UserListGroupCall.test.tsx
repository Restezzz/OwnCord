import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import UserList from '../src/components/UserList';

const users = [
  { id: 1, username: 'me', displayName: 'Me', online: true },
  { id: 2, username: 'bob', displayName: 'Bob', online: true },
];

const groups = [
  { id: 10, name: 'Alpha', members: [{ id: 1 }, { id: 2 }] },
  { id: 11, name: 'Beta',  members: [{ id: 1 }, { id: 2 }, { id: 3 }] },
];

describe('UserList — групповой звонок индикатор', () => {
  it('показывает «Идёт звонок» только в активной группе', () => {
    render(
      <UserList
        users={users}
        groups={groups}
        selfId={1}
        selected={null}
        activeGroupCalls={new Set([10])}
      />,
    );

    // Подпись «Идёт звонок» есть только у Alpha; у Beta — обычный «N участ.»
    const callLabels = screen.getAllByText('Идёт звонок');
    expect(callLabels).toHaveLength(1);
    // У Beta стандартная подпись с количеством участников.
    expect(screen.getByText(/3 участ\./)).toBeInTheDocument();
    // У Alpha — 2 участника, но этой подписи быть не должно, потому что её
    // вытеснила «Идёт звонок».
    expect(screen.queryByText(/2 участ\./)).toBeNull();
  });

  it('без активных звонков индикатор не показывается', () => {
    render(
      <UserList
        users={users}
        groups={groups}
        selfId={1}
        selected={null}
        activeGroupCalls={new Set()}
      />,
    );
    expect(screen.queryByText('Идёт звонок')).toBeNull();
    expect(screen.getByText(/2 участ\./)).toBeInTheDocument();
    expect(screen.getByText(/3 участ\./)).toBeInTheDocument();
  });

  it('устойчив к отсутствию пропса activeGroupCalls', () => {
    render(
      <UserList users={users} groups={groups} selfId={1} selected={null} />,
    );
    // Не падает и не показывает индикатор.
    expect(screen.queryByText('Идёт звонок')).toBeNull();
  });
});
