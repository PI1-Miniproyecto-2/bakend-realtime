# Salón de Estudio Colaborativo · Servicio de tiempo real

TS-02 usa un servidor HTTP de Node.js con Socket.IO para salas, presencia y chat. Firebase Admin verifica la identidad y Firestore almacena los perfiles, las salas de US-06 y los mensajes. La API REST administra las salas. Realtime consulta esas salas y escribe únicamente en `realtime_messages`.

## Ejecución local

Requiere Node.js 20 o superior. Ejecuta `npm ci`, copia `.env.example` a `.env` y configura el mismo proyecto Firebase que usan la API y el frontend. Firebase Admin utiliza Application Default Credentials (ADC). Si usas `GOOGLE_APPLICATION_CREDENTIALS`, indica la ruta de un archivo autorizado fuera del repositorio.

| Variable | Uso |
| --- | --- |
| `PORT` | Puerto HTTP y Socket.IO. Predeterminado `3001`. |
| `NODE_ENV` | `production` exige orígenes explícitos. |
| `CORS_ORIGINS` | Orígenes HTTP(S) exactos, separados por comas. En desarrollo se usa `http://localhost:5173` por defecto. |
| `FIREBASE_PROJECT_ID` | ID obligatorio del proyecto. |
| `GOOGLE_APPLICATION_CREDENTIALS` | Ruta opcional a un archivo externo compatible con ADC. |
| `HOST_PORT` | Puerto publicado por Compose en `127.0.0.1`. Predeterminado `3001`. |

- `npm run dev` inicia el servicio en modo observación.
- `npm run build && npm start` compila TypeScript y ejecuta `dist/server.js`.
- `npm run typecheck` verifica el servicio y las pruebas. `npm test` usa sockets locales y dobles de Firebase.
- `GET /health` devuelve HTTP 200 y `{"status":"ok"}`. Comprueba la respuesta HTTP del proceso. SIGTERM y SIGINT cierran Socket.IO y el servidor HTTP, esperan las operaciones en curso y liberan Firebase.

## Docker y Compose

```sh
docker build -t salon-realtime:ts02 .
docker compose config
```

El Dockerfile usa Node.js 22 y ejecuta JavaScript compilado con el usuario `node`. Compose levanta solamente realtime. Su dependencia externa es Firebase. La configuración de la API vive en su propio repositorio.

Para Firebase desde Compose, proporciona ADC en tiempo de ejecución. Si tienes un archivo ADC autorizado, monta el archivo en solo lectura mediante un override local. Guarda el override fuera del repositorio y exporta `REALTIME_ADC_FILE` con la ruta absoluta al archivo. El usuario `node` del contenedor debe poder leerlo.

```yaml
services:
  realtime:
    environment:
      GOOGLE_APPLICATION_CREDENTIALS: /run/secrets/firebase-adc.json
    volumes:
      - type: bind
        source: ${REALTIME_ADC_FILE:?Indica la ruta al archivo ADC}
        target: /run/secrets/firebase-adc.json
        read_only: true
```

```sh
docker compose -f docker-compose.yml -f /ruta/externa/compose.adc.yml up --build
curl --fail http://127.0.0.1:3001/health
```

## Preparación para Render

Configura un Web Service con runtime Docker y health check `/health`. El proceso escucha en `0.0.0.0` y usa el `PORT` que Render proporciona. Configura `FIREBASE_PROJECT_ID` y `CORS_ORIGINS` con el origen HTTPS exacto del frontend en Vercel. El cliente Socket.IO apunta a la URL HTTPS del servicio para usar WSS. [Servicios web](https://render.com/docs/web-services) · [WebSockets](https://render.com/docs/websocket)

Según la estrategia ADC de TS-01, el administrador debe provisionar la identidad de ejecución. Si autoriza un archivo ADC, configúralo como Secret File de Render y apunta `GOOGLE_APPLICATION_CREDENTIALS` a `/etc/secrets/<archivo>`. La identidad necesita verificar el estado de las cuentas de Auth, leer salas y perfiles, consultar reservas de usuario y crear mensajes. La identidad concreta y sus permisos efectivos quedan pendientes de validación. [Archivos secretos en Render](https://render.com/docs/configure-environment-variables#secret-files)

## Autenticación y eventos

Conecta con `auth: { token: firebaseIdToken }`. Al conectar, entrar en una sala o enviar chat, el servicio verifica el token del proyecto con revocación, admite los proveedores de la API REST, rechaza otros tenants y comprueba el perfil completo de `users/{uid}` y la reserva de usuario. Un origen ausente también exige autenticación.

- `room:join` recibe `{roomId}` y exige acceso vigente a la sala.
- `room:leave` recibe `{roomId}` y es idempotente.
- `room:users` entrega `{roomId, users}` a las conexiones de la sala cuando cambia la presencia.
- `chat:send` recibe `{roomId, content}` y exige pertenencia por socket y acceso vigente.
- `chat:message` entrega el mensaje persistido a la sala, incluido el emisor.
- `chat:history` recibe `{roomId, limit?, before?}` y devuelve el historial paginado mediante acknowledgement únicamente al solicitante.
- `room:error` entrega `{code, message}` cuando falla una operación sin callback.

El [contrato realtime](docs/TS-02-contrato-realtime.md) detalla el formato, los acknowledgements y los errores. Los mensajes se guardan en `realtime_messages/{id}` con UID verificado y `Timestamp` generado por el servidor. El cliente recibe la fecha en UTC ISO 8601. Un fallo de escritura impide la emisión.

## Limitaciones

La presencia se mantiene en memoria en una sola instancia. Si se detecta pérdida de acceso en una entrada o envío, se retira ese socket de la sala. Un socket pasivo puede seguir recibiendo eventos hasta salir, desconectarse o provocar una revalidación. La revocación inmediata para todos los sockets exige una estrategia adicional. El cliente debe renovar el token y reconectar cuando expire, y volver a unirse tras reconectar. El protocolo carece de replay y deduplicación para reintentos.

Consulta los [casos de prueba](docs/TS-02-casos-prueba.md) y el [informe QA](docs/TS-02-informe-QA.md) para conocer la cobertura local y la evidencia pendiente de producción.

## US-08 · Historial y reconexión

El servicio permite consultar los últimos 50 mensajes
de una sala mediante `chat:history`.

La paginación utiliza un cursor basado en el ID
del mensaje más antiguo de la página.

El cliente debe autenticarse nuevamente y ejecutar
`room:join` después de una desconexión. Posteriormente
puede recuperar los mensajes mediante `chat:history`.

### Índice de Firestore

La consulta del historial utiliza la colección
`realtime_messages` y requiere un índice compuesto
con los siguientes campos:

| Campo | Orden |
| --- | --- |
| roomId | Ascendente |
| createdAt | Descendente |
| __name__ | Descendente |

El alcance de consulta es Collection.

La identidad de ejecución de Firebase Admin debe
tener permisos de lectura y consulta de mensajes,
además de los permisos de escritura existentes.

### Verificación local

```sh
npm run typecheck
npm test
npm run build
```

Resultado: 17 pruebas aprobadas y ninguna fallida.

Pendiente: verificar el índice, los permisos efectivos
de Firebase y la integración en producción.
