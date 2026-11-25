
export interface Message {
  id: string;
  roomId: string;
  authorUid: string;
  content: string;
  createdAt: string;
}

export type NewMessage = Pick<
  Message,
  'roomId' | 'authorUid' | 'content'
>;

// US-08-08: Solicitud de historial de mensajes.
export interface MessageHistoryInput {
  roomId: string;
  limit?: number;
  before?: string;
}

// US-08-08: Respuesta paginada del historial.
export interface MessageHistory {
  roomId: string;
  messages: Message[];
  hasMore: boolean;
  nextCursor: string | null;
}
