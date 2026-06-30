import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { makeApp } from './helpers/app.ts';

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
    // devLogin on so dev-only routes are registered and must be documented too.
    const { app, apiRoutes } = await makeApp({ config: { devLogin: true } });
    await app.close();
    expect([...apiRoutes].sort()).toEqual(specRoutes());
  });
});
