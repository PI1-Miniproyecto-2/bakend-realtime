
import {
  FieldPath,
  Timestamp,
  type Firestore,
} from 'firebase-admin/firestore';

import type {
  Message,
  NewMessage,
  MessageHistory,
  MessageHistoryInput,
} from '../models/message';

export const MESSAGE_HISTORY_LIMIT = 50;

export class InvalidHistoryCursorError extends Error {
  constructor() {
    super('Cursor de historial inválido');
  }
}

export interface MessageStore {
  save(input: NewMessage): Promise<Message>;
  history(input: MessageHistoryInput): Promise<MessageHistory>;
}

export function createMessageStore(
  firestore: Firestore
): MessageStore {
  return {
    // Funcionalidad existente: guardar mensajes.
    async save(input) {
      const ref = firestore
        .collection('realtime_messages')
        .doc();

      const createdAt = Timestamp.now();
      const message = { id: ref.id, ...input };

      await ref.create({ ...message, createdAt });

      return {
        ...message,
        createdAt: createdAt.toDate().toISOString(),
      };
    },

    // US-08-08: Consultar historial paginado.
    async history(input) {
      const { roomId, before } = input;

      const limit = input.limit ?? MESSAGE_HISTORY_LIMIT;

      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > MESSAGE_HISTORY_LIMIT
      ) {
        throw new RangeError('Límite de historial inválido');
      }

      const collection = firestore.collection(
        'realtime_messages'
      );

      let query = collection
        .where('roomId', '==', roomId)
        .orderBy('createdAt', 'desc')
        .orderBy(FieldPath.documentId(), 'desc');

      // Consultar mensajes anteriores al cursor.
      if (before !== undefined) {
        if (
          !/^[A-Za-z0-9_-]{1,128}$/.test(before)
        ) {
          throw new InvalidHistoryCursorError();
        }

        const cursor = await collection.doc(before).get();

        if (
          !cursor.exists ||
          cursor.get('roomId') !== roomId ||
          !(cursor.get('createdAt') instanceof Timestamp)
        ) {
          throw new InvalidHistoryCursorError();
        }

        query = query.startAfter(cursor);
      }

      // Consultamos un mensaje adicional para saber
      // si existen más páginas.
      const snapshot = await query
        .limit(limit + 1)
        .get();

      const hasMore = snapshot.docs.length > limit;
      const page = snapshot.docs.slice(0, limit);

      const messages: Message[] = page
        .map(doc => {
          const data = doc.data();

          return {
            id: doc.id,
            roomId: data.roomId,
            authorUid: data.authorUid,
            content: data.content,
            createdAt: (
              data.createdAt as Timestamp
            ).toDate().toISOString(),
          };
        })
        .reverse();

      return {
        roomId,
        messages,
        hasMore,
        nextCursor: hasMore
          ? page[page.length - 1].id
          : null,
      };
    },
  };
}
