import type { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';

// Configure fontconfig for serverless environments (AWS Lambda / Vercel)
const fontsDir = path.resolve(process.cwd(), 'fonts');
if (!process.env.FONTCONFIG_PATH) {
  process.env.FONTCONFIG_PATH = fontsDir;
}
try {
  const cacheDir = path.join('/tmp', 'fonts-cache');
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
} catch (_) {}

let appPromise: Promise<any> | null = null;
let appError: Error | null = null;

// Lazy-load the server to catch any module-level crash and surface it as a readable 500
function getApp() {
  if (!appPromise) {
    appPromise = import('../server.js').then(m => m.default).catch(err => {
      appError = err;
      console.error('[api/index] Server module failed to load:', err);
      return null;
    });
  }
  return appPromise;
}

export default async function handler(req: Request, res: Response) {
  const app = await getApp();
  if (!app) {
    res.status(500).json({
      error: 'Server failed to initialize',
      detail: appError?.message ?? 'Unknown error',
      stack: process.env.NODE_ENV !== 'production' ? appError?.stack : undefined,
    });
    return;
  }
  return app(req, res);
}
