/** Persist useful provider categories, never raw messages which can echo
 * credentials, full request payloads or URLs supplied by a BYOK endpoint. */
export function providerFailureCode(message: string): string {
  const text = message.slice(0, 4000);
  if (/\b(?:401|403)\b|invalid.api.key|unauthori[sz]ed/i.test(text)) return "provider_auth";
  if (/\b429\b|rate.limit/i.test(text)) return "provider_rate_limit";
  if (/context.{0,20}(?:limit|length|exceed)|too.many.tokens/i.test(text)) return "provider_context_limit";
  if (/(?:unsupported|not.support|invalid).{0,40}(?:parameter|format|tool)|(?:parameter|format|tool).{0,40}(?:unsupported|not.support)/i.test(text)) return "provider_unsupported_format";
  if (/model.{0,40}(?:not.found|unavailable|not.exist)|no.endpoints/i.test(text)) return "provider_model_unavailable";
  if (/\b5\d\d\b|unavailable|overloaded/i.test(text)) return "provider_unavailable";
  return "provider_error";
}

/** Only negotiate away a specifically rejected JSON-output parameter. Generic
 * 400s, model errors, authentication/rate limits and failures after output must
 * not become hidden retries. The caller enforces the latter and the deadline. */
export function isJsonModeUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message.slice(0, 4000) : "";
  if (/\b(?:401|403|429|5\d\d)\b|unauthori[sz]ed|rate.limit|context.{0,20}(?:limit|length|exceed)/i.test(message)) return false;
  // Routers can reject a requested parameter before choosing an endpoint.
  // A bare "no endpoints" / unavailable-model error is deliberately excluded.
  if (/no endpoints found that support (?:the |your )?requested parameters/i.test(message)) return true;
  return /response[_ -]?format|json[_ -]?(?:object|schema)|responseMimeType|application\/json/i.test(message)
    && /not.support|unsupported|unrecognized|unknown.parameter|invalid.parameter|not.allowed|not.permitted/i.test(message);
}
