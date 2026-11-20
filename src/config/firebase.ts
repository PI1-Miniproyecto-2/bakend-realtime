import { applicationDefault, deleteApp, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

export function createFirebase(projectId: string) {
  const app = initializeApp({ projectId, credential: applicationDefault() });
  const auth = getAuth(app);
  const firestore = getFirestore(app);

  return {
    firestore,
    verifyToken: (token: string) => auth.verifyIdToken(token, true),
    close: async () => {
      try {
        await firestore.terminate();
      } finally {
        await deleteApp(app);
      }
    },
  };
}
