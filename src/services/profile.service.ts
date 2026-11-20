import { Timestamp, type Firestore } from 'firebase-admin/firestore';

export type CompleteProfileCheck = (uid: string) => Promise<boolean>;

const fields = [
  'firstName', 'lastName', 'username', 'usernameNormalized', 'email',
  'avatarId', 'authProvider', 'profileCompleted', 'createdAt', 'updatedAt',
];
const avatars = ['avatar_book', 'avatar_owl', 'avatar_lamp'];

function validName(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() &&
    value.length >= 1 && value.length <= 100;
}

// Equivale a requireCompleteProfile y createProfileService.read de backend-api.
export function createCompleteProfileCheck(db: Pick<Firestore, 'runTransaction' | 'doc' | 'collection'>): CompleteProfileCheck {
  return uid => db.runTransaction(async tx => {
    const profile = (await tx.get(db.doc(`users/${uid}`))).data();
    if (!profile || Object.keys(profile).length !== fields.length ||
        fields.some(field => !Object.hasOwn(profile, field))) return false;

    const { firstName, lastName, username, usernameNormalized, email, avatarId,
      authProvider, profileCompleted, createdAt, updatedAt } = profile;
    if (profileCompleted !== true || !validName(firstName) || !validName(lastName) ||
        typeof username !== 'string' || username.match(/^[A-Za-z0-9_]{3,20}$/)?.[0] !== username ||
        usernameNormalized !== username.toLowerCase() ||
        typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        !avatars.includes(avatarId) || !['password', 'google.com'].includes(authProvider) ||
        !(createdAt instanceof Timestamp) || !(updatedAt instanceof Timestamp)) return false;

    const path = `usernames/${usernameNormalized}`;
    const owned = await tx.get(db.collection('usernames').where('uid', '==', uid));
    return owned.docs.length === 1 && owned.docs[0].ref.path === path &&
      (await tx.get(db.doc(path))).data()?.uid === uid;
  }, { readOnly: true });
}
