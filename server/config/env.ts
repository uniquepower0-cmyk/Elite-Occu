import dotenv from 'dotenv';
import path from 'path';

// Load .env from project root
dotenv.config();

export interface AppConfig {
  port: number;
  nodeEnv: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  bypassAuth: boolean;
  isProduction: boolean;
  writableBase: string;
}

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';
const supabaseUrl = process.env.SUPABASE_URL || 'https://uuvomcxbgldgtmuqtymk.supabase.co';
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseServiceRoleKey) {
  console.warn('[Security Warning] SUPABASE_SERVICE_ROLE_KEY is not defined in process.env. Please configure it in .env');
}

export const config: AppConfig = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv,
  supabaseUrl,
  supabaseServiceRoleKey,
  bypassAuth: process.env.BYPASS_AUTH === 'true' || !isProduction,
  isProduction,
  writableBase: process.env.VERCEL ? '/tmp' : process.cwd(),
};
