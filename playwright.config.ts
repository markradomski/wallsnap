import { defineConfig } from '@playwright/test'

// E2E runs against the MOCK adapter (no FloorGen credentials needed). It does not verify FloorGen itself.
export default defineConfig({
  testDir: 'e2e',
  // One shared mock project: any save bumps its revision, so parallel workers would cause (correct) revision conflicts.
  workers: 1,
  use: { baseURL: 'http://localhost:5173' },
  webServer: [
    { command: 'WALLSNAP_ADAPTER=mock npm run dev:server', url: 'http://localhost:8787/api/status', reuseExistingServer: false },
    { command: 'npm run dev:web', url: 'http://localhost:5173', reuseExistingServer: false },
  ],
})
