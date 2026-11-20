export interface Message {
  id: string;
  roomId: string;
  authorUid: string;
  content: string;
  createdAt: string;
}

export type NewMessage = Pick<Message, 'roomId' | 'authorUid' | 'content'>;
