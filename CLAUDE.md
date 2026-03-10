# @ecoapi/node — Node.js Middleware

Provider registry, interceptor pipeline, multi-provider aggregation, and framework adapters for EcoAPI in Node.js environments.

## Tech Stack

- **TypeScript** — strict mode, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`
- **tsup** — dual ESM + CJS output (`dist/esm/`, `dist/cjs/`)
- **vitest** — unit testing
- **Node.js ≥ 18**

## Project Structure

```
src/
  core/
    types.ts              # All core interfaces and types (Provider, EcoRequest, EcoResponse, Interceptor, Transport, …)
    provider-registry.ts  # ProviderRegistry — register, lookup, list providers
    interceptor.ts        # InterceptorChain — composable request/response middleware pipeline
    aggregator.ts         # Aggregator — fan-out to multiple providers, merge results
    transport.ts          # HttpTransport — fetch-based transport with retry & timeout
  frameworks/
    express.ts            # Express middleware adapter
    fastify.ts            # Fastify plugin adapter
  index.ts                # Public API surface (re-exports only)
tests/
  scaffold.test.ts        # Smoke tests — expand as logic is implemented
tsup.config.ts            # Dual ESM + CJS build config
tsconfig.json             # ES2020, bundler moduleResolution, strict
vitest.config.ts
package.json
LICENSE
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Dual ESM + CJS build via tsup |
| `npm run build:types` | Emit `.d.ts` declarations only |
| `npm run dev` | Watch mode build |
| `npm run test` | Run tests once |
| `npm run test:watch` | Watch mode tests |
| `npm run lint` | TypeScript type-check only (`--noEmit`) |

## Architecture Notes

- **`src/index.ts`** is the sole public API surface — only add exports here when something is ready for consumers
- **`core/types.ts`** defines all shared interfaces; never import from implementation files to avoid circular deps
- **Dual output**: tsup emits ESM to `dist/esm/` and CJS to `dist/cjs/`; `package.json` exports map selects the right one
- All `.js` extensions in imports are intentional — required for ESM output compatibility
- **Framework adapters** are thin wrappers; heavy logic lives in core and is reused across adapters
- Vitest is configured in `vitest.config.ts`; tests live in `tests/` and import directly from `src/`

## Implementation Status

All files are scaffold stubs — no business logic implemented yet. Start with `core/types.ts` to evolve the type contracts, then fill in the core classes before touching the framework adapters.
