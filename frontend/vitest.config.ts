import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '~': fileURLToPath(new URL('./src', import.meta.url)) } },
  // e2e/ is Playwright's (pnpm e2e), not Vitest's.
  test: { environment: 'happy-dom', include: ['tests/**/*.test.{ts,tsx}'] },
});
