import { defineConfig } from 'tsup'

export default defineConfig({
  entry:      ['src/index.ts'],
  format:     ['esm'],
  outDir:     'dist',
  dts:        false,
  noExternal: [
    '@baseworks/auth',
    '@baseworks/core',
    '@baseworks/organization',
    '@dotlabshq/flect-sdk',
    '@hono/node-server',
    'hono',
    '@hono/zod-validator',
    'zod',
    'drizzle-orm',
  ],
  external: ['@libsql/client', 'ioredis'],
})
