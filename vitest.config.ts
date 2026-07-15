import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Fake-timer heavy tests (sync-engine) need real clocks restored per-file.
    restoreMocks: true,
  },
});
