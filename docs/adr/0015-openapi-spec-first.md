# ADR-0015: OpenAPI spec-first with a route-sync test

**Context.** Spec §10 asks for `backend/api/openapi.yaml` "kept in sync with handlers".

**Decision.** The YAML is written first. `pnpm gen:api` generates TypeScript types into `backend/src/generated/` and `web/src/generated/`; handlers and web code use these types. A backend test fails if the set of registered `/v1` routes differs from the paths in the spec, and CI fails if generated files are stale.

**Consequences.** Contract drift is caught in CI. Request validation schemas are added per endpoint as they are built.
