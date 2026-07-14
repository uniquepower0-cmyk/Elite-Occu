import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import admin from 'firebase-admin';
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore';

const CONFIG_PATH = path.join(process.cwd(), 'firebase-applet-config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

admin.initializeApp({
  projectId: config.projectId,
  credential: admin.credential.applicationDefault()
});

const adminDb = getAdminFirestore(admin.app(), config.firestoreDatabaseId);

adminDb.collection('logins').limit(1).get().then(() => {
  console.log('SUCCESS');
  process.exit(0);
}).catch(err => {
  console.error('ERROR:', err);
  process.exit(1);
});
