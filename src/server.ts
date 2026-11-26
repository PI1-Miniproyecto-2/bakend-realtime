import 'dotenv/config';
import { createApp } from './app';
import { readEnv } from './config/env';
import { createFirebase } from './config/firebase';
import { createMessageStore } from './services/message.service';
import { createCompleteProfileCheck } from './services/profile.service';
import { createRoomReader, FirestoreRoomAuthorizer } from './services/room.service';

async function start() {
  const { port, origins, projectId } = readEnv();
  const firebase = createFirebase(projectId);
  const app = createApp({
    origins,
    verifyToken: firebase.verifyToken,
    authorizer: new FirestoreRoomAuthorizer(createRoomReader(firebase.firestore)),
    hasCompleteProfile: createCompleteProfileCheck(firebase.firestore),
    messages: createMessageStore(firebase.firestore),
    firestore: firebase.firestore,
  });

  let shutdown: Promise<void> | undefined;
  function close() {
    shutdown ??= app.close().then(() => undefined).finally(firebase.close);
    return shutdown;
  }

  try {
    await new Promise<void>((resolve, reject) => {
      app.http.once('error', reject);
      app.http.listen(port, '0.0.0.0', () => {
        app.http.off('error', reject);
        resolve();
      });
    });
  } catch {
    await close();
    throw new Error('No se pudo abrir el puerto del servicio');
  }

  console.info(`Servicio de tiempo real escuchando en el puerto ${port}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void close().catch(() => {
        console.error('No se pudo completar el cierre del servicio');
        process.exitCode = 1;
      });
    });
  }
}

void start().catch(() => {
  console.error('No se pudo iniciar el servicio. Revisa la configuración y el puerto.');
  process.exitCode = 1;
});
