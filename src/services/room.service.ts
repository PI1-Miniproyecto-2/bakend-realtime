import { Timestamp, type Firestore } from 'firebase-admin/firestore';

export interface RoomAuthorizer {
  canAccess(roomId: string, uid: string): Promise<boolean>;
}

export const denyRoomAccess: RoomAuthorizer = {
  async canAccess() {
    return false;
  },
};

export function isRoomId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 20 && /^[A-Za-z0-9]{20}$/.test(value);
}

type RoomReader = (roomId: string) => Promise<Record<string, unknown> | undefined>;

export function createRoomReader(db: Pick<Firestore, 'doc'>): RoomReader {
  return async roomId => (await db.doc(`rooms/${roomId}`).get()).data();
}

export class FirestoreRoomAuthorizer implements RoomAuthorizer {
  constructor(private readonly readRoom: RoomReader) {}

  async canAccess(roomId: string, uid: string): Promise<boolean> {
    if (!isRoomId(roomId) || !uid) return false;

    try {
      const room = await this.readRoom(roomId);
      if (!room || room.status !== 'active') return false;

      const { name, ownerUid, participantUids, createdAt } = room;
      if (typeof name !== 'string' || name !== name.trim() || name.length < 1 || name.length > 100 ||
          typeof ownerUid !== 'string' || ownerUid.length === 0 ||
          !Array.isArray(participantUids) ||
          !participantUids.every(value => typeof value === 'string' && value.length > 0) ||
          !(createdAt instanceof Timestamp)) return false;

      return ownerUid === uid || participantUids.includes(uid);
    } catch {
      return false;
    }
  }
}
