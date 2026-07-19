import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    client: 'src/client.ts',
    events: 'src/events.ts',
    projections: 'src/projections.ts',
    cli: 'src/cli.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  external: ['@baseworks/cli', '@baseworks/foldbase', 'zod', 'commander'],
})
