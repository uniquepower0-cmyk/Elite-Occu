import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import { config } from '../config/env.js';

// Isolated auth client for verifying user session tokens
const authClient = config.supabaseServiceRoleKey
  ? createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

export interface AuthenticatedUser {
  id: string;
  email?: string;
  role?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

/**
 * Authentication middleware that verifies Supabase Bearer tokens.
 * In development or when BYPASS_AUTH=true is set, unauthenticated requests are allowed
 * with a mock user context to ensure non-disruptive local developer workflows.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (token && authClient) {
    try {
      const { data: { user }, error } = await authClient.auth.getUser(token);
      if (!error && user) {
        req.user = {
          id: user.id,
          email: user.email,
          role: (user.app_metadata as any)?.role || 'authenticated',
        };
        return next();
      }
    } catch (err) {
      console.warn('[Auth Middleware] Token verification failed:', err);
    }
  }

  // If auth is bypassed for development
  if (config.bypassAuth) {
    req.user = {
      id: 'dev-admin',
      email: 'mohanad.md07@gmail.com',
      role: 'admin',
    };
    return next();
  }

  // Deny in production if unauthenticated
  return res.status(401).json({
    error: 'Unauthorized',
    message: 'Valid Authorization Bearer token is required.',
  });
}
