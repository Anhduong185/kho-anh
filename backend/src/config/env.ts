import { DEFAULT_USER_QUOTA_BYTES } from '@smb/shared';
import dotenv from 'dotenv';
import path from 'node:path';
import { z } from 'zod';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HOST: z.string().default('0.0.0.0'),
  CORS_ORIGINS: z
    .string()
    .default(
      'http://localhost:5173,http://127.0.0.1:5173,https://localhost,http://localhost,capacitor://localhost'
    ),
  DATABASE_URL: z.string().default('pglite://./data/pgdata'),
  JWT_ACCESS_SECRET: z
    .string()
    .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters')
    .default('dev-only-access-secret-change-in-production-32chars'),
  JWT_REFRESH_SECRET: z
    .string()
    .min(32, 'JWT_REFRESH_SECRET must be at least 32 characters')
    .default('dev-only-refresh-secret-change-in-production-32chars'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(900),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  STORAGE_CONFIG_KEY: z.string().optional().default(''),
  STORAGE_PRIMARY_TYPE: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_ROOT: z.string().default('./data/storage'),
  S3_PRIMARY_ENDPOINT: z.string().optional().default(''),
  S3_PRIMARY_REGION: z.string().optional().default('auto'),
  S3_PRIMARY_BUCKET: z.string().optional().default(''),
  S3_PRIMARY_ACCESS_KEY_ID: z.string().optional().default(''),
  S3_PRIMARY_SECRET_ACCESS_KEY: z.string().optional().default(''),
  S3_PRIMARY_FORCE_PATH_STYLE: z
    .string()
    .optional()
    .default('true')
    .transform((v) => v !== 'false'),
  S3_SECONDARY_ENDPOINT: z.string().optional().default(''),
  S3_SECONDARY_REGION: z.string().optional().default('us-west-004'),
  S3_SECONDARY_BUCKET: z.string().optional().default(''),
  S3_SECONDARY_ACCESS_KEY_ID: z.string().optional().default(''),
  S3_SECONDARY_SECRET_ACCESS_KEY: z.string().optional().default(''),
  S3_SECONDARY_FORCE_PATH_STYLE: z
    .string()
    .optional()
    .default('true')
    .transform((v) => v !== 'false'),
  S3_OFFSITE_ENDPOINT: z.string().optional().default(''),
  S3_OFFSITE_REGION: z.string().optional().default('ap-singapore-1'),
  S3_OFFSITE_BUCKET: z.string().optional().default(''),
  S3_OFFSITE_ACCESS_KEY_ID: z.string().optional().default(''),
  S3_OFFSITE_SECRET_ACCESS_KEY: z.string().optional().default(''),
  S3_OFFSITE_FORCE_PATH_STYLE: z
    .string()
    .optional()
    .default('true')
    .transform((v) => v !== 'false'),
  DEFAULT_USER_QUOTA_BYTES: z.coerce.number().int().positive().default(DEFAULT_USER_QUOTA_BYTES)
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(overrides: Partial<Record<string, string>> = {}): AppConfig {
  const merged = { ...process.env, ...overrides };
  const parsed = EnvSchema.parse(merged);

  if (
    parsed.NODE_ENV === 'production' &&
    (parsed.JWT_ACCESS_SECRET.startsWith('dev-only-') ||
      parsed.JWT_REFRESH_SECRET.startsWith('dev-only-') ||
      parsed.JWT_ACCESS_SECRET.startsWith('change-me-'))
  ) {
    throw new Error('Production environment requires strong custom JWT_ACCESS_SECRET and JWT_REFRESH_SECRET');
  }

  return parsed;
}
