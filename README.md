# @ecoapi/node

Node.js SDK for [EcoAPI](https://ecoapi.dev) — automatically tracks outbound HTTP API calls from your application and reports cost, latency, and usage patterns to the EcoAPI dashboard or your local VS Code extension.

## How it works

The SDK monkey-patches `fetch`, `http.request`, and `https.request` to intercept outbound requests at runtime. It captures metadata only (URL, method, status, latency, byte sizes — never headers or bodies), matches each request against a built-in provider registry, aggregates events into time-windowed summaries, and ships those summaries either to the EcoAPI cloud API or to the EcoAPI VS Code extension running locally.

```
Your app
  └─ fetch("https://api.openai.com/v1/chat/completions", ...)
       │
       ▼
  FetchInterceptor          ← patches globalThis.fetch
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
    └─ cloud mode  → HTTPS POST → api.ecoapi.dev
```

## Installation

```bash
npm install @ecoapi/node
```

## Quick start

### Local mode (VS Code extension)

No API key needed. Telemetry goes to the EcoAPI VS Code extension over localhost.

```ts
import { init } from "@ecoapi/node";

init(); // all defaults — local mode on port 9847
```

### Cloud mode

```ts
import { init } from "@ecoapi/node";

init({
  apiKey: process.env.ECOAPI_KEY,
  projectId: process.env.ECOAPI_PROJECT_ID,
  environment: process.env.NODE_ENV ?? "development",
});
```

### Express

```ts
import express from "express";
import { createExpressMiddleware } from "@ecoapi/node";

const app = express();
app.use(createExpressMiddleware({ apiKey: process.env.ECOAPI_KEY }));
```

### Fastify

```ts
import Fastify from "fastify";
import { createFastifyPlugin } from "@ecoapi/node";

const app = Fastify();
await app.register(createFastifyPlugin, { apiKey: process.env.ECOAPI_KEY });
```

## Configuration

All fields are optional.

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | — | EcoAPI API key. If omitted, runs in local mode. |
| `projectId` | `string` | — | EcoAPI project ID. Required in cloud mode. |
| `environment` | `string` | `"development"` | Environment tag attached to all telemetry. |
| `flushIntervalMs` | `number` | `30000` | Milliseconds between automatic flushes. |
| `maxBatchSize` | `number` | `100` | Early-flush threshold (number of events). |
| `localPort` | `number` | `9847` | WebSocket port for the VS Code extension. |
| `debug` | `boolean` | `false` | Log telemetry activity to stdout. |
| `enabled` | `boolean` | `true` | Master kill switch. Set `false` to disable in tests. |
| `customProviders` | `ProviderDef[]` | `[]` | Extra provider rules merged with higher priority than built-ins. |
| `excludePatterns` | `string[]` | `[]` | URL substrings that cause a request to be silently dropped. |
| `baseUrl` | `string` | `"https://api.ecoapi.dev"` | Override for self-hosted deployments. |
| `maxRetries` | `number` | `3` | Retry attempts for failed cloud flushes. |
| `onError` | `(err: Error) => void` | — | Called on internal SDK errors. |

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
import { ProviderRegistry, BUILTIN_PROVIDERS } from "@ecoapi/node";

// Default registry (built-ins only)
const registry = new ProviderRegistry();
const result = registry.match("https://api.openai.com/v1/chat/completions");
// → { provider: "openai", endpointCategory: "chat_completions", costPerRequestCents: 2 }

// Registry with custom rules taking priority
const custom = new ProviderRegistry([
  { hostPattern: "api.acme.com", provider: "acme", endpointCategory: "api", costPerRequestCents: 0.1 },
]);

// Inspect all loaded rules
console.log(BUILTIN_PROVIDERS.length); // 21 built-in rules
```

## What is captured (and what is not)

**Captured:**
- Request timestamp, method, URL (query params stripped), host, path
- Response status code
- Round-trip latency (ms)
- Request and response body size (bytes)
- Matched provider, endpoint category, and estimated cost

**Never captured:**
- Request or response headers (contain API keys)
- Request or response body content (may contain user data or PII)

## Core types

```ts
import type {
  RawEvent,
  MetricEntry,
  WindowSummary,
  EcoAPIConfig,
  ProviderDef,
  TransportMode,
} from "@ecoapi/node";
```

See [src/core/types.ts](src/core/types.ts) for full type documentation.

## Implementation status

| Module | Status |
|---|---|
| `core/types.ts` | Complete |
| `core/provider-registry.ts` | Complete — 21 built-in rules, wildcard host matching, custom provider priority |
| `core/interceptor.ts` | Complete — patches fetch, http.request, https.request + .get; double-count guard; safety wrappers |
| `core/aggregator.ts` | Complete — time-windowed bucketing, p50/p95 percentiles, cost estimation |
| `core/transport.ts` | Complete — HTTPS POST with retry (cloud), WebSocket with reconnect (local) |
| `init.ts` | Complete — wires all modules; exclude-patterns, early flush, debug logging |
| `frameworks/express.ts` | Complete — thin wrapper around `init()` |
| `frameworks/fastify.ts` | Complete — thin wrapper around `init()` |

## License

MIT © 2026 Andres Lopez, Aslan Wang, Donggyu Yoon
