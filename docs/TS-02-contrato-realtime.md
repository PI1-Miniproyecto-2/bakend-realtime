# TS-02 · Contrato realtime

El cliente conecta al servidor Socket.IO con `auth: { token: firebaseIdToken }` y un origen autorizado si lo envía. El servidor toma el UID de Firebase Admin, que verifica el proyecto, la firma, la expiración y la revocación del token. Rechaza otros tenants y exige un proveedor `password` o `google.com`. El fallo de autenticación se entrega como `connect_error` con `data: {"code":"UNAUTHENTICATED"}`.

El perfil sigue la política de `backend-api`. Debe existir en `users/{uid}`, tener su esquema exacto, nombre y apellido válidos, nombre de usuario válido y normalizado, avatar permitido, correo, proveedor soportado, fechas Firestore y `profileCompleted: true`. Su única reserva `usernames/{usernameNormalized}` debe pertenecer al UID. La lectura se realiza en una transacción de solo lectura.

## Salas US-06

`rooms/{roomId}` usa un ID de exactamente 20 letras ASCII o dígitos. Los campos son `name` (texto), `ownerUid` (texto), `participantUids` (arreglo de UID), `createdAt` (Firestore Timestamp) y `status` (texto). Realtime admite documentos válidos con `status: "active"` cuyo propietario sea el UID autenticado o cuyo arreglo de participantes lo incluya. Un documento inexistente, inválido o inaccesible deniega el permiso.

## Eventos

Los ejemplos usan el ID de sala `Abcdefghij0123456789`.

| Evento | Dirección | Carga JSON |
| --- | --- | --- |
| `room:join` | Cliente → servidor | `{"roomId":"Abcdefghij0123456789"}` |
| `room:leave` | Cliente → servidor | `{"roomId":"Abcdefghij0123456789"}` |
| `room:users` | Servidor → sala | `{"roomId":"Abcdefghij0123456789","users":["uidA","uidB"]}` |
| `chat:send` | Cliente → servidor | `{"roomId":"Abcdefghij0123456789","content":"Hola"}` |
| `chat:message` | Servidor → sala, incluido el emisor | `{"id":"idGenerado","roomId":"Abcdefghij0123456789","authorUid":"uidA","content":"Hola","createdAt":"2026-11-20T15:00:00.000Z"}` |
| `room:error` | Servidor → socket solicitante, sin callback | `{"code":"FORBIDDEN","message":"Acceso a la sala denegado"}` |

Con callback, la operación devuelve `{"ok":true,"data":{...}}` o `{"ok":false,"error":{"code":"FORBIDDEN","message":"Acceso a la sala denegado"}}`. `data` contiene `{roomId}` para entrada y salida, o el objeto de `chat:message` para un envío. Sin callback, los fallos se entregan mediante `room:error`.

| Código | Condición |
| --- | --- |
| `INVALID_ROOM` | Carga sin ID de sala válido. |
| `FORBIDDEN` | Falló la verificación vigente de identidad, perfil o acceso. |
| `NOT_JOINED` | La conexión carece de pertenencia a la sala al enviar. |
| `INVALID_MESSAGE` | El contenido recortado queda fuera de 1 a 2000 unidades UTF-16 o tiene tipo inválido. |
| `PERSISTENCE_ERROR` | Falló la creación del documento. |
| `INTERNAL_ERROR` | Fallo inesperado al completar la operación. |

## Presencia, persistencia y revocación

La salida es idempotente. La presencia expone UID únicos a miembros de la sala. Varias conexiones del mismo UID cuentan como un usuario presente hasta que salga o se desconecte la última. Una reconexión requiere autenticarse y entrar de nuevo.

Cada envío válido crea `realtime_messages/{id}` con `id`, `roomId`, `authorUid`, `content` y `createdAt` como Timestamp. El servidor genera el ID y la fecha y descarta un UID o fecha suministrados por el cliente. La emisión sigue a la escritura confirmada. Si el emisor se desconecta mientras se guarda el mensaje, una escritura exitosa aún se publica a los miembros presentes. El emisor desconectado pierde el acknowledgement. Los envíos por socket se procesan en orden. Entre sockets, las escrituras pueden completarse en distinto orden.

Entrar y enviar vuelven a verificar identidad, perfil y sala. Al detectar una denegación, el servidor retira de esa sala el socket solicitante y actualiza presencia. Un cambio posterior a la comprobación puede coincidir con la escritura. Los sockets pasivos conservan su suscripción hasta una salida, desconexión o denegación en una nueva operación. El retiro inmediato requiere un mecanismo adicional.
