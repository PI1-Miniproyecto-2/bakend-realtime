
import type { Firestore } from 'firebase-admin/firestore';
import type { RealtimeServer } from '../sockets/contracts';
import { isRoomId } from './room.service';

export function registerRoomEvents(
  io: RealtimeServer,
  firestore: Firestore,
) {
  const subscriptions = new Map<string, () => void>();
  const adapter = io.sockets.adapter;

  function stopWatching(channel: string) {
    const unsubscribe = subscriptions.get(channel);

    subscriptions.delete(channel);
    unsubscribe?.();
  }

  function watchRoom(channel: string) {
    if (!channel.startsWith('study:')) return;
    if (subscriptions.has(channel)) return;

    const roomId = channel.slice('study:'.length);

    if (!isRoomId(roomId)) return;

    let previousName: string | undefined;

    const unsubscribe = firestore
      .doc(`rooms/${roomId}`)
      .onSnapshot(
        snapshot => {
          const room = snapshot.data();

          // US-11: Notificar eliminación.
          if (!snapshot.exists || !room || room.status !== 'active') {
            io.to(channel).emit('room:deleted', {
              roomId,
            });

            io.in(channel).socketsLeave(channel);

            stopWatching(channel);
            return;
          }

          // Retirar participantes que perdieron el acceso.
          const allowed = new Set<string>();

          if (typeof room.ownerUid === 'string') {
            allowed.add(room.ownerUid);
          }

          if (Array.isArray(room.participantUids)) {
            for (const uid of room.participantUids) {
              if (typeof uid === 'string') {
                allowed.add(uid);
              }
            }
          }

          const members = [
            ...(adapter.rooms.get(channel) ?? []),
          ];

          for (const socketId of members) {
            const socket = io.sockets.sockets.get(socketId);

            if (socket && !allowed.has(socket.data.uid)) {
              socket.emit('room:error', {
                code: 'FORBIDDEN',
                message: 'Acceso a la sala denegado',
              });

              void socket.leave(channel);
            }
          }

          if (!subscriptions.has(channel)) return;

          // US-10: Notificar cambios en el nombre.
          if (
            typeof room.name === 'string' &&
            room.name !== previousName
          ) {
            previousName = room.name;

            io.to(channel).emit('room:updated', {
              roomId,
              name: room.name,
            });
          }

          const users = new Set<string>();

          for (const socketId of adapter.rooms.get(channel) ?? []) {
            const socket = io.sockets.sockets.get(socketId);

            if (socket) users.add(socket.data.uid);
          }

          io.to(channel).emit('room:users', {
            roomId,
            users: [...users],
          });
        },

        () => {
          console.error(
            'No se pudo observar el estado de una sala'
          );

          io.to(channel).emit('room:error', {
            code: 'INTERNAL_ERROR',
            message: 'No se pudo verificar el estado de la sala',
          });

          io.in(channel).socketsLeave(channel);
          stopWatching(channel);
        }
      );

    subscriptions.set(channel, unsubscribe);
  }

  adapter.on('join-room', watchRoom);
  adapter.on('delete-room', stopWatching);

  return function closeRoomEvents() {
    adapter.off('join-room', watchRoom);
    adapter.off('delete-room', stopWatching);

    for (const channel of subscriptions.keys()) {
      stopWatching(channel);
    }
  };
}
