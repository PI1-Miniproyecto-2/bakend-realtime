import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import type { Message, NewMessage } from '../models/message';

export interface MessageStore {
  save(input: NewMessage): Promise<Message>;
}

export function createMessageStore(firestore: Firestore): MessageStore {
  return {
    async save(input) {
      const ref = firestore.collection('realtime_messages').doc();
      const createdAt = Timestamp.now();
      const message = { id: ref.id, ...input };
      await ref.create({ ...message, createdAt });
      return { ...message, createdAt: createdAt.toDate().toISOString() };
    },
  };
}
