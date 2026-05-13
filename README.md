# @recost-dev/node

Node.js SDK for [ReCost](https://recost.dev) — automatically tracks outbound HTTP API calls from your application and reports cost, latency, and usage patterns to the ReCost dashboard or your local VS Code extension.

## How it works

The SDK monkey-patches `fetch`, `http.request`, and `https.request` to intercept outbound requests at runtime. It captures metadata only (URL, method, status, latency, byte sizes — never headers or bodies), matches each request against a built-in provider registry, aggregates events into time-windowed summaries, and ships those summaries either to the ReCost cloud API or to the ReCost VS Code extension running locally.

```
Your app
  └─ fetch("https://api.openai.com/v1/chat/completions", ...)
       │
       ▼
  Interceptor               ← patches globalThis.fetch, http.request, https.request
       │  RawEvent { host, path, method, statusCode, latencyMs, ... }
       ▼
  ProviderRegistry          ← matches host/path → provider + endpointCategory + cost
       │
       ▼
  Aggregator                ← buffers events, flushes WindowSummary every 30s
       │
       ▼
  Transport
    ├─ local mode  → WebSocket  → VS Code extension (port 9847)
    └─ cloud mode  → HTTPS POST → api.recost.dev
```

## Installation

```bash
npm install @recost-dev/node
```

## Quick start

### Local mode (VS Code extension)

No API key needed. Telemetry goes to the ReCost VS Code extension over localhost.

```ts
import { init } from "@recost-dev/node";

init(); // all defaults — local mode on port 9847
```

### Cloud mode

```ts
import { init } from "@recost-dev/node";

init({
  apiKey: process.env.RECOST_API_KEY,
  projectId: process.env.RECOST_PROJECT_ID,
  environment: process.env.NODE_ENV ?? "development",
});
```

### Express

```ts
import express from "express";
import { createExpressMiddleware } from "@recost-dev/node";

const app = express();
app.use(createExpressMiddleware({ apiKey: process.env.RECOST_API_KEY }));
```

### Fastify

```ts
import Fastify from "fastify";
import { createFastifyPlugin } from "@recost-dev/node";

const app = Fastify();
await app.register(createFastifyPlugin, { apiKey: process.env.RECOST_API_KEY });
```

## Configuration

All fields are optional.

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | — | ReCost API key (`rc-...`). If omitted, runs in local mode. |
| `projectId` | `string` | — | ReCost project ID. Required in cloud mode. |
| `environment` | `string` | `"development"` | Environment tag attached to all telemetry. |
| `flushIntervalMs` | `number` | `30000` | Milliseconds between automatic flushes. |
| `maxBatchSize` | `number` | `100` | Early-flush threshold (number of events). |
| `maxBuckets` | `number` | `2000` | Maximum unique `(provider, endpoint, method)` triplets per window. Crossing this triggers an early flush so the cloud API does not reject the payload with a 422. |
| `localPort` | `number` | `9847` | WebSocket port for the VS Code extension. |
| `debug` | `boolean` | `false` | Log telemetry activity to stdout. |
| `enabled` | `boolean` | `true` | Master kill switch. Set `false` to disable in tests. |
| `customProviders` | `ProviderDef[]` | `[]` | Extra provider rules merged with higher priority than built-ins. |
| `excludePatterns` | `string[]` | `[]` | URL substrings that cause a request to be silently dropped. |
| `baseUrl` | `string` | `"https://api.recost.dev"` | Override for self-hosted deployments. |
| `maxRetries` | `number` | `3` | Retry attempts for failed cloud flushes. |
| `maxWsQueueSize` | `number` | `1000` | Local mode only — maximum serialized `WindowSummary` payloads buffered while the VS Code extension is unreachable. When full, the oldest payload is dropped (FIFO) and `onError` fires exactly once per overflow episode. The flag resets when the queue drains to empty (extension reconnects). |
| `shutdownFlushTimeoutMs` | `number` | `3000` | Milliseconds `dispose()` waits for the final shutdown flush to complete before closing the transport. |
| `onError` | `(err: Error) => void` | — | Called on internal SDK errors. |

### Validation

`init()` validates the cloud-mode config synchronously and throws if it would put the SDK in a known-broken state:

- `apiKey` must be a string starting with `rc-`. The literal string `"undefined"` (a common env-var misread) is rejected.
- `projectId` is required and must be non-empty whenever `apiKey` is set.

Local mode (no `apiKey`) imposes no validation — useful in tests and during local development. Wrap `init()` in a try/catch if a misconfigured environment should not crash your host process.

### Custom providers

```ts
init({
  customProviders: [
    {
      hostPattern: "api.internal.acme.com",
      pathPrefix: "/payments",
      provider: "acme-payments",
      endpointCategory: "charge",
      costPerRequestCents: 0.5,
    },
  ],
});
```

### Cleanup / teardown

`init()` returns a handle with a `dispose()` method that stops the interceptor, cancels the flush timer, and closes the transport connection. Useful in tests or when you want to reinitialize with different config.

```ts
const recost = init({ apiKey: process.env.RECOST_API_KEY });

// Later — e.g. in a test afterAll() or process shutdown handler:
recost.dispose();
```

### Disabling in tests

```ts
init({ enabled: process.env.NODE_ENV !== "test" });
```

## Supported providers

The registry ships with built-in rules for these providers. Cost estimates are rough per-request averages for relative comparison — actual costs vary by model, token count, and region.

| Provider | Host | Tracked endpoints | Cost estimate |
|---|---|---|---|
| **OpenAI** | `api.openai.com` | chat completions, embeddings, image generation, audio transcription, TTS | 0.01–4.0¢/req |
| **Anthropic** | `api.anthropic.com` | messages | 1.5¢/req |
| **Stripe** | `api.stripe.com` | charges, payment intents, customers, subscriptions | 0¢ (% billing) |
| **Twilio** | `api.twilio.com` | SMS, voice calls | 0.79–1.3¢/req |
| **SendGrid** | `api.sendgrid.com` | mail send | 0.1¢/req |
| **Pinecone** | `*.pinecone.io` | vector upsert, query | 0.08¢/req |
| **AWS** | `*.amazonaws.com` | all services (wildcard) | 0¢ (complex pricing) |
| **Google Cloud** | `*.googleapis.com` | all services (wildcard) | 0¢ (complex pricing) |

Unrecognized hosts produce a `RawEvent` with `provider: null` — they still appear in telemetry grouped under `"unknown"`.

### Using the registry directly

```ts
import { ProviderRegistry, BUILTIN_PROVIDERS } from "@recost-dev/node";

// Default registry (built-ins only)
const registry = new ProviderRegistry();
const result = registry.match("https://api.openai.com/v1/chat/completions");
// → { provider: "openai", endpointCategory: "chat_completions", costPerRequestCents: 2 }

// Registry with custom rules taking priority
const custom = new ProviderRegistry([
  { hostPattern: "api.acme.com", provider: "acme", endpointCategory: "api", costPerRequestCents: 0.1 },
]);

// Inspect all loaded rules
console.log(BUILTIN_PROVIDERS.length); // 34 built-in rules
```

## What is captured (and what is not)

**Captured:**
- Request timestamp, method, URL (query params stripped), host, path
- Response status code
- Round-trip latency (ms) — measured to **end of response body**, identically for `fetch` and `http.request` / `https.request`. For a streaming response this is the full stream duration, not time-to-first-byte.
- Request and response body size (bytes) — for streamed / chunked responses where the server does not send a `Content-Length` header, the SDK accumulates the observed byte count as the response body is transmitted. Bodyless responses (e.g. 204, 304, HEAD) fall back to the `Content-Length` header (typically 0).
- Matched provider, endpoint category, and estimated cost

**Never captured:**
- Request or response headers (contain API keys)
- Request or response body content (may contain user data or PII) — the SDK observes byte counts via a passthrough stream but never reads chunk contents.

## Core types

```ts
import type {
  RawEvent,
  MetricEntry,
  WindowSummary,
  RecostConfig,
  ProviderDef,
  TransportMode,
  FlushStatus,
} from "@recost-dev/node";
```

See [src/core/types.ts](src/core/types.ts) for full type documentation.

## Testing

Run the full test suite (174 tests across 9 files):

```bash
npm test
```

Watch mode during development:

```bash
npm run test:watch
```

TypeScript type-check only (does not run tests):

```bash
npm run lint
```

### Test coverage

| File | Tests | What is covered |
|---|---|---|
| `tests/provider-registry.test.ts` | 42 | All 34 built-in provider rules, wildcard host matching, Twilio path refinement, edge cases (empty string, explicit port, query params), custom provider priority, `BUILTIN_PROVIDERS` array ordering and pinned-count regression |
| `tests/interceptor.test.ts` | 32 | Lifecycle (install/uninstall/isInstalled), fetch/http.request/http.get capture, query stripping, URL/Request object inputs, safety wrappers (throwing callback), `getRawFetch` bypass, double-count guard |
| `tests/aggregator.test.ts` | 34 | Flush/reset, event grouping, p50/p95 percentile edge cases, null provider/endpoint fallbacks, window timestamps, metadata forwarding, size/bucketCount tracking |
| `tests/transport.test.ts` | 19 | Cloud mode POST (URL path, auth header, 4xx no-retry, 5xx retry + recovery, `onError`), WebSocket mode (send, queue-and-drain, dispose closes connection), rejection signalling |
| `tests/init.test.ts` | 23 | Interceptor install/dispose, `enabled: false`, double-init, event enrichment, unknown provider grouping, exclude patterns, auto-exclude transport URL, flush interval, early batch flush, dispose stops capture |
| `tests/contract.test.ts` | 9 | Wire-format contract: serialized `WindowSummary` shape, field names, and types match what the cloud API expects |
| `tests/express.test.ts` | 6 | Middleware arity, `next()` called without error, config forwarding |
| `tests/fastify.test.ts` | 4 | `done()` called, config forwarding |
| `tests/scaffold.test.ts` | 5 | Public export smoke tests |

## Implementation status

| Module | Status |
|---|---|
| `core/types.ts` | Complete |
| `core/provider-registry.ts` | Complete — 34 built-in rules across 14 providers, wildcard host matching, custom provider priority |
| `core/interceptor.ts` | Complete — patches fetch, http.request, https.request + .get; double-count guard; safety wrappers |
| `core/aggregator.ts` | Complete — time-windowed bucketing, p50/p95 percentiles, cost estimation |
| `core/transport.ts` | Complete — HTTPS POST with retry (cloud), WebSocket with reconnect (local) |
| `init.ts` | Complete — wires all modules; exclude-patterns, early flush, debug logging |
| `frameworks/express.ts` | Complete — thin wrapper around `init()` |
| `frameworks/fastify.ts` | Complete — thin wrapper around `init()` |

## API reference

All requests go to `https://api.recost.dev`. Authentication uses an `rc-` prefixed API key passed as `Authorization: Bearer {apiKey}`.

### Send telemetry manually (what the SDK does on flush)

```bash
curl -s -X POST https://api.recost.dev/projects/{projectId}/telemetry \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {apiKey}" \
  -d @payload.json | jq .
```

### View recent telemetry windows

```bash
curl -s "https://api.recost.dev/projects/{projectId}/telemetry/recent?limit=10" \
  -H "Authorization: Bearer {apiKey}" | jq .
```

### View analytics for a project

```bash
curl -s "https://api.recost.dev/projects/{projectId}/analytics?from=2026-01-01T00:00:00Z&to=2026-12-31T23:59:59Z" \
  -H "Authorization: Bearer {apiKey}" | jq .
```

## License

Licensed under the [Business Source License 1.1](./LICENSE). You may use this software in production, but you may not offer it as a commercial API cost tracking or monitoring service. The source code will convert to Apache 2.0 on April 1, 2030.
