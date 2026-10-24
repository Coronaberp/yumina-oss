# Personal Music DJ development status

The Music DJ core and the accepted **single visible YouTube player with personal saved links** are implemented on an isolated development branch. Uploaded audio retains simultaneous SFX and 60% BGM ducking. YouTube cues interrupt and then resume BGM through one official player.

**Real YouTube playback has not been verified.** Automatic approval review denied the proposed public-video browser test before execution. Mocked tests and browser checks are described below. No push, merge, deployment, live-data changes, real model calls, search calls or credential configuration occurred.

## Sources the agent can actually choose

| Source | Current behavior |
| --- | --- |
| Uploaded session audio | Up to 100 BGM/SFX tracks from the current world's existing `audioTracks`, using `@asset:` references only. SFX requires an authored positive `maxDuration` of at most 30 seconds, played from 0 to that declared boundary. |
| Personal YouTube saved links | Up to 100 account-local entries, with a user-supplied musical label and a strictly parsed video ID. Whole-video BGM or a user-verified BGM segment; one-shot cues require a verified range of at most 30 seconds. The model selects only catalog IDs and exact declared cue ranges. |
| YouTube search / Google Cloud key | Not implemented or collected. Search remains explicitly disabled. Known video IDs use the official IFrame API without adding Data API search. |

Source starts unconfigured, model opt-in defaults off, and YouTube disclosure consent separately defaults off. Personal Settings → AI configuration contains provider/model selection, musical preferences, duration cap and the saved-link editor. These values stay in this browser, keyed by account; VN mode is keyed by account and session. Personal saved links are not creator content, card/export data or server settings.

The catalog accepts exact video IDs or HTTPS `youtube.com` / `youtu.be` video links. It rejects arbitrary hosts, schemes, credentials, ports, malformed IDs and invalid timestamps. Tracking parameters and URL timestamps are discarded. Optional ranges require an explicit bespoke-checkbox attestation that the user checked the video. Both boundaries must be present; BGM segments must be at least five seconds to avoid rapid reloads. Seconds, m:ss and h:mm:ss are supported. Persisted records are revalidated before being offered to the agent. There is no arbitrary fetch URL in the decision tool.

## Decisions and playback authority

- One request reads the complete previous completed assistant reply using the listener's already connected, authorized model configuration. Existing authenticated completions retain session ownership, protected-world routing, provider access, rate/concurrency limits and billing. Music mode exposes exactly one `music_decision` tool, requires one validated result, makes one provider attempt and has no tool-result/model loop. Oversized replies are rejected whole at the server's 40,000-character music limit rather than truncated.
- Stock VN Settings receives a runtime-only Creator audio / My music agent / Off selector plus pause/resume, skip and lock. Unknown custom layouts are preserved. No creator file, card, rule, prompt, world definition, export or standard chat UI is rewritten.
- The existing audio store remains the uploaded-audio engine and source of volume, master mute, world-audio disablement and exclusive creator/personal/off ownership. Creator SDK commands, playlist/conditional rules and raw sandbox audio cannot compete while personal mode owns playback. World-audio disablement also tears down the YouTube source.
- BGM has a hard selection cap (5/10/15 minutes; default 10; a shorter uploaded-track cap wins). Keep/ordinary replies retain the current selection and deadline. Normal situational changes wait 30 seconds, with a major-scene exception after a five-second replacement floor.
- Uploaded SFX remains one-shot with declared start/end boundaries and a duration watchdog. Its BGM gain multiplier is 0.4 of the user's current volume, with restoration on end, cancellation, failure or blocked autoplay. Legacy creator ducking retains 0.15.
- Manual actions cancel pending model decisions. Skip prevents immediate reuse of the skipped BGM. Account/session scoping, deduplication, cancellation, player-instance ownership and cached-renderer cleanup guards prevent old sessions from taking playback back.

## Single-player YouTube behavior

The player occupies its own layout space beside the story on desktop and below it on mobile, rather than covering VN controls. The viewport is at least 200×200, with a 480×270 layout where space permits. It keeps official controls, branding and ads, supplies origin and `strict-origin-when-cross-origin` referrer information, and uses only documented IFrame methods. No download, audio extraction, hidden player, ad detection or ad-suppression behavior is added.

Script/frame creation requires both opt-ins, My music agent mode, the YouTube source, a saved catalog and an active session. Privacy disclosure names YouTube API Services and links YouTube Terms, Google Privacy Policy and the app's existing privacy policy before the player is enabled. Only video identifiers/player data go to YouTube; dialogue goes to the selected model, never to YouTube search.

A cue bookmarks the selected BGM and its current content position, then loads the cue's verified start/end into the same player. On a valid cue end or failure, BGM is reloaded near that bookmark only while the same background intent remains current. Pause, skip, visibility loss, source/account/session/navigation changes and player-native changes invalidate automatic return. Show player does not automatically restart audio; Play / resume or Play selection is the explicit recovery action.

Native end bounds use official `endSeconds`, with state/identity/started-play guards against stale events. There is no short wall-clock cue timer that skips buffering or advertisements. Seeking that invalidates the range relinquishes automatic return. BGM duration caps remain independent of repeats and cue interruptions. Error, connection-failure and autoplay-blocked states provide manual fallback without breaking dialogue.

Visibility uses intersection, document visibility, viewport size and an occlusion check; hiding/collapsing pauses and destroys the iframe. Native player fullscreen is recognized. At most one official player is retained across cached renderers. Starts/resumption are keyframe-approximate, loops are not promised seamless, and ads/buffering/autoplay rules can interrupt playback. Actual browser/media-provider behavior remains unverified until the live test is authorized.

The official [IFrame API](https://developers.google.com/youtube/iframe_api_reference) supplies bounded loads, player state, position, pause and resume. [Required Minimum Functionality](https://developers.google.com/youtube/terms/required-minimum-functionality) requires the viewport/visibility controls and limits simultaneous automatic YouTube players. The implementation follows the accepted serial-player tradeoff rather than enabling simultaneous YouTube BGM/SFX.

## Search credentials remain a separate future decision

The saved-link player does not require a Data API search key. The [Developer Policies](https://developers.google.com/youtube/terms/developer-policies) restrict credential assignment/sharing and require one project for an API client. A future hosted-search design should decide operator-owned project/credentials versus separately operated personal-client ownership before collecting listeners' Cloud keys; hosted BYOK should not be assumed compliant. No credentials, search endpoint, alternate provider or external catalog has been added.

## Verification and the exact remaining blocker

**64 focused tests pass**, and targeted ESLint checks pass for the Music DJ runtime/settings files. App TypeScript and production Vite builds pass; Existing route-test-file and large-chunk build advisories remain. Focused Node tests cover the prior audio/decision/VN regressions plus strict links/ranges, persisted account isolation, one fixed official script loader, same-track keep, one-player interruption/bookmark return, manual overrides, stale/detached events, source disposal, visibility/autoplay failures, cue failure, native control changes, volume changes and duration caps. Local browser QA at 390×844 and 1440×1000 uses mocked auth, models, audio and official-player events. Every external request is aborted or fulfilled with local mock HTML. It verifies the real catalog form/player panel, bespoke checkboxes, minimum viewport/referrer, one player, cue return, pause cancellation, manual fallback, hide/show, source switching, occlusion and hidden-tab behavior. Uploaded-audio duck/restore and VN controls also pass their mocked browser regression flow.

QA files are in ignored `output/music-dj-youtube-qa/`; player screenshots explicitly label the player as mocked. The story-frame layout fixture is a local preview, not a live session. These checks do not certify actual YouTube media playback, ads, buffering, mobile audio hardware, regional availability or external provider tool support.

**Denied action:** prepare and launch the real-browser public-video test (`python3 .music-dj-qa/youtube-public-check.py`) against official developer sample `M7lc1UVf-VE`, its official IFrame script/player and normal media requests, without login, search or real model calls. **Outcome: denied before execution; not uncertain, not retried.** Automatic approval review said real non-loopback requests conflict with the retained instruction not to activate external access and that trusted history lacks explicit user authorization for this live test. It instructed that the rejection must not be bypassed. The proposed test would expose normal browser/IP/referrer data to YouTube. Explicit trusted user approval for that precise test is required before retrying.

All independent code, mocked verification and build work is complete without that approval. Do not describe real YouTube playback as verified or the requested feature as fully validated while this blocker remains.

## Integration

Base: deployed main `fd66ec2c431e2690bdfd4a3763ce3a5c82c1af66`; Music DJ core commit `2622973`. Canonical dirty checkout and other task branches remain untouched. Parent reported actual inspector overlap with the core in `packages/app/src/features/chat/chat-view.tsx` and `packages/shared/src/index.ts`; preserve both changes when integrating. The YouTube increment adds feature-local files plus scoped settings/source/controller/audio-store/WorldRenderer changes. There is no push, merge or deployment.
