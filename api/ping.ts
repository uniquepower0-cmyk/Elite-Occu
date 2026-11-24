import type { IncomingMessage, ServerResponse } from 'http';

export default function handler(req: IncomingMessage, res: ServerResponse) {
  const allowOrigin = process.env.GATEWAY_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = 200;

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  res.end(
    JSON.stringify({
      ok: true,
      node: process.env.VERCEL_NODE_LABEL || 'primary',
      ts: Date.now(),
    })
  );
}
