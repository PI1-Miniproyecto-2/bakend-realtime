
import type { Server, Socket } from 'socket.io';
import type { Message, MessageHistory } from '../models/message';

const messages = {
  INVALID_ROOM: 'Identificador de sala inválido',
  FORBIDDEN: 'Acceso a la sala denegado',
  NOT_JOINED: 'Debes entrar a la sala primero',
  INVALID_MESSAGE: 'El mensaje debe tener entre 1 y 2000 caracteres',
  INTERNAL_ERROR: 'No se pudo completar la operación',
  PERSISTENCE_ERROR: 'No se pudo guardar el mensaje',

  // US-08-08: Errores del historial.
  INVALID_HISTORY_LIMIT: 'El límite debe ser un número entero entre 1 y 50',
  INVALID_HISTORY_CURSOR: 'La referencia del historial es inválida',
  HISTORY_ERROR: 'No se pudo recuperar el historial de mensajes',
};

export class RoomError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
  }
}

export interface ErrorBody {
  code: keyof typeof messages;
  message: string;
}

export type Reply<T> = (
  result:
    | { ok: true; data: T }
    | { ok: false; error: ErrorBody }
) => void;

export interface RoomPayload {
  roomId: string;
}

export interface Presence extends RoomPayload {
  users: string[];
}

export interface ClientEvents {
  'room:join': (
    payload: unknown,
    ack?: Reply<RoomPayload>
  ) => void;

  'room:leave': (
    payload: unknown,
    ack?: Reply<RoomPayload>
  ) => void;

  'chat:send': (
    payload: unknown,
    ack?: Reply<Message>
  ) => void;

  // US-08-08: Solicitar historial paginado.
  'chat:history': (
    payload: unknown,
    ack?: Reply<MessageHistory>
  ) => void;
}

export interface ServerEvents {
  'chat:message': (message: Message) => void;
  'room:users': (presence: Presence) => void;
  'room:error': (error: ErrorBody) => void;
}

interface Session {
  uid: string;
  revalidate: () => Promise<boolean>;
}

export type RealtimeServer = Server<
  ClientEvents,
  ServerEvents,
  Record<never, never>,
  Session
>;

export type RealtimeSocket = Socket<
  ClientEvents,
  ServerEvents,
  Record<never, never>,
  Session
>;
