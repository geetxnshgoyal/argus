import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Integration tests share one database; run files sequentially.
    fileParallelism: false,
    // Database tests reset the schema and boot the app; on a busy machine (e.g. while an
    // app build runs) the default 5 s can be too short for the first test in a file.
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
