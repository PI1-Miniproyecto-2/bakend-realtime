# TS-02 · Casos de prueba

Ejecutar `npm test`. La suite usa Socket.IO sobre WebSocket local y dobles en memoria. Abre hasta tres conexiones simultáneas y cierra clientes y servidores al terminar cada prueba.

| Caso | Acción | Resultado esperado |
| --- | --- | --- |
| HTTP | Consultar `/health`. | HTTP 200 y estado OK. |
| Identidad | Conectar con token válido, ausente, inválido, revocado, de otro tenant o proveedor no admitido. Probar perfil incompleto, cuenta eliminada y reserva duplicada. | Conecta únicamente la identidad válida con perfil completo. El rechazo de autenticación es genérico. |
| Origen | Conectar con token válido desde un origen ajeno. | Se rechaza la conexión. |
| Salas | Probar propietario, participante, tercero con UID falsificado, sala ausente, inactiva, malformada, ID inválido y fallo de lectura. | Solo acceden propietario o participante de una sala activa y válida. El ID inválido evita la lectura de sala. |
| Presencia | Unir dos conexiones de un UID y otro usuario. Salir dos veces y desconectar las dos conexiones. | UID únicos y actualizaciones correctas. El socket restante sigue conectado. Un cliente de otra sala queda aislado. |
| Chat | Intercambiar mensajes con dos clientes y observar un tercero en otra sala. Intentar falsificar autor y fecha. | Cada destinatario recibe solo el chat de su sala. El mensaje ya está almacenado con UID verificado y Timestamp cuando llega. |
| Errores de chat | Enviar desde fuera, con contenido inválido o simulando error de escritura. Probar envío sin callback. | Acknowledgement de error o `room:error`, según corresponda. Sin emisión ni escritura exitosa. |
| Envíos simultáneos | Enviar desde dos conexiones de la misma sala a la vez. | Dos documentos con IDs distintos y ambos mensajes recibidos. |
| Pérdida de acceso | Retirar la membresía, borrar el perfil o revocar el token después de entrar y volver a enviar. | Se rechaza el envío, se retira el socket, se actualiza presencia y el otro miembro sigue enviando. |

Para integración desplegada, registrar revisión, fecha, identidad IAM efectiva, resultado de `/health` y del handshake desde Vercel, dos usuarios autorizados en la misma sala y el documento Firestore redactado. Verificar también el rechazo de un tercero. Excluir tokens y datos personales de las evidencias.
