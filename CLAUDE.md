# @recost/node — Node.js Middleware

Node.js SDK that automatically tracks outbound HTTP API calls, matches them against a built-in provider registry, aggregates events into time-windowed summaries, and ships telemetry to the ReCost cloud API or VS Code extension.

## Tech Stack

- **TypeScript** — strict mode, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`
- **tsup** — dual ESM + CJS output (`dist/esm/`, `dist/cjs/`)
- **vitest** — unit testing (174 tests across 9 files)
- **Node.js ≥ 18**
- **ws** — WebSocket client for local transport mode

## Project Structure

```
src/
  index.ts                # Public API surface (re-exports only)
  init.ts                 # Main entry point — wires interceptor, registry, aggregator, transport
  core/
    types.ts              # All interfaces: RawEvent, MetricEntry, WindowSummary, ProviderDef, EcoAPIConfig, TransportMode
    provider-registry.ts  # ProviderRegistry — 34 built-in rules (14 providers), wildcard host matching, custom provider priority
    interceptor.ts        # Patches globalThis.fetch, http.request, https.request, http.get, https.get; double-count guard; query stripping
    aggregator.ts         # Time-windowed bucketing by provider+endpoint+method, p50/p95 percentiles, cost aggregation
    transport.ts          # Cloud mode (HTTPS POST with exponential backoff, max 3 retries) + local mode (WebSocket with auto-reconnect)
  frameworks/
    express.ts            # Express middleware adapter (thin wrapper around init())
    fastify.ts            # Fastify plugin adapter (thin wrapper around init())
tests/
  scaffold.test.ts        # 5 smoke tests
  provider-registry.test.ts  # 42 tests — all 34 providers, wildcards, Twilio refinement, custom priority, pinned-count regression
  interceptor.test.ts     # 32 tests — lifecycle, capture, query stripping, safety wrappers, double-count guard
  aggregator.test.ts      # 34 tests — flush/reset, grouping, percentiles, null provider handling
  transport.test.ts       # 19 tests — cloud POST, WebSocket, retry logic, rejection signalling
  init.test.ts            # 23 tests — integration: enrichment, exclude patterns, flush, dispose
  contract.test.ts        # 9 tests — serialized WindowSummary wire-format contract
  express.test.ts         # 6 tests — middleware arity, next(), config forwarding
  fastify.test.ts         # 4 tests — done(), config forwarding
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
| `npm run test` | Run tests once (174 tests) |
| `npm run test:watch` | Watch mode tests |
| `npm run lint` | TypeScript type-check only (`--noEmit`) |

## Architecture Notes

- **`src/index.ts`** is the sole public API surface — only add exports here when something is ready for consumers
- **`core/types.ts`** defines all shared interfaces; never import from implementation files to avoid circular deps
- **Dual output**: tsup emits ESM to `dist/esm/` and CJS to `dist/cjs/`; `package.json` exports map selects the right one
- All `.js` extensions in imports are intentional — required for ESM output compatibility
- **Framework adapters** are thin wrappers; heavy logic lives in core and is reused across adapters
- **Interceptor** uses `getRawFetch()` to get the original unpatched fetch for SDK internal transport (avoids self-instrumentation)
- **Transport auto-excludes** its own endpoint URL from interception to prevent feedback loops
- **Timer.unref()** used on flush interval to avoid keeping the Node.js process alive
- **Safety wrappers** around all interception callbacks prevent SDK errors from breaking the host application
- **init()** returns a handle with `dispose()` that stops interception, cancels timers, and closes transport

## Provider Registry

34 built-in rules covering 14 providers:
- **AI**: OpenAI (6 endpoints), Anthropic
- **Payments**: Stripe (4 endpoints)
- **Communication**: Twilio (SMS + voice with path refinement), SendGrid
- **Infrastructure**: Pinecone, AWS (wildcard), Google Cloud (wildcard)
- **Other**: GitHub, CoinGecko, Hacker News, wttr.in, ZenQuotes, ip-api

Custom providers are prepended before built-ins (higher priority). Unrecognized hosts are grouped under `"unknown"`.

## Transport Modes

- **Cloud mode** (when `apiKey` is provided): HTTPS POST to `api.recost.dev` with exponential-backoff retry (max 3 attempts, 4xx skips retry)
- **Local mode** (default): WebSocket to `localhost:9847` (VS Code extension), auto-reconnect on connection loss with exponential backoff (500ms → 30s) and ±25% jitter aligned with the Python SDK's `_LocalTransport`, queue-and-drain for messages during disconnection
