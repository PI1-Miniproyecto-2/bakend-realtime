
import {
  InvalidHistoryCursorError,
  MESSAGE_HISTORY_LIMIT,
  type MessageStore,
} from '../services/message.service';

import {
  isRoomId,
  type RoomAuthorizer,
} from '../services/room.service';

import {
  RoomError,
  type RealtimeServer,
  type RealtimeSocket,
  type Reply,
} from './contracts';

function roomIdFrom(payload: unknown): string {
  const roomId =
    payload &&
    typeof payload === 'object' &&
    'roomId' in payload
      ? payload.roomId
      : undefined;

  if (!isRoomId(roomId)) {
    throw new RoomError('INVALID_ROOM');
  }

  return roomId;
}

// La sala interna no puede confundirse
// con la sala privada de un socket.
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

    for (
      const id of
      io.sockets.adapter.rooms.get(channel(roomId)) ?? []
    ) {
      const member = io.sockets.sockets.get(id);

      if (member) users.add(member.data.uid);
    }

    io.to(channel(roomId)).emit('room:users', {
      roomId,
      users: [...users],
    });
  }

  async function leaveRoom(roomId: string) {
    if (socket.rooms.has(channel(roomId))) {
      await socket.leave(channel(roomId));
      broadcastPresence(roomId);
    }
  }

  async function requireAccess(roomId: string) {
    const allowed =
      await socket.data.revalidate() &&
      await authorizer.canAccess(roomId, uid)
        .catch(() => false);

    if (!allowed) {
      await leaveRoom(roomId);
      throw new RoomError('FORBIDDEN');
    }
  }

  function handle<T>(
    ack: Reply<T> | undefined,
    operation: () => Promise<T>
  ) {
    // Conserva el orden de las operaciones
    // emitidas por este socket.
    pending = pending.then(async () => {
      if (!socket.connected) return;

      let data: T;

      try {
        data = await operation();
      } catch (cause) {
        if (!socket.connected) return;

        const failure =
          cause instanceof RoomError
            ? cause
            : new RoomError('INTERNAL_ERROR');

        const error = {
          code: failure.code,
          message: failure.message,
        };

        if (typeof ack === 'function') {
          ack({ ok: false, error });
        } else {
          socket.emit('room:error', error);
        }

        return;
      }

      if (
        socket.connected &&
        typeof ack === 'function'
      ) {
        ack({ ok: true, data });
      }
    });
  }

  // Ingreso a una sala.
  socket.on('room:join', (payload, ack) =>
    handle(ack, async () => {
      const roomId = roomIdFrom(payload);

      await requireAccess(roomId);

      if (socket.connected) {
        await socket.join(channel(roomId));
        broadcastPresence(roomId);
      }

      return { roomId };
    })
  );

  // Salida de una sala.
  socket.on('room:leave', (payload, ack) =>
    handle(ack, async () => {
      const roomId = roomIdFrom(payload);

      await leaveRoom(roomId);

      return { roomId };
    })
  );

  // Envío de mensajes.
  socket.on('chat:send', (payload, ack) =>
    handle(ack, async () => {
      const roomId = roomIdFrom(payload);

      const content =
        payload &&
        typeof payload === 'object' &&
        'content' in payload &&
        typeof payload.content === 'string'
          ? payload.content.trim()
          : '';

      if (!content || content.length > 2000) {
        throw new RoomError('INVALID_MESSAGE');
      }

      if (!socket.rooms.has(channel(roomId))) {
        throw new RoomError('NOT_JOINED');
      }

      await requireAccess(roomId);

      if (!socket.connected) {
        throw new RoomError('NOT_JOINED');
      }

      const message = await messages.save({
        roomId,
        authorUid: uid,
        content,
      }).catch(() => {
        throw new RoomError('PERSISTENCE_ERROR');
      });

      io.to(channel(roomId)).emit(
        'chat:message',
        message
      );

      return message;
    })
  );

  // US-08-08: Historial de mensajes paginado.
  socket.on('chat:history', (payload, ack) =>
    handle(ack, async () => {
      const roomId = roomIdFrom(payload);

      const input = payload as {
        limit?: unknown;
        before?: unknown;
      };

      const limit =
        input.limit === undefined
          ? MESSAGE_HISTORY_LIMIT
          : input.limit;

      const before = input.before;

      // Validar cantidad de mensajes.
      if (
        typeof limit !== 'number' ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > MESSAGE_HISTORY_LIMIT
      ) {
        throw new RoomError('INVALID_HISTORY_LIMIT');
      }

      // Validar cursor de paginación.
      if (
        before !== undefined &&
        (
          typeof before !== 'string' ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(before)
        )
      ) {
        throw new RoomError('INVALID_HISTORY_CURSOR');
      }

      // El usuario debe estar conectado a la sala.
      if (!socket.rooms.has(channel(roomId))) {
        throw new RoomError('NOT_JOINED');
      }

      // Verificar nuevamente identidad y permisos.
      await requireAccess(roomId);

      if (!socket.connected) {
        throw new RoomError('NOT_JOINED');
      }

      try {
        const history = await messages.history({
          roomId,
          limit,
          before,
        });

        // Revalidar permisos antes de entregar datos.
        await requireAccess(roomId);

        return history;
      } catch (cause) {
        if (cause instanceof RoomError) {
          throw cause;
        }

        if (
          cause instanceof InvalidHistoryCursorError
        ) {
          throw new RoomError(
            'INVALID_HISTORY_CURSOR'
          );
        }

        throw new RoomError('HISTORY_ERROR');
      }
    })
  );

  // Actualización de presencia al desconectarse.
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
