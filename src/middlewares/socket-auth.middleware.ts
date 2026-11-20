import type { RealtimeSocket } from '../sockets/contracts';

export type TokenVerifier = (token: string) => Promise<{ uid: string }>;

export function socketAuth(verifyToken: TokenVerifier) {
  return async (socket: RealtimeSocket, next: (error?: Error) => void) => {
    try {
      const token: unknown = socket.handshake.auth.token;
      if (typeof token !== 'string' || !token.trim()) {
        throw new Error('Token requerido');
      }
      const { uid } = await verifyToken(token);
      if (!uid) {
        throw new Error('Identidad inválida');
      }
      socket.data.uid = uid;
    } catch {
      next(Object.assign(new Error('Autenticación requerida'), {
        data: { code: 'UNAUTHENTICATED' },
      }));
      return;
    }
    next();
  };
}
