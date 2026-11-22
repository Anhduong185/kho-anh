// Official Cloudflare CLI (`cf`) configuration for Kho Ảnh (Workers Static Assets + D1 + R2)
export default {
  accountId: 'a9fe540e1b92c1a726089f3da01fa189',
  worker: {
    name: 'kho-anh',
    entrypoint: './src/index.ts',
    compatibilityDate: '2026-11-21',
    compatibilityFlags: ['nodejs_compat'],
    observability: {
      enabled: true,
      logs: { enabled: true, headSamplingRate: 1 },
      traces: { enabled: true, headSamplingRate: 0.05 }
    },
    assets: {
      directory: '../web/dist',
      binding: 'ASSETS',
      notFoundHandling: 'single-page-application',
      runWorkerFirst: ['/api/*', '/health']
    },
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'kho-anh-db',
        database_id: '466ad7c0-1fb0-4674-a629-ca4530d7a3e0'
      }
    ],
    r2_buckets: [
      {
        binding: 'VAULT_BUCKET',
        bucket_name: 'kho-anh-vault'
      }
    ]
  }
};
