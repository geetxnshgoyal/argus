# ADR-0001: Node.js + TypeScript backend instead of Go

**Context.** Spec §2 chose Go (chi, pgx + sqlc, golang-migrate, River). The team prefers Node/TypeScript, which is also the web app's language.

**Decision.** Node.js 24 LTS + TypeScript (strict, erasable syntax only).

| Spec (Go) | Replacement |
|---|---|
| chi | Fastify 5 |
| pgx + sqlc | `pg` + Kysely (typed query builder; SQL stays explicit) |
| golang-migrate | Kysely migrations, bundled into the server, applied at startup or with `server.mjs migrate` |
| River | pg-boss (Postgres-backed) when jobs arrive in M2 |
| Crypto | `node:crypto` (ECDSA P-256, HMAC, HKDF, AES-GCM, X.509); App Attest adds one CBOR decoder |

The spec's `backend/internal/*` package layout becomes `backend/src/<module>/` with the same module names.

TypeScript is pinned to 5.9: TypeScript 7 is not yet supported by typescript-eslint or openapi-typescript.

**Consequences.** One language across server and web; generated API types are shared. Production needs Node 24 installed (one installer) but no `npm install`: the server is bundled into a single `server.mjs` (ADR-0003). Android key-attestation parsing must be written and tested by us (Google's reference verifier is JVM-based).
