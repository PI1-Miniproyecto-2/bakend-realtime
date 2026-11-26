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

## US-08 · Historial de mensajes paginado

El evento `chat:history` permite recuperar los mensajes
persistidos en Firestore correspondientes a una sala.

### Solicitud

Dirección: cliente → servidor.

Evento: `chat:history`.

Carga JSON:

```json
{
  "roomId": "Abcdefghij0123456789",
  "limit": 50
}
```

El límite es opcional. Su valor predeterminado es 50
y debe ser un número entero entre 1 y 50.

Para consultar mensajes anteriores se utiliza el cursor:

```json
{
  "roomId": "Abcdefghij0123456789",
  "limit": 50,
  "before": "idMensajeAnterior"
}
```

### Respuesta exitosa

La respuesta se entrega únicamente al socket solicitante
mediante acknowledgement.

```json
{
  "ok": true,
  "data": {
    "roomId": "Abcdefghij0123456789",
    "messages": [
      {
        "id": "idMensaje",
        "roomId": "Abcdefghij0123456789",
        "authorUid": "uidA",
        "content": "Hola",
        "createdAt": "2026-11-25T15:00:00.000Z"
      }
    ],
    "hasMore": false,
    "nextCursor": null
  }
}
```

Los mensajes se entregan en orden cronológico ascendente.
La consulta utiliza la fecha y el ID del documento para
mantener un orden estable.

Si existen mensajes anteriores, `hasMore` será verdadero
y `nextCursor` contendrá el ID del mensaje más antiguo
de la página recuperada.

### Seguridad del historial

- El usuario debe estar autenticado.
- Debe tener un perfil completo.
- Debe pertenecer a la sala mediante `room:join`.
- Se comprueba nuevamente el acceso a la sala.
- El cursor debe pertenecer a la misma sala.
- El historial no se transmite a otros participantes.
- Se revalidan los permisos antes de entregar los datos.

### Errores adicionales

| Código | Condición |
| --- | --- |
| INVALID_HISTORY_LIMIT | Límite inválido. |
| INVALID_HISTORY_CURSOR | Cursor inválido, inexistente o de otra sala. |
| HISTORY_ERROR | Fallo al consultar el historial. |
| NOT_JOINED | El socket no pertenece a la sala. |
| FORBIDDEN | El usuario perdió la autorización. |

## US-08 · Reconexión y recuperación de mensajes

Cuando se pierde la conexión, el servidor actualiza
la presencia de los participantes.

El cliente debe:

1. Obtener un token Firebase válido.
2. Restablecer la conexión con Socket.IO.
3. Ejecutar nuevamente `room:join`.
4. Esperar la confirmación exitosa.
5. Solicitar `chat:history`.
6. Recuperar páginas anteriores si es necesario.
7. Unificar historial y eventos `chat:message` por ID
   para evitar duplicados.

El servidor verifica nuevamente la identidad,
el perfil y la autorización de acceso.

Si el token fue revocado o el usuario perdió su
membresía, se rechaza la reconexión o el reingreso.

La reconexión automática debe ser integrada por el
Frontend. El servidor admite el reingreso autenticado
y la recuperación paginada del historial.

## US-08 · Verificación técnica

Pruebas locales ejecutadas:

- Recuperación de historial ordenado y paginado.
- Historial vacío.
- Aislamiento del historial entre salas.
- Validación de límites y cursores.
- Protección ante pérdida de membresía.
- Reconexión y recuperación de mensajes perdidos.
- Rechazo de reconexión con token revocado.
- Rechazo de reingreso sin autorización.

Resultado acumulado: 17 pruebas aprobadas, 0 fallidas.

La verificación de TypeScript y la compilación
finalizaron correctamente.

Las pruebas utilizan sockets locales y dobles de Firebase.
Queda pendiente la validación con Firestore real y la
integración en producción.

## Sprint 3 — Notificaciones de edición y eliminación de salas

### US-10-06: Actualización de salas

Evento: `room:updated`

Dirección: servidor → cliente.

Destinatarios: usuarios conectados a la sala correspondiente.

Payload:

```json
{
  "roomId": "ID_DE_LA_SALA",
  "name": "Nuevo nombre de la sala"
}
```

El Backend Realtime escucha los cambios del documento de
la sala en Firestore y notifica su nombre actualizado.
El evento también puede emitirse al iniciar la observación.

### US-11-06: Eliminación de salas

Evento: `room:deleted`

Dirección: servidor → cliente.

Destinatarios: usuarios conectados a la sala eliminada.

Payload:

```json
{
  "roomId": "ID_DE_LA_SALA"
}
```

Cuando el documento de la sala es eliminado o deja de
estar activo, el servidor notifica a los participantes
y retira sus conexiones del canal correspondiente.

Los usuarios no pueden volver a ingresar, enviar mensajes
ni consultar el historial de una sala eliminada.

### Seguridad y aislamiento

- Las notificaciones se limitan al canal de la sala.
- Los permisos de edición y eliminación se validan
  desde el Backend API.
- Los cambios de membresía observados en Firestore
  permiten retirar participantes no autorizados.
- Las suscripciones de Firestore se liberan cuando
  la sala queda vacía.
- El Frontend no accede directamente a Firestore.

### Evidencias técnicas

- 21 pruebas automatizadas aprobadas en Backend Realtime.
- 0 pruebas fallidas.
- Verificación de TypeScript exitosa.
- Compilación exitosa.

### Validaciones pendientes

- Integración con Firestore real.
- Recepción de eventos desde el Frontend publicado.
- Revalidación de permisos de receptores pasivos.
- Verificación del despliegue en Render.
