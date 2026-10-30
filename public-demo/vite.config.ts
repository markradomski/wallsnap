import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

// Static public demo, served from https://markradomski.github.io/wallsnap/.
export default defineConfig({
  root: here('.'),
  base: '/wallsnap/',
  plugins: [react()],
  resolve: {
    alias: [
      // The mock gateway's synthetic fixture becomes the static townhouse snapshot.
      { find: /^\.\/fixture$/, replacement: here('./townhouse.ts') },
      // The FloorGen MCP client is never used in the demo; keep it out of the bundle.
      { find: /^@modelcontextprotocol\/sdk\/.*/, replacement: here('./no-mcp.ts') },
    ],
  },
  build: { outDir: here('../dist-demo'), emptyOutDir: true, target: 'es2022' },
  server: { fs: { allow: [here('..')] } },
})
