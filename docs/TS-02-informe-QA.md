# TS-02 · Informe QA

Validación local del segundo incremento, con Node.js 20.19.5, npm 10.8.2 y Node.js 22 en Docker. La integración usa servidores Socket.IO locales, varios clientes concurrentes y dobles de verificación Firebase y Firestore.

## Resultados

| Comprobación | Resultado |
| --- | --- |
| `npm run typecheck` | Correcto. |
| `npm run build` | Correcto. |
| `npm test` | 9 pruebas aprobadas. Cubren identidad, perfil y reserva, autorización US-06, persistencia y errores, chat simultáneo, aislamiento, presencia y pérdida de acceso. |
| `docker build -t salon-realtime:ts02 .` | Imagen construida. |
| Ejecución local de la imagen | Usuario sin privilegios, `PORT=4301`, HTTP 200 con `{"status":"ok"}` y cierre exitoso tras SIGTERM. El contenedor se ejecutó sin acceso a red externa ni credenciales. |
| `docker compose config` | Configuración válida. |
| `git diff --check` | Correcto. |
| `npm audit --omit=dev` | Código 1, ocho alertas moderadas abiertas. |

La auditoría señala `uuid <11.1.1` y sus dependencias afectadas `gaxios`, `google-gax`, `teeny-request`, `retry-request`, `@google-cloud/firestore`, `@google-cloud/storage` y `firebase-admin`. El registro devolvió `13.10.0` como única versión dentro del rango de Firebase Admin declarado. npm propone un cambio incompatible al forzar la corrección. Las alertas siguen pendientes. [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)

## Decisión

**GO preliminar para integración y revisión.** El contrato se verificó con clientes Socket.IO y dobles locales, y la imagen respondió al health check y cerró correctamente.

**NO-GO para aprobación definitiva en producción.** Queda por:

- Verificar proyecto, revocación, perfiles y reservas, membresía y escritura con Timestamp en Firebase real.
- Probar los permisos efectivos de la identidad ADC de ejecución en Render.
- Desplegar el contenedor en el entorno autorizado y comprobar el health check y la conexión WSS.
- Probar desde el frontend en Vercel con su origen HTTPS autorizado.
- Obtener evidencia de dos usuarios reales autorizados en la misma sala y verificar el aislamiento de un tercero. Registrar revisión y fecha, resultados y documentos redactados.

La lectura de permisos ocurre al entrar y antes de guardar cada mensaje. Los sockets pasivos quedan suscritos hasta la salida, desconexión o revalidación que detecte la pérdida de acceso. La presencia actual cubre una instancia.
