# Actual model-request inspection

Open **Generation details** from the session menu, or use the existing
Ctrl/Cmd+Shift+L shortcut. Select a saved reply and swipe. **Raw reply** keeps the
existing pre-parse model output available. **Actual request** appears after the
server confirms that the signed-in account owns both the card and that session.

Card ownership uses the existing `worlds.creatorId`, including recognized owners
of imported/read-only cards. The repository has no additional leader role.
Session ownership uses `playSessions.userId`. A card owner cannot inspect another
player’s private session; a player or administrator does not gain inspection
through that role alone. The receipt endpoint rechecks both permissions on every
read, independently of the UI capability check.

Receipts capture the final body handed to the HTTP transport for OpenAI,
OpenRouter, Anthropic, direct Google, custom-compatible endpoints and direct
Ollama. Provider shaping, image fitting and parameter retries happen before the
capture. Each saved send, regeneration and continuation has its own receipt.
Inspection creates no extra prompt or model call and does not alter the body.

The view shows allowlisted parameters and prompt sections in their wire order.
Credentials, authentication headers, credential fields/keys, URLs and image bytes
are redacted or omitted. The inspection copy is bounded; truncation and omitted
attempts are explicit. The original provider request is unaffected.

Provider-reported counters are captured before adapter estimates or missing-value
fallbacks. Missing counts stay unknown. Provider definitions differ, so cache and
reasoning counters may be separate. Counts describe the final attempt rather
than the sum of retries. The independent text estimate uses characters divided
by four; it is approximate, partial when truncated, and excludes image tokens and
protocol overhead.

Retention is process-local: 32 KiB per attempt, four recent attempts per
generation, four recent generations per swipe, 100 swipe keys and 4 MiB globally,
with individual receipts expiring after 30 minutes. There is no database change,
disk retention or shared cache. Bodies load only when the authorized request view
is opened; closing or changing the selection cancels stale reads.

Old, expired, evicted or unsuccessful generations, server restarts and requests
handled by another replica can show **No retained request**. Codex connections
are unsupported. Local-bridge connections are also unavailable because the
browser shapes their final runtime HTTP body after receiving a server job.
Neither connection is represented by a reconstructed request.

Only the dedicated private inspection API returns receipts. They are excluded
from ordinary session/message responses, stored swipe JSON, archives, shared
cards, sandbox props, logs and error payloads. Both endpoint responses and browser
fetches disable caching.
