import type { Request, Response } from 'express';

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
