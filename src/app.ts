import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { socketAuth, type TokenVerifier } from './middlewares/socket-auth.middleware';
import type { CompleteProfileCheck } from './services/profile.service';
import type { MessageStore } from './services/message.service';
import { denyRoomAccess, type RoomAuthorizer } from './services/room.service';
import type { RealtimeServer } from './sockets/contracts';
import { registerRoomHandlers } from './sockets/room.handlers';

interface AppOptions {
  origins: readonly string[];
  verifyToken: TokenVerifier;
  messages: MessageStore;
  hasCompleteProfile: CompleteProfileCheck;
  authorizer?: RoomAuthorizer;
}

export function createApp(options: AppOptions) {
  const http = createServer((request, response) => {
    const healthy = request.method === 'GET' && request.url === '/health';
    response.writeHead(healthy ? 200 : 404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(healthy ? { status: 'ok' } : { error: 'Not found' }));
  });
  const allowedOrigins = new Set(options.origins);
  const io: RealtimeServer = new Server(http, {
    cors: { origin: [...allowedOrigins] },
    allowRequest(request, accept) {
      const origin = request.headers.origin;
      accept(null, origin === undefined || allowedOrigins.has(origin));
    },
    maxHttpBufferSize: 32 * 1024,
  });

  const sessions = new Set<() => Promise<void>>();
  io.use(socketAuth(options.verifyToken, options.hasCompleteProfile));
  io.on('connection', socket => {
    const drain = registerRoomHandlers(io, socket, options.authorizer ?? denyRoomAccess, options.messages);
    sessions.add(drain);
    socket.on('disconnect', () => {
      void drain().finally(() => sessions.delete(drain));
    });
  });

  return {
    http,
    async close() {
      await io.close();
      await Promise.all([...sessions].map(drain => drain()));
    },
  };
}
