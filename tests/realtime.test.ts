import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { io, type Socket } from 'socket.io-client';
import { createApp } from '../src/app';
import type { Message } from '../src/models/message';
import type { RoomAuthorizer } from '../src/services/room.service';
import type { ClientEvents, Presence, ServerEvents } from '../src/sockets/contracts';

type Client = Socket<ServerEvents, ClientEvents>;
const origin = 'http://localhost:5173';
const permissions: RoomAuthorizer = {
  async canAccess(roomId, uid) {
    return (roomId === 'A' && ['alice', 'bob'].includes(uid)) ||
      (roomId === 'B' && uid === 'carol');
  },
};

async function setup(t: TestContext, authorizer?: RoomAuthorizer) {
  const saved: Message[] = [];
  const app = createApp({
    origins: [origin],
    authorizer,
    async verifyToken(token) {
      if (!['alice', 'bob', 'carol'].includes(token)) throw new Error('detalle privado');
      return { uid: token };
    },
    messages: {
      async save(input) {
        if (input.content === 'fallo') throw new Error('detalle privado');
        const message = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
        saved.push(message);
        return message;
      },
    },
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

  return { url, client, connect, saved };
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
  for (const token of [undefined, 'inválido']) {
    await assert.rejects(connection(client(token)), {
      message: 'Autenticación requerida',
      data: { code: 'UNAUTHENTICATED' },
    });
  }
  await assert.rejects(connection(client('alice', 'https://otro.example')));
});

test('deniega salas por defecto y comprueba autorización por UID', { timeout: 5000 }, async t => {
  const defaultApp = await setup(t);
  const alice = await defaultApp.connect('alice');
  const denied = await alice.timeout(1000).emitWithAck('room:join', { roomId: 'A' });
  assert.equal(denied.ok ? null : denied.error.code, 'FORBIDDEN');

  const simulatedApp = await setup(t, permissions);
  const carol = await simulatedApp.connect('carol');
  const forbidden = await carol.timeout(1000).emitWithAck('room:join', { roomId: 'A', uid: 'alice' });
  assert.equal(forbidden.ok ? null : forbidden.error.code, 'FORBIDDEN');
});

test('entrada, salida y desconexión actualizan presencia por UID', { timeout: 5000 }, async t => {
  const { connect } = await setup(t, permissions);
  const alice = await connect('alice');
  const secondTab = await connect('alice');
  const bob = await connect('bob');

  assert.deepEqual(await alice.timeout(1000).emitWithAck('room:join', { roomId: 'A' }),
    { ok: true, data: { roomId: 'A' } });
  const duplicate = nextPresence(alice);
  assert.equal((await secondTab.timeout(1000).emitWithAck('room:join', { roomId: 'A' })).ok, true);
  assert.deepEqual(await duplicate, { roomId: 'A', users: ['alice'] });

  const arrival = nextPresence(alice);
  assert.equal((await bob.timeout(1000).emitWithAck('room:join', { roomId: 'A' })).ok, true);
  assert.deepEqual(await arrival, { roomId: 'A', users: ['alice', 'bob'] });

  const leave = nextPresence(alice);
  assert.equal((await bob.timeout(1000).emitWithAck('room:leave', { roomId: 'A' })).ok, true);
  assert.deepEqual(await leave, { roomId: 'A', users: ['alice'] });
  const outside = await bob.timeout(1000).emitWithAck('chat:send', { roomId: 'A', content: 'Hola' });
  assert.equal(outside.ok ? null : outside.error.code, 'NOT_JOINED');

  const disconnect = nextPresence(alice);
  secondTab.disconnect();
  assert.deepEqual(await disconnect, { roomId: 'A', users: ['alice'] });

  const rejoin = nextPresence(bob);
  assert.equal((await bob.timeout(1000).emitWithAck('room:join', { roomId: 'A' })).ok, true);
  await rejoin;
  const lastTab = nextPresence(bob);
  alice.disconnect();
  assert.deepEqual(await lastTab, { roomId: 'A', users: ['bob'] });
});

test('persiste antes de emitir y aísla mensajes entre salas', { timeout: 5000 }, async t => {
  const { connect, saved } = await setup(t, permissions);
  const alice = await connect('alice');
  const bob = await connect('bob');
  const carol = await connect('carol');
  for (const [client, roomId] of [[alice, 'A'], [bob, 'A'], [carol, 'B']] as const) {
    assert.equal((await client.timeout(1000).emitWithAck('room:join', { roomId })).ok, true);
  }

  const received: Message[] = [];
  carol.on('chat:message', message => received.push(message));
  const delivered = new Promise<Message>(resolve => bob.once('chat:message', resolve));
  const result = await alice.timeout(1000).emitWithAck('chat:send', {
    roomId: 'A', content: ' Hola ', authorUid: 'bob', createdAt: '1970-01-01',
  });
  assert.equal(result.ok, true);
  const message = await delivered;
  assert.deepEqual(saved, [message]);
  assert.deepEqual(result, { ok: true, data: message });
  assert.equal(message.authorUid, 'alice');
  assert.equal(message.content, 'Hola');
  assert.notEqual(message.createdAt, '1970-01-01');

  const afterFailure: Message[] = [];
  bob.on('chat:message', message => afterFailure.push(message));
  const rejected = await alice.timeout(1000).emitWithAck('chat:send', { roomId: 'A', content: 'fallo' });
  assert.equal(rejected.ok ? null : rejected.error.code, 'PERSISTENCE_ERROR');
  assert.equal(saved.length, 1);
  assert.equal((await bob.timeout(1000).emitWithAck('room:join', { roomId: 'A' })).ok, true);
  assert.deepEqual(afterFailure, []);

  // La confirmación en el mismo socket actúa como barrera para los paquetes anteriores.
  assert.equal((await carol.timeout(1000).emitWithAck('room:join', { roomId: 'B' })).ok, true);
  assert.deepEqual(received, []);
});
