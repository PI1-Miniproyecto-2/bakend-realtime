export function readEnv() {
  const port = Number(process.env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT debe ser un puerto válido');
  }

  const origins = (process.env.CORS_ORIGINS ??
    (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5173'))
    .split(',').map(origin => origin.trim()).filter(Boolean);

  for (const origin of origins) {
    if (!/^https?:\/\//.test(origin) || URL.parse(origin)?.origin !== origin) {
      throw new Error('CORS_ORIGINS requiere orígenes HTTP(S) exactos');
    }
  }
  if (process.env.NODE_ENV === 'production' && origins.length === 0) {
    throw new Error('CORS_ORIGINS es obligatorio en producción');
  }

  const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
  if (!projectId) {
    throw new Error('FIREBASE_PROJECT_ID es obligatorio');
  }

  return { port, origins, projectId };
}
