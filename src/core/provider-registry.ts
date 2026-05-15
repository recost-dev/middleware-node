/**
 * ProviderRegistry — matches intercepted request URLs to known API providers.
 *
 * Rules are checked in order; the first match wins. At construction time,
 * custom and built-in rules are merged and sorted by specificity (descending):
 *   1. Rules with `pathPrefix` come before rules without.
 *   2. Within those, longer `pathPrefix` beats shorter (more specific).
 *   3. Within those, exact host beats `*.` wildcard host.
 *   4. On equal specificity, custom rules beat built-in rules.
 *
 * This means a custom catch-all (no `pathPrefix`) for `api.openai.com` does NOT
 * shadow the built-in `/v1/chat/completions` rule — the built-in is more
 * specific. A custom rule with `pathPrefix: "/v1/chat/completions"` on the
 * same host DOES override the built-in (equal specificity → custom wins).
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
  /** Matched endpoint category (e.g. "chat_completions"), or "other" for catch-all matches. */
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

  // ── GitHub ────────────────────────────────────────────────────────────────
  { hostPattern: "api.github.com", pathPrefix: "/repos",  provider: "github", endpointCategory: "repos",   costPerRequestCents: 0 },
  { hostPattern: "api.github.com", pathPrefix: "/users",  provider: "github", endpointCategory: "users",   costPerRequestCents: 0 },
  { hostPattern: "api.github.com", pathPrefix: "/search", provider: "github", endpointCategory: "search",  costPerRequestCents: 0 },
  { hostPattern: "api.github.com",                         provider: "github",                              costPerRequestCents: 0 },

  // ── CoinGecko ─────────────────────────────────────────────────────────────
  { hostPattern: "api.coingecko.com", pathPrefix: "/api/v3/simple/price", provider: "coingecko", endpointCategory: "simple_price", costPerRequestCents: 0 },
  { hostPattern: "api.coingecko.com", pathPrefix: "/api/v3/coins",        provider: "coingecko", endpointCategory: "coins",         costPerRequestCents: 0 },
  { hostPattern: "api.coingecko.com",                                      provider: "coingecko",                                    costPerRequestCents: 0 },

  // ── Hacker News ───────────────────────────────────────────────────────────
  { hostPattern: "hacker-news.firebaseio.com", pathPrefix: "/v0/topstories", provider: "hackernews", endpointCategory: "topstories", costPerRequestCents: 0 },
  { hostPattern: "hacker-news.firebaseio.com", pathPrefix: "/v0/item",       provider: "hackernews", endpointCategory: "item",       costPerRequestCents: 0 },
  { hostPattern: "hacker-news.firebaseio.com",                                provider: "hackernews",                                 costPerRequestCents: 0 },

  // ── wttr.in (weather) ─────────────────────────────────────────────────────
  { hostPattern: "wttr.in", provider: "wttr", endpointCategory: "weather", costPerRequestCents: 0 },

  // ── ZenQuotes ─────────────────────────────────────────────────────────────
  { hostPattern: "zenquotes.io", provider: "zenquotes", endpointCategory: "random_quote", costPerRequestCents: 0 },

  // ── ip-api (geolocation) ──────────────────────────────────────────────────
  { hostPattern: "ip-api.com", provider: "ip-api", endpointCategory: "geolocation", costPerRequestCents: 0 },
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
  // Unrecognized Twilio path: fall back to "other" rather than the raw
  // pathname (which would include account SIDs and explode cardinality
  // downstream in the aggregator).
  return { endpointCategory: "other",         costPerRequestCents: 0.5  };
}

// ---------------------------------------------------------------------------
// ProviderRegistry
// ---------------------------------------------------------------------------

/** Compares two tagged rules by specificity descending (more specific first). */
function compareRules(
  a: { rule: ProviderDef; custom: boolean },
  b: { rule: ProviderDef; custom: boolean },
): number {
  // Tier 1: rules with pathPrefix come before rules without
  const aHasPath = a.rule.pathPrefix !== undefined ? 1 : 0;
  const bHasPath = b.rule.pathPrefix !== undefined ? 1 : 0;
  if (aHasPath !== bHasPath) return bHasPath - aHasPath;

  // Tier 2: longer pathPrefix wins (more specific)
  const aLen = a.rule.pathPrefix?.length ?? 0;
  const bLen = b.rule.pathPrefix?.length ?? 0;
  if (aLen !== bLen) return bLen - aLen;

  // Tier 3: exact host beats *. wildcard host
  const aExact = a.rule.hostPattern.startsWith("*.") ? 0 : 1;
  const bExact = b.rule.hostPattern.startsWith("*.") ? 0 : 1;
  if (aExact !== bExact) return bExact - aExact;

  // Tier 4: custom rules win on tie
  if (a.custom !== b.custom) return a.custom ? -1 : 1;

  return 0;
}

/** Maps intercepted request URLs to provider metadata using a priority-sorted rule list. */
export class ProviderRegistry {
  private readonly _rules: ProviderDef[];

  /**
   * @param customProviders - Optional extra rules. Merged with built-ins and
   *   sorted by specificity (longer `pathPrefix` first, exact host before
   *   wildcard, custom-wins-on-tie). See the class JSDoc for the full rule.
   */
  constructor(customProviders: ProviderDef[] = []) {
    const tagged: { rule: ProviderDef; custom: boolean }[] = [
      ...customProviders.map((rule) => ({ rule, custom: true })),
      ...BUILTIN_PROVIDERS.map((rule) => ({ rule, custom: false })),
    ];
    tagged.sort(compareRules);
    this._rules = tagged.map((t) => t.rule);
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

      // Host (and optional path) matched — build the result.
      // When the rule has no explicit endpointCategory and no provider-specific
      // refiner applies, fall back to the literal "other". Returning the raw
      // pathname here leaks account-SID-style segments into downstream buckets.
      let endpointCategory = rule.endpointCategory ?? "other";
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

  /** Returns all rules sorted by specificity (more-specific first; custom wins on tie). See the class JSDoc for the full ordering rule. */
  list(): ProviderDef[] {
    return this._rules;
  }
}
