import type { MessageStore } from '../services/message.service';
import type { RoomAuthorizer } from '../services/room.service';
import { RoomError, type RealtimeServer, type RealtimeSocket, type Reply } from './contracts';

function roomIdFrom(payload: unknown): string {
  const roomId = payload && typeof payload === 'object' && 'roomId' in payload
    ? payload.roomId
    : undefined;
  if (typeof roomId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(roomId) || roomId.trim() !== roomId) {
    throw new RoomError('INVALID_ROOM');
  }
  return roomId;
}

// La sala interna no puede confundirse con la sala privada de un socket.
const channel = (roomId: string) => `study:${roomId}`;

export function registerRoomHandlers(
  io: RealtimeServer,
  socket: RealtimeSocket,
  authorizer: RoomAuthorizer,
  messages: MessageStore,
) {
  const { uid } = socket.data;
  let pending = Promise.resolve();

  function broadcastPresence(roomId: string) {
    const users = new Set<string>();
    for (const id of io.sockets.adapter.rooms.get(channel(roomId)) ?? []) {
      const member = io.sockets.sockets.get(id);
      if (member) users.add(member.data.uid);
    }
    io.to(channel(roomId)).emit('room:users', { roomId, users: [...users] });
  }

  async function requireAccess(roomId: string) {
    if (!(await authorizer.canAccess(roomId, uid))) {
      throw new RoomError('FORBIDDEN');
    }
  }

  function handle<T>(ack: Reply<T>, operation: () => Promise<T>) {
    // Conserva el orden de las operaciones emitidas por este socket.
    pending = pending.then(async () => {
      if (!socket.connected) return;
      let data: T;
      try {
        data = await operation();
      } catch (cause) {
        if (!socket.connected) return;
        const failure = cause instanceof RoomError ? cause : new RoomError('INTERNAL_ERROR');
        const error = { code: failure.code, message: failure.message };
        if (typeof ack === 'function') ack({ ok: false, error });
        else socket.emit('room:error', error);
        return;
      }
      if (socket.connected && typeof ack === 'function') ack({ ok: true, data });
    });
  }

  socket.on('room:join', (payload, ack) => handle(ack, async () => {
    const roomId = roomIdFrom(payload);
    await requireAccess(roomId);
    if (socket.connected) {
      await socket.join(channel(roomId));
      broadcastPresence(roomId);
    }
    return { roomId };
  }));

  socket.on('room:leave', (payload, ack) => handle(ack, async () => {
    const roomId = roomIdFrom(payload);
    if (socket.rooms.has(channel(roomId))) {
      await socket.leave(channel(roomId));
      broadcastPresence(roomId);
    }
    return { roomId };
  }));

  socket.on('chat:send', (payload, ack) => handle(ack, async () => {
    const roomId = roomIdFrom(payload);
    const content = payload && typeof payload === 'object' && 'content' in payload
      && typeof payload.content === 'string' ? payload.content.trim() : '';
    if (!content || content.length > 2000) throw new RoomError('INVALID_MESSAGE');
    if (!socket.rooms.has(channel(roomId))) throw new RoomError('NOT_JOINED');
    await requireAccess(roomId);
    if (!socket.connected) throw new RoomError('NOT_JOINED');

    const message = await messages.save({ roomId, authorUid: uid, content }).catch(() => {
      throw new RoomError('PERSISTENCE_ERROR');
    });
    io.to(channel(roomId)).emit('chat:message', message);
    return message;
  }));

  let disconnectedRooms: string[] = [];
  socket.on('disconnecting', () => {
    disconnectedRooms = [...socket.rooms]
      .filter(name => name.startsWith('study:'))
      .map(name => name.slice('study:'.length));
  });
  socket.on('disconnect', () => {
    disconnectedRooms.forEach(broadcastPresence);
  });

  return () => pending;
}
