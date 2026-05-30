import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildApp } from '../src/app.ts';
import { createLogger } from '../src/logger.ts';

const METHODS = ['get', 'put', 'post', 'delete', 'patch'];

function specRoutes(): string[] {
  const spec = parse(readFileSync(new URL('../api/openapi.yaml', import.meta.url), 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  const out: string[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const m of Object.keys(item)) if (METHODS.includes(m)) out.push(`${m.toUpperCase()} ${path}`);
  }
  return out.sort();
}

describe('OpenAPI spec', () => {
  it('lists exactly the /v1 routes the server registers', async () => {
    const { app, apiRoutes } = await buildApp({
      logger: createLogger('silent'),
      version: 't',
      trustProxy: false,
      checkDb: async () => {},
    });
    await app.close();
    expect([...apiRoutes].sort()).toEqual(specRoutes());
  });
});
