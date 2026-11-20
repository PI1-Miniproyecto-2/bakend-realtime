# Salón de Estudio Colaborativo · Servicio de tiempo real

TS-02, base de Socket.IO para salas, presencia y chat. Requiere Node.js 20 o superior.

## Ejecución local

1. Ejecuta `npm ci` y copia `.env.example` a `.env`.
2. Configura `FIREBASE_PROJECT_ID` y las credenciales predeterminadas de aplicación (ADC) del mismo proyecto Firebase que usa el frontend. Si usas `GOOGLE_APPLICATION_CREDENTIALS`, apunta a un archivo fuera del repositorio.
3. Ejecuta `npm run dev`. Para ejecutar la compilación, usa `npm run build` y `npm start`.

`PORT` vale 3001 por defecto. `CORS_ORIGINS` acepta una lista de orígenes HTTP(S) exactos separados por comas y es obligatorio en producción. Las conexiones sin encabezado `Origin` también deben autenticarse. En desarrollo el origen predeterminado es `http://localhost:5173`.

`GET /health` devuelve `200 {"status":"ok"}` cuando el proceso responde. Es una comprobación de disponibilidad HTTP. `npm run typecheck` comprueba el servicio y las pruebas. `npm test` ejecuta las pruebas locales con autenticación, autorización y persistencia simuladas.

## Contrato Socket.IO

El cliente conecta con `auth: { token: firebaseIdToken }`. Firebase Admin verifica el token y comprueba su revocación al conectar. El UID se toma del token verificado. El rechazo se recibe como `connect_error` con `data.code = "UNAUTHENTICATED"`.

| Evento | Dirección | Datos y resultado |
| --- | --- | --- |
| `room:join` | Cliente → servidor | `{roomId}`. Verifica acceso y confirma con `{roomId}`. |
| `room:leave` | Cliente → servidor | `{roomId}`. La salida es idempotente y confirma con `{roomId}`. |
| `chat:send` | Cliente → servidor | `{roomId, content}`. Exige pertenencia y autorización. Confirma con el mensaje guardado. |
| `chat:message` | Servidor → sala | `{id, roomId, authorUid, content, createdAt}`. Incluye al emisor entre los destinatarios. |
| `room:users` | Servidor → sala | `{roomId, users}`. Lista de UID únicos, sin perfiles ni datos de contacto. |
| `room:error` | Servidor → cliente | `{code, message}` cuando falla una operación enviada sin callback. |

Con callback, el servidor responde con `{ok: true, data}` o `{ok: false, error: {code, message}}`. `roomId` admite de 1 a 128 letras ASCII, números, guiones y guiones bajos. `content` debe tener entre 1 y 2000 unidades UTF-16 tras recortar espacios.

La pertenencia es por conexión. Un usuario aparece una sola vez en presencia mientras tenga al menos una conexión unida. La reconexión requiere autenticarse y volver a entrar. La presencia usa el adaptador local de Socket.IO y cubre una sola instancia.

## Autorización y persistencia

La copia local de `backend-api` aún no define la colección y el identificador de sala, el campo del UID del creador, la estructura de participantes ni las reglas de pertenencia. US-06 debe acordar ese contrato para conectar una implementación de `RoomAuthorizer.canAccess(roomId, uid)`. El proceso de producción usa la política de denegación por defecto. Las pruebas inyectan una política simulada en `createApp`. Un fallo del autorizador se devuelve como error seguro y evita la operación.

El esquema provisional guarda cada mensaje en `realtime_messages/{id}`. El documento contiene `id` autogenerado, `roomId`, `authorUid` del token, `content` validado y `createdAt` como `Timestamp` generado por el servicio. El protocolo entrega la fecha en formato ISO 8601 UTC. Si Firestore rechaza la escritura, el servidor devuelve `PERSISTENCE_ERROR` y omite la publicación. US-06 debe confirmar el vínculo con la sala y la ubicación definitiva de los mensajes.

La pertenencia de cada conexión se comprueba al enviar junto con el autorizador. La recepción depende de la pertenencia vigente en Socket.IO. La integración con US-06 debe definir cómo retirar de una sala a conexiones ya activas cuando cambien los permisos. La comprobación de revocación del token ocurre al conectar. `/health` no consulta Firebase.
