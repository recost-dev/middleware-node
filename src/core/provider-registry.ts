/**
 * ProviderRegistry — matches intercepted request URLs to known API providers.
 *
 * Rules are checked in order; the first match wins. Custom providers are
 * prepended at construction time so they always take priority over built-ins.
 */

import { URL } from "node:url";
import type { ProviderDef } from "./types.js";

// ---------------------------------------------------------------------------
// MatchResult
// ---------------------------------------------------------------------------

/** The result of a successful registry lookup for a given URL. */
export interface MatchResult {
  /** Matched provider name (e.g. "openai"). */
  provider: string;
  /** Matched endpoint category (e.g. "chat_completions"), or the raw pathname. */
  endpointCategory: string;
  /** Estimated cost per request in cents. 0 when no cost data is available. */
  costPerRequestCents: number;
}

// ---------------------------------------------------------------------------
// Built-in provider definitions
// ---------------------------------------------------------------------------

/**
 * Built-in provider rules shipped with the SDK.
 * More-specific rules (with pathPrefix) must precede catch-alls for the same host.
 *
 * Cost estimates are rough per-request averages for relative comparison only —
 * actual costs vary by model, token count, and region.
 */
export const BUILTIN_PROVIDERS: ProviderDef[] = [
  // ── OpenAI ────────────────────────────────────────────────────────────────
  { hostPattern: "api.openai.com", pathPrefix: "/v1/chat/completions",    provider: "openai", endpointCategory: "chat_completions",    costPerRequestCents: 2.0  },
  { hostPattern: "api.openai.com", pathPrefix: "/v1/embeddings",          provider: "openai", endpointCategory: "embeddings",          costPerRequestCents: 0.01 },
  { hostPattern: "api.openai.com", pathPrefix: "/v1/images/generations",  provider: "openai", endpointCategory: "image_generation",    costPerRequestCents: 4.0  },
  { hostPattern: "api.openai.com", pathPrefix: "/v1/audio/transcriptions",provider: "openai", endpointCategory: "audio_transcription", costPerRequestCents: 0.6  },
  { hostPattern: "api.openai.com", pathPrefix: "/v1/audio/speech",        provider: "openai", endpointCategory: "text_to_speech",      costPerRequestCents: 1.5  },
  { hostPattern: "api.openai.com",                                         provider: "openai",                                          costPerRequestCents: 1.0  },

  // ── Anthropic ─────────────────────────────────────────────────────────────
  { hostPattern: "api.anthropic.com", pathPrefix: "/v1/messages", provider: "anthropic", endpointCategory: "messages", costPerRequestCents: 1.5 },
  { hostPattern: "api.anthropic.com",                              provider: "anthropic",                               costPerRequestCents: 1.0 },

  // ── Stripe ────────────────────────────────────────────────────────────────
  { hostPattern: "api.stripe.com", pathPrefix: "/v1/charges",          provider: "stripe", endpointCategory: "charges",          costPerRequestCents: 0 },
  { hostPattern: "api.stripe.com", pathPrefix: "/v1/payment_intents",  provider: "stripe", endpointCategory: "payment_intents",  costPerRequestCents: 0 },
  { hostPattern: "api.stripe.com", pathPrefix: "/v1/customers",        provider: "stripe", endpointCategory: "customers",        costPerRequestCents: 0 },
  { hostPattern: "api.stripe.com", pathPrefix: "/v1/subscriptions",    provider: "stripe", endpointCategory: "subscriptions",    costPerRequestCents: 0 },
  { hostPattern: "api.stripe.com",                                      provider: "stripe",                                       costPerRequestCents: 0 },

  // ── Twilio ────────────────────────────────────────────────────────────────
  // Path structure varies by account SID; categorization happens post-match in match().
  { hostPattern: "api.twilio.com", provider: "twilio", costPerRequestCents: 0.5 },

  // ── SendGrid ──────────────────────────────────────────────────────────────
  { hostPattern: "api.sendgrid.com", pathPrefix: "/v3/mail/send", provider: "sendgrid", endpointCategory: "send_email", costPerRequestCents: 0.1 },
  { hostPattern: "api.sendgrid.com",                               provider: "sendgrid",                                costPerRequestCents: 0   },

  // ── Pinecone ──────────────────────────────────────────────────────────────
  { hostPattern: "*.pinecone.io", pathPrefix: "/vectors/upsert", provider: "pinecone", endpointCategory: "vector_upsert", costPerRequestCents: 0.08 },
  { hostPattern: "*.pinecone.io", pathPrefix: "/query",          provider: "pinecone", endpointCategory: "vector_query",  costPerRequestCents: 0.08 },
  { hostPattern: "*.pinecone.io",                                 provider: "pinecone",                                    costPerRequestCents: 0.04 },

  // ── AWS ───────────────────────────────────────────────────────────────────
  // Wildcard covers all regional service hostnames (s3.us-east-1.amazonaws.com, etc.)
  { hostPattern: "*.amazonaws.com", provider: "aws", costPerRequestCents: 0 },

  // ── Google Cloud ──────────────────────────────────────────────────────────
  { hostPattern: "*.googleapis.com", provider: "gcp", costPerRequestCents: 0 },
];

// ---------------------------------------------------------------------------
// Host matching helpers
// ---------------------------------------------------------------------------

function hostMatches(pattern: string, hostname: string): boolean {
  if (pattern.startsWith("*.")) {
    // Wildcard: "*.amazonaws.com" matches "s3.us-east-1.amazonaws.com"
    return hostname.endsWith(pattern.slice(1)); // slice(1) → ".amazonaws.com"
  }
  return hostname === pattern;
}

// ---------------------------------------------------------------------------
// Twilio path refinement
// ---------------------------------------------------------------------------

/** Refines category and cost for Twilio after a host-level match. */
function refineTwilio(pathname: string): Pick<MatchResult, "endpointCategory" | "costPerRequestCents"> {
  if (pathname.includes("/Messages")) {
    return { endpointCategory: "sms",         costPerRequestCents: 0.79 };
  }
  if (pathname.includes("/Calls")) {
    return { endpointCategory: "voice_calls", costPerRequestCents: 1.3  };
  }
  return { endpointCategory: pathname,        costPerRequestCents: 0.5  };
}

// ---------------------------------------------------------------------------
// ProviderRegistry
// ---------------------------------------------------------------------------

/** Maps intercepted request URLs to provider metadata using an ordered rule list. */
export class ProviderRegistry {
  private readonly _rules: ProviderDef[];

  /**
   * @param customProviders - Optional extra rules prepended before built-ins,
   *   giving them higher matching priority.
   */
  constructor(customProviders: ProviderDef[] = []) {
    this._rules = [...customProviders, ...BUILTIN_PROVIDERS];
  }

  /**
   * Matches a full URL string against the rule list.
   * Returns the first matching MatchResult, or null if no rule applies.
   * Returns null for malformed URLs without throwing.
   */
  match(url: string): MatchResult | null {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }

    const { hostname, pathname } = parsed;

    for (const rule of this._rules) {
      if (!hostMatches(rule.hostPattern, hostname)) continue;
      if (rule.pathPrefix !== undefined && !pathname.startsWith(rule.pathPrefix)) continue;

      // Host (and optional path) matched — build the result
      let endpointCategory = rule.endpointCategory ?? pathname;
      let costPerRequestCents = rule.costPerRequestCents ?? 0;

      // Post-match refinement for providers with dynamic path structures
      if (rule.provider === "twilio" && rule.endpointCategory === undefined) {
        const refined = refineTwilio(pathname);
        endpointCategory = refined.endpointCategory;
        costPerRequestCents = refined.costPerRequestCents;
      }

      return { provider: rule.provider, endpointCategory, costPerRequestCents };
    }

    return null;
  }

  /** Returns all rules in priority order (custom first, built-ins after). */
  list(): ProviderDef[] {
    return this._rules;
  }
}
