import { io } from 'socket.io-client';
import type { OwnCordSocket } from './types';

let socket: OwnCordSocket | null = null;

export function connectSocket(token: string): OwnCordSocket {
  if (socket && socket.connected) return socket;
  if (socket) socket.disconnect();
  socket = io('/', {
    auth: { token },
    transports: ['websocket', 'polling'],
    autoConnect: true,
  });
  return socket;
}

export function getSocket(): OwnCordSocket | null {
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
