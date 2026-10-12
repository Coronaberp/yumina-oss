# SFW and NSFW providers

Settings → AI config has two assignments:

- **SFW provider** selects the normal saved connection for Story.
- **NSFW provider** selects the connection for Little Idot and for Story when outgoing content is NSFW, uncertain, or cannot be checked.

Both assignments accept any owned saved provider profile. One profile can serve both. Selecting SFW activates private-key mode; selecting NSFW preserves the Story selection and model. Keys remain encrypted in the existing API-key storage.

On a local installation with `YUMINA_ADMIN_ACCOUNT_ID`, all accounts inherit the pinned administrator's SFW and NSFW profiles when they have no personal assignment for that slot. Story starts with the administrator's configured SFW default model and routes to the NSFW default when needed; Little Idot uses the NSFW default. Users can add and select their own profiles to override either slot. Clearing a personal assignment returns to the admin default. Administrator changes apply on the next provider resolution without copying keys or rewriting other accounts' preferences. Settings expose only the inherited provider name and model, never administrator profile IDs, endpoint URLs, headers or credentials. Existing protected-world restrictions still apply.

Little Idot always uses the NSFW profile's default model for tool loops, retries, summarization, tool decisions and image confirmation text. Image creation retains its separate image-provider configuration. Obsolete independent Studio preferences are ignored and removed on the next endpoint assignment; existing SFW/NSFW choices are preserved.

Story checks the actual outgoing complete messages before provider generation, including system context, history, offered choices and memory. SFW requires at least 95% SFW probability and at most 5% NSFW probability for every included source, with no explicit NSFW content or generation request. The displayed NSFW label still starts at 40%. Unsafe, uncertain and unsuccessful checks use NSFW before any content is sent to SFW. A literal whole-message guard conservatively reroutes explicit NSFW topics and requests even if the classifier reports high SFW confidence; quoted, negated or educational mentions can also reroute. The NSFW connection uses its saved default model. Context and image capability are checked against the actual destination. Protected worlds cannot expose hidden prompts to a private connection, and official requests cannot silently switch billing classes. An invalid configured NSFW provider blocks generation instead of substituting another connection.

Without an NSFW assignment, checks still run. A strongly safe request may use SFW, while unsafe, uncertain or unsuccessful checks block before transmission until a valid NSFW connection is selected. Selecting the same profile and its NSFW default model for Story explicitly uses that destination for all content. A different Story model on a shared connection still requires checks and switches to the saved NSFW default model when necessary. Provider role names do not certify a provider's content policies.

## Persistence

`GET /api/keys/content-endpoints` returns `{ data: { sfwApiKeyId, nsfwApiKeyId } }` for the authenticated owner. `PATCH` accepts either ID; `null` clears an assignment. Assignments require owned profiles and preserve other preferences. Deleting a profile clears only references that point to it.

SFW retains `user.preferences.activeApiKeyId` for compatibility; NSFW uses `nsfwApiKeyId`. Connection details and default models remain in `api_keys`. The inspector distinguishes successful SFW/NSFW predictions from pending, failed, missing and outdated checks.

Source: `packages/server/src/lib/story-provider.ts`, `story-content-routing.ts`, `saved-profile-provider.ts`, `studio-nsfw-provider.ts`, and the Story/Studio generation routes. Rebuild and restart the running backend to activate source changes.
