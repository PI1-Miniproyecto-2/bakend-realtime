import type { CompleteProfileCheck } from '../services/profile.service';
import type { RealtimeSocket } from '../sockets/contracts';

export type TokenVerifier = (token: string) => Promise<{
  uid: string;
  firebase: { tenant?: string; sign_in_provider: string };
}>;

export function socketAuth(verifyToken: TokenVerifier, hasCompleteProfile: CompleteProfileCheck) {
  return async (socket: RealtimeSocket, next: (error?: Error) => void) => {
    const token: unknown = socket.handshake.auth.token;

    async function verifyIdentity() {
      if (typeof token !== 'string' || !token.trim()) throw new Error('Token requerido');
      const { uid, firebase } = await verifyToken(token);
      if (!uid || uid.includes('/') || firebase.tenant !== undefined ||
          !['password', 'google.com'].includes(firebase.sign_in_provider) ||
          !(await hasCompleteProfile(uid))) throw new Error('Identidad no autorizada');
      return uid;
    }

    try {
      const uid = await verifyIdentity();
      socket.data.uid = uid;
      socket.data.revalidate = async () => {
        try {
          return await verifyIdentity() === uid;
        } catch {
          return false;
        }
      };
    } catch {
      next(Object.assign(new Error('Autenticación requerida'), {
        data: { code: 'UNAUTHENTICATED' },
      }));
      return;
    }
    next();
  };
}
