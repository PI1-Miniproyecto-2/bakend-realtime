import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { io, type Socket } from 'socket.io-client';
import { createApp } from '../src/app';
import type { Message } from '../src/models/message';
import { createMessageStore } from '../src/services/message.service';
import { createCompleteProfileCheck } from '../src/services/profile.service';
import { createRoomReader, FirestoreRoomAuthorizer } from '../src/services/room.service';
import type { ClientEvents, Presence, ServerEvents } from '../src/sockets/contracts';

type Client = Socket<ServerEvents, ClientEvents>;
const origin = 'http://localhost:5173';
const roomA = 'A'.repeat(20);
const roomB = 'B'.repeat(20);
const inactiveRoom = 'C'.repeat(20);
const malformedRoom = 'D'.repeat(20);
const missingRoom = 'E'.repeat(20);
const unavailableRoom = 'F'.repeat(20);

async function setup(t: TestContext, useDefaultAuthorizer = false) {
  const documents = new Map<string, Record<string, unknown>>();
  const saved: Record<string, unknown>[] = [];
  const roomReads: string[] = [];
  const revoked = new Set(['revoked']);
  for (const uid of ['alice', 'bob', 'carol', 'incomplete']) {
    documents.set(`users/${uid}`, {
      firstName: 'Nombre', lastName: 'Apellido', username: uid, usernameNormalized: uid,
      email: `${uid}@example.test`, avatarId: 'avatar_book', authProvider: 'password',
      profileCompleted: uid !== 'incomplete', createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
    });
    documents.set(`usernames/${uid}`, { uid });
  }
  const room = (ownerUid: string, participantUids: string[]) => ({
    name: 'Sala de estudio', ownerUid, participantUids, createdAt: Timestamp.now(), status: 'active',
  });
  documents.set(`rooms/${roomA}`, room('alice', ['bob']));
  documents.set(`rooms/${roomB}`, room('carol', ['carol']));
  documents.set(`rooms/${inactiveRoom}`, { ...room('alice', []), status: 'inactive' });
  documents.set(`rooms/${malformedRoom}`, { ...room('alice', []), participantUids: [false] });

  const db = {
    doc(path: string) {
      return {
        path,
        async get() {
          if (path.startsWith('rooms/')) roomReads.push(path);
          if (path === `rooms/${unavailableRoom}`) throw new Error('detalle privado');
          return { data: () => documents.get(path) };
        },
      };
    },
    collection(path: string) {
      assert.ok(['usernames', 'realtime_messages'].includes(path));
      return {
        where(field: string, operator: string, uid: string) {
          assert.deepEqual([field, operator], ['uid', '==']);
          return { uid };
        },
        doc() {
          assert.equal(path, 'realtime_messages');
          return {
            id: randomUUID(),
            async create(message: Record<string, unknown>) {
              if (message.content === 'fallo') throw new Error('detalle privado');
              saved.push(message);
            },
          };
        },
      };
    },
    async runTransaction<T>(fn: (tx: {
      get: (ref: { get?: () => Promise<unknown>; uid?: string }) => Promise<unknown>;
    }) => Promise<T>) {
      return fn({
        async get(ref) {
          if (ref.get) return ref.get();
          return { docs: [...documents].filter(([path, data]) =>
            path.startsWith('usernames/') && data.uid === ref.uid).map(([path]) => ({ ref: { path } })) };
        },
      });
    },
  } as unknown as Firestore;
  const authorizer = new FirestoreRoomAuthorizer(createRoomReader(db));
  const app = createApp({
    origins: [origin],
    authorizer: useDefaultAuthorizer ? undefined : authorizer,
    hasCompleteProfile: createCompleteProfileCheck(db),
    async verifyToken(token) {
      if (revoked.has(token) || !['alice', 'bob', 'carol', 'incomplete', 'deleted', 'tenant', 'anonymous'].includes(token)) {
        throw new Error('detalle privado');
      }
      return {
        uid: ['tenant', 'anonymous'].includes(token) ? 'alice' : token,
        firebase: {
          tenant: token === 'tenant' ? 'otro' : undefined,
          sign_in_provider: token === 'anonymous' ? 'anonymous' : 'password',
        },
      };
    },
    messages: createMessageStore(db),
  });
  const clients: Client[] = [];
  t.after(async () => {
    clients.forEach(client => client.disconnect());
    await app.close();
  });
  await new Promise<void>((resolve, reject) => {
    app.http.once('error', reject);
    app.http.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${(app.http.address() as AddressInfo).port}`;

  function client(token?: string, requestOrigin = origin) {
    const socket: Client = io(url, {
      autoConnect: false,
      forceNew: true,
      reconnection: false,
      transports: ['websocket'],
      extraHeaders: { Origin: requestOrigin },
      auth: { token, uid: 'suplantado' },
    });
    clients.push(socket);
    return socket;
  }

  async function connect(token: string) {
    const socket = client(token);
    await connection(socket);
    return socket;
  }

  return { url, client, connect, saved, documents, roomReads, revoked };
}

function connection(client: Client) {
  return new Promise<void>((resolve, reject) => {
    client.once('connect', resolve);
    client.once('connect_error', reject);
    client.connect();
  });
}

const nextPresence = (client: Client) =>
  new Promise<Presence>(resolve => client.once('room:users', resolve));

test('GET /health responde con JSON', { timeout: 5000 }, async t => {
  const { url } = await setup(t);
  const response = await fetch(`${url}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('autentica un token válido y rechaza tokens ausentes o inválidos', { timeout: 5000 }, async t => {
  const { client, connect } = await setup(t);
  assert.equal((await connect('alice')).connected, true);
  for (const token of [undefined, 'inválido', 'tenant', 'incomplete', 'deleted', 'revoked', 'anonymous']) {
    await assert.rejects(connection(client(token)), {
      message: 'Autenticación requerida',
      data: { code: 'UNAUTHENTICATED' },
    });
  }
  await assert.rejects(connection(client('alice', 'https://otro.example')));
});

test('deniega salas por defecto y comprueba autorización por UID', { timeout: 5000 }, async t => {
  const defaultApp = await setup(t, true);
  const alice = await defaultApp.connect('alice');
  const denied = await alice.timeout(1000).emitWithAck('room:join', { roomId: roomA });
  assert.equal(denied.ok ? null : denied.error.code, 'FORBIDDEN');

  const simulatedApp = await setup(t);
  const carol = await simulatedApp.connect('carol');
  const forbidden = await carol.timeout(1000).emitWithAck('room:join', { roomId: roomA, uid: 'alice' });
  assert.equal(forbidden.ok ? null : forbidden.error.code, 'FORBIDDEN');
  const owner = await simulatedApp.connect('alice');
  for (const roomId of [missingRoom, inactiveRoom, malformedRoom, unavailableRoom]) {
    const result = await owner.timeout(1000).emitWithAck('room:join', { roomId });
    assert.equal(result.ok ? null : result.error.code, 'FORBIDDEN');
  }
  const count = simulatedApp.roomReads.length;
  const invalid = await owner.timeout(1000).emitWithAck('room:join', { roomId: '../users/alice' });
  assert.equal(invalid.ok ? null : invalid.error.code, 'INVALID_ROOM');
  assert.equal(simulatedApp.roomReads.length, count);
});

test('entrada, salida y desconexión actualizan presencia por UID', { timeout: 5000 }, async t => {
  const { connect } = await setup(t);
  const alice = await connect('alice');
  const secondTab = await connect('alice');
  const bob = await connect('bob');

  assert.deepEqual(await alice.timeout(1000).emitWithAck('room:join', { roomId: roomA }),
    { ok: true, data: { roomId: roomA } });
  const duplicate = nextPresence(alice);
  assert.equal((await secondTab.timeout(1000).emitWithAck('room:join', { roomId: roomA })).ok, true);
  assert.deepEqual(await duplicate, { roomId: roomA, users: ['alice'] });

  const arrival = nextPresence(alice);
  assert.equal((await bob.timeout(1000).emitWithAck('room:join', { roomId: roomA })).ok, true);
  assert.deepEqual(await arrival, { roomId: roomA, users: ['alice', 'bob'] });

  const leave = nextPresence(alice);
  assert.equal((await bob.timeout(1000).emitWithAck('room:leave', { roomId: roomA })).ok, true);
  assert.deepEqual(await leave, { roomId: roomA, users: ['alice'] });
  assert.equal((await bob.timeout(1000).emitWithAck('room:leave', { roomId: roomA })).ok, true);
  const outside = await bob.timeout(1000).emitWithAck('chat:send', { roomId: roomA, content: 'Hola' });
  assert.equal(outside.ok ? null : outside.error.code, 'NOT_JOINED');

  const disconnect = nextPresence(alice);
  secondTab.disconnect();
  assert.deepEqual(await disconnect, { roomId: roomA, users: ['alice'] });

  const rejoin = nextPresence(bob);
  assert.equal((await bob.timeout(1000).emitWithAck('room:join', { roomId: roomA })).ok, true);
  await rejoin;
  const lastTab = nextPresence(bob);
  alice.disconnect();
  assert.deepEqual(await lastTab, { roomId: roomA, users: ['bob'] });
});

test('persiste antes de emitir y aísla mensajes entre salas', { timeout: 5000 }, async t => {
  const { connect, saved } = await setup(t);
  const alice = await connect('alice');
  const bob = await connect('bob');
  const carol = await connect('carol');
  for (const [client, roomId] of [[alice, roomA], [bob, roomA], [carol, roomB]] as const) {
    assert.equal((await client.timeout(1000).emitWithAck('room:join', { roomId })).ok, true);
  }

  const received: Message[] = [];
  carol.on('chat:message', message => received.push(message));
  const delivered = new Promise<{ message: Message; stored: Record<string, unknown> }>(resolve =>
    bob.once('chat:message', message => resolve({ message, stored: saved[0] })));
  const result = await alice.timeout(1000).emitWithAck('chat:send', {
    roomId: roomA, content: ' Hola ', authorUid: 'bob', createdAt: '1970-01-01',
  });
  assert.equal(result.ok, true);
  const { message, stored } = await delivered;
  assert.ok(stored.createdAt instanceof Timestamp);
  assert.deepEqual({ ...stored, createdAt: stored.createdAt.toDate().toISOString() }, message);
  assert.equal(saved.length, 1);
  assert.deepEqual(result, { ok: true, data: message });
  assert.equal(message.authorUid, 'alice');
  assert.equal(message.content, 'Hola');
  assert.notEqual(message.createdAt, '1970-01-01');

  const afterFailure: Message[] = [];
  bob.on('chat:message', message => afterFailure.push(message));
  const rejected = await alice.timeout(1000).emitWithAck('chat:send', { roomId: roomA, content: 'fallo' });
  assert.equal(rejected.ok ? null : rejected.error.code, 'PERSISTENCE_ERROR');
  assert.equal(saved.length, 1);
  assert.equal((await bob.timeout(1000).emitWithAck('room:join', { roomId: roomA })).ok, true);
  assert.deepEqual(afterFailure, []);

  // La confirmación en el mismo socket actúa como barrera para los paquetes anteriores.
  assert.equal((await carol.timeout(1000).emitWithAck('room:join', { roomId: roomB })).ok, true);
  assert.deepEqual(received, []);

  const reverse = new Promise<Message>(resolve => alice.once('chat:message', resolve));
  assert.equal((await bob.timeout(1000).emitWithAck('chat:send', { roomId: roomA, content: 'Respuesta' })).ok, true);
  assert.equal((await reverse).authorUid, 'bob');
  assert.equal(saved.length, 2);
});

test('valida el contenido y entrega un error seguro sin callback', { timeout: 5000 }, async t => {
  const { connect, saved } = await setup(t);
  const alice = await connect('alice');
  for (const content of ['   ', 'x'.repeat(2001), 123]) {
    const result = await alice.timeout(1000).emitWithAck('chat:send', { roomId: roomA, content });
    assert.equal(result.ok ? null : result.error.code, 'INVALID_MESSAGE');
  }
  const error = new Promise(resolve => alice.once('room:error', resolve));
  alice.emit('chat:send', { roomId: roomA, content: 'Hola' });
  assert.deepEqual(await error, { code: 'NOT_JOINED', message: 'Debes entrar a la sala primero' });
  assert.equal(saved.length, 0);
});

test('expulsa al detectar pérdida de membresía, perfil o token', { timeout: 5000 }, async t => {
  const { connect, documents, revoked, saved } = await setup(t);
  const alice = await connect('alice');
  const bob = await connect('bob');
  const path = `rooms/${roomA}`;
  const room = documents.get(path)!;
  const profile = documents.get('users/bob')!;
  assert.equal((await alice.timeout(1000).emitWithAck('room:join', { roomId: roomA })).ok, true);

  for (const [deny, restore] of [
    [() => documents.set(path, { ...room, participantUids: [] }), () => documents.set(path, room)],
    [() => documents.delete('users/bob'), () => documents.set('users/bob', profile)],
    [() => revoked.add('bob'), () => revoked.delete('bob')],
  ]) {
    const arrival = nextPresence(alice);
    assert.equal((await bob.timeout(1000).emitWithAck('room:join', { roomId: roomA })).ok, true);
    await arrival;
    deny();
    const departure = nextPresence(alice);
    const rejected = await bob.timeout(1000).emitWithAck('chat:send', { roomId: roomA, content: 'Bloqueado' });
    assert.equal(rejected.ok ? null : rejected.error.code, 'FORBIDDEN');
    assert.deepEqual(await departure, { roomId: roomA, users: ['alice'] });
    restore();
    const outside = await bob.timeout(1000).emitWithAck('chat:send', { roomId: roomA, content: 'Bloqueado' });
    assert.equal(outside.ok ? null : outside.error.code, 'NOT_JOINED');
  }
  assert.equal(saved.length, 0);
  assert.equal((await alice.timeout(1000).emitWithAck('chat:send', { roomId: roomA, content: 'Sigo aquí' })).ok, true);
});

test('rechaza un perfil completo con reserva inconsistente', { timeout: 5000 }, async t => {
  const { client, documents } = await setup(t);
  documents.set('usernames/duplicado', { uid: 'alice' });
  await assert.rejects(connection(client('alice')), {
    message: 'Autenticación requerida',
    data: { code: 'UNAUTHENTICATED' },
  });
});

test('persiste envíos simultáneos y limita la presencia a la sala', { timeout: 5000 }, async t => {
  const { connect, saved } = await setup(t);
  const [alice, bob, carol] = await Promise.all(['alice', 'bob', 'carol'].map(connect));
  assert.equal((await carol.timeout(1000).emitWithAck('room:join', { roomId: roomB })).ok, true);
  const presence: Presence[] = [];
  carol.on('room:users', update => presence.push(update));
  for (const socket of [alice, bob]) {
    assert.equal((await socket.timeout(1000).emitWithAck('room:join', { roomId: roomA })).ok, true);
  }

  const received: Message[] = [];
  const delivered = new Promise<void>(resolve => bob.on('chat:message', message => {
    received.push(message);
    if (received.length === 2) resolve();
  }));
  const results = await Promise.all([
    alice.timeout(1000).emitWithAck('chat:send', { roomId: roomA, content: 'Hola' }),
    bob.timeout(1000).emitWithAck('chat:send', { roomId: roomA, content: 'Qué tal' }),
  ]);
  await delivered;
  assert.ok(results.every(result => result.ok));
  assert.deepEqual(new Set(received.map(message => message.id)), new Set(saved.map(message => message.id)));
  assert.equal(new Set(received.map(message => message.id)).size, 2);
  await carol.timeout(1000).emitWithAck('room:leave', { roomId: roomB });
  assert.deepEqual(presence, []);
});
