/**
 * Tests for src/core/provider-registry.ts
 *
 * Covers: built-in provider matching, edge cases, custom provider priority,
 * wildcard hosts, Twilio refinement, BUILTIN_PROVIDERS array shape.
 */

import { describe, it, expect } from "vitest";
import { ProviderRegistry, BUILTIN_PROVIDERS } from "../src/core/provider-registry.js";

describe("built-in providers", () => {
  const registry = new ProviderRegistry();

  // ── OpenAI ─────────────────────────────────────────────────────────────────

  it("matches OpenAI chat completions", () => {
    const result = registry.match("https://api.openai.com/v1/chat/completions");
    expect(result).toEqual({
      provider: "openai",
      endpointCategory: "chat_completions",
      costPerRequestCents: 2.0,
    });
  });

  it("matches OpenAI embeddings", () => {
    const result = registry.match("https://api.openai.com/v1/embeddings");
    expect(result?.provider).toBe("openai");
    expect(result?.endpointCategory).toBe("embeddings");
    expect(result?.costPerRequestCents).toBe(0.01);
  });

  it("matches OpenAI image generation", () => {
    const result = registry.match("https://api.openai.com/v1/images/generations");
    expect(result?.provider).toBe("openai");
    expect(result?.endpointCategory).toBe("image_generation");
    expect(result?.costPerRequestCents).toBe(4.0);
  });

  it("matches OpenAI audio transcription", () => {
    const result = registry.match("https://api.openai.com/v1/audio/transcriptions");
    expect(result?.provider).toBe("openai");
    expect(result?.endpointCategory).toBe("audio_transcription");
  });

  it("matches OpenAI text-to-speech", () => {
    const result = registry.match("https://api.openai.com/v1/audio/speech");
    expect(result?.provider).toBe("openai");
    expect(result?.endpointCategory).toBe("text_to_speech");
  });

  it("matches OpenAI catch-all for unknown path — uses raw pathname as category", () => {
    const result = registry.match("https://api.openai.com/v1/some/future/endpoint");
    expect(result?.provider).toBe("openai");
    expect(result?.endpointCategory).toBe("/v1/some/future/endpoint");
    expect(result?.costPerRequestCents).toBe(1.0);
  });

  // ── Anthropic ──────────────────────────────────────────────────────────────

  it("matches Anthropic messages", () => {
    const result = registry.match("https://api.anthropic.com/v1/messages");
    expect(result?.provider).toBe("anthropic");
    expect(result?.endpointCategory).toBe("messages");
    expect(result?.costPerRequestCents).toBe(1.5);
  });

  it("matches Anthropic catch-all for unknown path", () => {
    const result = registry.match("https://api.anthropic.com/v1/complete");
    expect(result?.provider).toBe("anthropic");
    expect(result?.endpointCategory).toBe("/v1/complete");
  });

  // ── Stripe ─────────────────────────────────────────────────────────────────

  it("matches Stripe charges", () => {
    const result = registry.match("https://api.stripe.com/v1/charges");
    expect(result?.provider).toBe("stripe");
    expect(result?.endpointCategory).toBe("charges");
    expect(result?.costPerRequestCents).toBe(0);
  });

  it("matches Stripe payment intents", () => {
    const result = registry.match("https://api.stripe.com/v1/payment_intents");
    expect(result?.provider).toBe("stripe");
    expect(result?.endpointCategory).toBe("payment_intents");
  });

  it("matches Stripe customers", () => {
    const result = registry.match("https://api.stripe.com/v1/customers");
    expect(result?.provider).toBe("stripe");
    expect(result?.endpointCategory).toBe("customers");
  });

  it("matches Stripe subscriptions", () => {
    const result = registry.match("https://api.stripe.com/v1/subscriptions");
    expect(result?.provider).toBe("stripe");
    expect(result?.endpointCategory).toBe("subscriptions");
  });

  it("matches Stripe catch-all", () => {
    const result = registry.match("https://api.stripe.com/v1/refunds");
    expect(result?.provider).toBe("stripe");
    expect(result?.costPerRequestCents).toBe(0);
  });

  // ── Twilio ─────────────────────────────────────────────────────────────────

  it("matches Twilio SMS", () => {
    const result = registry.match(
      "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json",
    );
    expect(result?.provider).toBe("twilio");
    expect(result?.endpointCategory).toBe("sms");
    expect(result?.costPerRequestCents).toBe(0.79);
  });

  it("matches Twilio voice calls", () => {
    const result = registry.match(
      "https://api.twilio.com/2010-04-01/Accounts/AC123/Calls.json",
    );
    expect(result?.provider).toBe("twilio");
    expect(result?.endpointCategory).toBe("voice_calls");
    expect(result?.costPerRequestCents).toBe(1.3);
  });

  it("matches Twilio catch-all for unrecognized paths — uses raw pathname", () => {
    const result = registry.match(
      "https://api.twilio.com/2010-04-01/Accounts/AC123/Usage.json",
    );
    expect(result?.provider).toBe("twilio");
    expect(result?.costPerRequestCents).toBe(0.5);
    // endpoint should be the raw pathname
    expect(typeof result?.endpointCategory).toBe("string");
    expect(result?.endpointCategory).toContain("/");
  });

  // ── SendGrid ───────────────────────────────────────────────────────────────

  it("matches SendGrid mail send", () => {
    const result = registry.match("https://api.sendgrid.com/v3/mail/send");
    expect(result?.provider).toBe("sendgrid");
    expect(result?.endpointCategory).toBe("send_email");
    expect(result?.costPerRequestCents).toBe(0.1);
  });

  it("matches SendGrid catch-all", () => {
    const result = registry.match("https://api.sendgrid.com/v3/templates");
    expect(result?.provider).toBe("sendgrid");
    expect(result?.costPerRequestCents).toBe(0);
  });

  // ── Pinecone ───────────────────────────────────────────────────────────────

  it("matches Pinecone vector upsert via wildcard host", () => {
    const result = registry.match("https://my-index-abc.svc.pinecone.io/vectors/upsert");
    expect(result?.provider).toBe("pinecone");
    expect(result?.endpointCategory).toBe("vector_upsert");
    expect(result?.costPerRequestCents).toBe(0.08);
  });

  it("matches Pinecone query via wildcard host", () => {
    const result = registry.match(
      "https://my-index-abc.svc.us-east1-gcp.pinecone.io/query",
    );
    expect(result?.provider).toBe("pinecone");
    expect(result?.endpointCategory).toBe("vector_query");
    expect(result?.costPerRequestCents).toBe(0.08);
  });

  it("matches Pinecone catch-all for other paths", () => {
    const result = registry.match(
      "https://my-index.svc.pinecone.io/describe_index_stats",
    );
    expect(result?.provider).toBe("pinecone");
    expect(result?.costPerRequestCents).toBe(0.04);
  });

  // ── AWS ────────────────────────────────────────────────────────────────────

  it("matches AWS wildcard — S3 regional hostname", () => {
    const result = registry.match(
      "https://s3.us-east-1.amazonaws.com/bucket/key",
    );
    expect(result?.provider).toBe("aws");
    expect(result?.costPerRequestCents).toBe(0);
  });

  it("matches AWS wildcard — Lambda hostname", () => {
    const result = registry.match(
      "https://lambda.us-west-2.amazonaws.com/2015-03-31/functions",
    );
    expect(result?.provider).toBe("aws");
  });

  // ── Google Cloud ───────────────────────────────────────────────────────────

  it("matches GCP wildcard — Cloud Storage hostname", () => {
    const result = registry.match(
      "https://storage.googleapis.com/bucket/object",
    );
    expect(result?.provider).toBe("gcp");
    expect(result?.costPerRequestCents).toBe(0);
  });

  it("matches GCP wildcard — BigQuery hostname", () => {
    const result = registry.match(
      "https://bigquery.googleapis.com/bigquery/v2/projects",
    );
    expect(result?.provider).toBe("gcp");
  });
});

// ---------------------------------------------------------------------------

describe("unrecognized and edge cases", () => {
  const registry = new ProviderRegistry();

  it("returns null for unknown host", () => {
    expect(registry.match("https://my-internal-api.company.com/users")).toBeNull();
  });

  it("returns null for malformed URL", () => {
    expect(registry.match("not-a-url")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(registry.match("")).toBeNull();
  });

  it("strips query params correctly — OpenAI chat still matches", () => {
    const result = registry.match(
      "https://api.openai.com/v1/chat/completions?model=gpt-4&stream=true",
    );
    expect(result?.provider).toBe("openai");
    expect(result?.endpointCategory).toBe("chat_completions");
  });

  it("handles URL with explicit port 443 — OpenAI still matches", () => {
    const result = registry.match(
      "https://api.openai.com:443/v1/chat/completions",
    );
    expect(result?.provider).toBe("openai");
    expect(result?.endpointCategory).toBe("chat_completions");
  });

  it("handles URL with trailing slash on path prefix", () => {
    const result = registry.match(
      "https://api.anthropic.com/v1/messages/batch",
    );
    // path starts with /v1/messages → matches the messages rule
    expect(result?.provider).toBe("anthropic");
    expect(result?.endpointCategory).toBe("messages");
  });
});

// ---------------------------------------------------------------------------

describe("custom providers", () => {
  it("custom provider takes priority over built-in for same host+path", () => {
    const registry = new ProviderRegistry([
      {
        hostPattern: "api.openai.com",
        pathPrefix: "/v1/chat",
        provider: "custom-openai",
        endpointCategory: "custom_chat",
        costPerRequestCents: 99,
      },
    ]);
    const result = registry.match("https://api.openai.com/v1/chat/completions");
    expect(result?.provider).toBe("custom-openai");
    expect(result?.endpointCategory).toBe("custom_chat");
    expect(result?.costPerRequestCents).toBe(99);
  });

  it("custom provider for a brand-new host matches correctly", () => {
    const registry = new ProviderRegistry([
      {
        hostPattern: "api.acme.com",
        pathPrefix: "/payments",
        provider: "acme",
        endpointCategory: "charge",
        costPerRequestCents: 0.5,
      },
    ]);
    const result = registry.match("https://api.acme.com/payments/create");
    expect(result?.provider).toBe("acme");
    expect(result?.endpointCategory).toBe("charge");
    expect(result?.costPerRequestCents).toBe(0.5);
  });

  it("custom provider without pathPrefix matches all paths on that host", () => {
    const registry = new ProviderRegistry([
      {
        hostPattern: "internal.api.com",
        provider: "internal",
        endpointCategory: "any",
        costPerRequestCents: 0,
      },
    ]);
    expect(registry.match("https://internal.api.com/users")?.provider).toBe("internal");
    expect(registry.match("https://internal.api.com/orders/123")?.provider).toBe("internal");
    expect(registry.match("https://internal.api.com/")?.provider).toBe("internal");
  });

  it("custom provider does not affect other built-in providers", () => {
    const registry = new ProviderRegistry([
      { hostPattern: "api.acme.com", provider: "acme" },
    ]);
    // Built-ins still work
    expect(registry.match("https://api.openai.com/v1/embeddings")?.provider).toBe("openai");
    expect(registry.match("https://api.stripe.com/v1/charges")?.provider).toBe("stripe");
    // Unknown host still returns null
    expect(registry.match("https://unknown.example.com/")).toBeNull();
  });

  it("custom rule via list() appears before built-in rules", () => {
    const registry = new ProviderRegistry([
      { hostPattern: "api.acme.com", provider: "acme" },
    ]);
    const rules = registry.list();
    expect(rules[0]?.provider).toBe("acme");
    // Built-in rules follow after
    expect(rules.some((r) => r.provider === "openai")).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("BUILTIN_PROVIDERS array", () => {
  it("has exactly 21 rules", () => {
    expect(BUILTIN_PROVIDERS).toHaveLength(21);
  });

  it("all rules have a hostPattern and provider", () => {
    for (const rule of BUILTIN_PROVIDERS) {
      expect(typeof rule.hostPattern).toBe("string");
      expect(rule.hostPattern.length).toBeGreaterThan(0);
      expect(typeof rule.provider).toBe("string");
      expect(rule.provider.length).toBeGreaterThan(0);
    }
  });

  it("OpenAI specific rules appear before the OpenAI catch-all", () => {
    const openaiRules = BUILTIN_PROVIDERS
      .map((r, i) => ({ rule: r, index: i }))
      .filter((x) => x.rule.provider === "openai");

    const catchAll = openaiRules.find((x) => x.rule.pathPrefix === undefined);
    const specific = openaiRules.filter((x) => x.rule.pathPrefix !== undefined);

    expect(catchAll).toBeDefined();
    expect(specific.length).toBeGreaterThan(0);

    // Every specific rule should come before the catch-all
    for (const s of specific) {
      expect(s.index).toBeLessThan(catchAll!.index);
    }
  });

  it("Stripe specific rules appear before the Stripe catch-all", () => {
    const stripeRules = BUILTIN_PROVIDERS
      .map((r, i) => ({ rule: r, index: i }))
      .filter((x) => x.rule.provider === "stripe");

    const catchAll = stripeRules.find((x) => x.rule.pathPrefix === undefined);
    const specific = stripeRules.filter((x) => x.rule.pathPrefix !== undefined);

    expect(catchAll).toBeDefined();
    for (const s of specific) {
      expect(s.index).toBeLessThan(catchAll!.index);
    }
  });

  it("Pinecone specific rules appear before the Pinecone catch-all", () => {
    const pineconeRules = BUILTIN_PROVIDERS
      .map((r, i) => ({ rule: r, index: i }))
      .filter((x) => x.rule.provider === "pinecone");

    const catchAll = pineconeRules.find((x) => x.rule.pathPrefix === undefined);
    const specific = pineconeRules.filter((x) => x.rule.pathPrefix !== undefined);

    expect(catchAll).toBeDefined();
    for (const s of specific) {
      expect(s.index).toBeLessThan(catchAll!.index);
    }
  });
});
