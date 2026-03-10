import { describe, it, expect } from "vitest";
import { ProviderRegistry } from "../src/core/provider-registry.js";

describe("ProviderRegistry", () => {
  const registry = new ProviderRegistry();

  // ── OpenAI ────────────────────────────────────────────────────────────────

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
    expect(result?.endpointCategory).toBe("image_generation");
    expect(result?.costPerRequestCents).toBe(4.0);
  });

  it("OpenAI catch-all uses raw path as category", () => {
    const result = registry.match("https://api.openai.com/v1/some/new/endpoint");
    expect(result?.provider).toBe("openai");
    expect(result?.endpointCategory).toBe("/v1/some/new/endpoint");
    expect(result?.costPerRequestCents).toBe(1.0);
  });

  it("ignores query params — OpenAI chat still matches", () => {
    const result = registry.match("https://api.openai.com/v1/chat/completions?model=gpt-4");
    expect(result?.provider).toBe("openai");
    expect(result?.endpointCategory).toBe("chat_completions");
  });

  // ── Anthropic ─────────────────────────────────────────────────────────────

  it("matches Anthropic messages", () => {
    const result = registry.match("https://api.anthropic.com/v1/messages");
    expect(result?.provider).toBe("anthropic");
    expect(result?.endpointCategory).toBe("messages");
    expect(result?.costPerRequestCents).toBe(1.5);
  });

  it("Anthropic catch-all uses raw path", () => {
    const result = registry.match("https://api.anthropic.com/v1/complete");
    expect(result?.provider).toBe("anthropic");
    expect(result?.endpointCategory).toBe("/v1/complete");
  });

  // ── Stripe ────────────────────────────────────────────────────────────────

  it("matches Stripe charges", () => {
    const result = registry.match("https://api.stripe.com/v1/charges");
    expect(result?.provider).toBe("stripe");
    expect(result?.endpointCategory).toBe("charges");
    expect(result?.costPerRequestCents).toBe(0);
  });

  it("matches Stripe payment_intents", () => {
    const result = registry.match("https://api.stripe.com/v1/payment_intents");
    expect(result?.endpointCategory).toBe("payment_intents");
  });

  // ── Twilio ────────────────────────────────────────────────────────────────

  it("matches Twilio SMS", () => {
    const result = registry.match("https://api.twilio.com/2010-04-01/Accounts/ACxxx/Messages.json");
    expect(result?.provider).toBe("twilio");
    expect(result?.endpointCategory).toBe("sms");
    expect(result?.costPerRequestCents).toBe(0.79);
  });

  it("matches Twilio voice calls", () => {
    const result = registry.match("https://api.twilio.com/2010-04-01/Accounts/ACxxx/Calls.json");
    expect(result?.provider).toBe("twilio");
    expect(result?.endpointCategory).toBe("voice_calls");
    expect(result?.costPerRequestCents).toBe(1.3);
  });

  it("Twilio catch-all for unrecognized paths", () => {
    const result = registry.match("https://api.twilio.com/2010-04-01/Accounts/ACxxx/Recordings.json");
    expect(result?.provider).toBe("twilio");
    expect(result?.costPerRequestCents).toBe(0.5);
  });

  // ── SendGrid ──────────────────────────────────────────────────────────────

  it("matches SendGrid send email", () => {
    const result = registry.match("https://api.sendgrid.com/v3/mail/send");
    expect(result?.provider).toBe("sendgrid");
    expect(result?.endpointCategory).toBe("send_email");
    expect(result?.costPerRequestCents).toBe(0.1);
  });

  // ── Pinecone ──────────────────────────────────────────────────────────────

  it("matches Pinecone query via wildcard host", () => {
    const result = registry.match("https://my-index-abc123.svc.us-east1-gcp.pinecone.io/query");
    expect(result?.provider).toBe("pinecone");
    expect(result?.endpointCategory).toBe("vector_query");
    expect(result?.costPerRequestCents).toBe(0.08);
  });

  it("matches Pinecone upsert via wildcard host", () => {
    const result = registry.match("https://my-index.svc.pinecone.io/vectors/upsert");
    expect(result?.provider).toBe("pinecone");
    expect(result?.endpointCategory).toBe("vector_upsert");
  });

  it("Pinecone catch-all for other paths", () => {
    const result = registry.match("https://my-index.svc.pinecone.io/describe_index_stats");
    expect(result?.provider).toBe("pinecone");
    expect(result?.costPerRequestCents).toBe(0.04);
  });

  // ── AWS ───────────────────────────────────────────────────────────────────

  it("matches AWS S3 via wildcard host", () => {
    const result = registry.match("https://s3.us-east-1.amazonaws.com/my-bucket/file.json");
    expect(result?.provider).toBe("aws");
    expect(result?.costPerRequestCents).toBe(0);
  });

  it("matches another AWS service hostname", () => {
    const result = registry.match("https://lambda.us-west-2.amazonaws.com/2015-03-31/functions");
    expect(result?.provider).toBe("aws");
  });

  // ── Google Cloud ──────────────────────────────────────────────────────────

  it("matches Google Cloud Storage via wildcard host", () => {
    const result = registry.match("https://storage.googleapis.com/bucket/object");
    expect(result?.provider).toBe("gcp");
    expect(result?.costPerRequestCents).toBe(0);
  });

  it("matches another GCP service hostname", () => {
    const result = registry.match("https://bigquery.googleapis.com/bigquery/v2/projects");
    expect(result?.provider).toBe("gcp");
  });

  // ── No match ──────────────────────────────────────────────────────────────

  it("returns null for an unknown URL", () => {
    const result = registry.match("https://my-internal-api.company.com/users");
    expect(result).toBeNull();
  });

  it("returns null for a malformed URL", () => {
    const result = registry.match("not-a-url");
    expect(result).toBeNull();
  });

  // ── Custom provider priority ───────────────────────────────────────────────

  it("custom rule for OpenAI path takes priority over built-in", () => {
    const custom = new ProviderRegistry([
      {
        hostPattern: "api.openai.com",
        pathPrefix: "/v1/chat",
        provider: "my-openai-wrapper",
        endpointCategory: "custom_chat",
        costPerRequestCents: 99,
      },
    ]);
    const result = custom.match("https://api.openai.com/v1/chat/completions");
    expect(result?.provider).toBe("my-openai-wrapper");
    expect(result?.endpointCategory).toBe("custom_chat");
    expect(result?.costPerRequestCents).toBe(99);
  });

  it("custom rule for unknown host matches correctly", () => {
    const custom = new ProviderRegistry([
      {
        hostPattern: "api.acme.com",
        pathPrefix: "/payments",
        provider: "acme",
        endpointCategory: "charge",
        costPerRequestCents: 0.5,
      },
    ]);
    const result = custom.match("https://api.acme.com/payments/create");
    expect(result?.provider).toBe("acme");
    expect(result?.endpointCategory).toBe("charge");
    expect(result?.costPerRequestCents).toBe(0.5);
  });

  it("custom rule does not affect unrelated URLs", () => {
    const custom = new ProviderRegistry([
      { hostPattern: "api.acme.com", provider: "acme" },
    ]);
    expect(custom.match("https://api.openai.com/v1/embeddings")?.provider).toBe("openai");
    expect(custom.match("https://my-internal-api.company.com/users")).toBeNull();
  });

  // ── list() ────────────────────────────────────────────────────────────────

  it("list() returns custom rules before built-ins", () => {
    const custom = new ProviderRegistry([
      { hostPattern: "api.acme.com", provider: "acme" },
    ]);
    const rules = custom.list();
    expect(rules[0]?.provider).toBe("acme");
  });
});
