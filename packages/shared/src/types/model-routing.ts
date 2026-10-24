/** Server-derived routing for an accepted reply operation. The recorded reply
 * model remains the message/swipe's model; this describes the request route,
 * not an independently verified upstream checkpoint or provider identity. */
export interface ModelRoutingRecord {
  requestedModel: string;
  routedModel: string;
  reason?: "content-fallback" | "content-check-uncertain" | "profile-default";
}
