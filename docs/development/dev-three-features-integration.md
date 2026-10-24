# Three-feature development integration

Branch: `codex/dev-three-features-20261025`.
Base: `fd66ec2c431e2690bdfd4a3763ce3a5c82c1af66`.

This isolated development branch combines saved-version comparison, actual-request inspection and the listener-owned Music DJ with saved YouTube links. It does not change main, publish the branch, deploy, or mutate live application data. The canonical dirty checkout and individual feature branches are preserved.

## Exact source provenance

| Feature | Verified source commit | Integration cherry-pick |
| --- | --- | --- |
| Saved version/current unsaved draft comparison | `443b70a5b317d58ba137fdec81e350a1fea57135` | `d035580224223895ace5425cb0cd5c201408844f` |
| Inactive request-capture infrastructure | `49068b15e593a188c10be2e3383baf20cac3e92d` | `e4caaa781ff5f235ace0cc021da13437b6271838` |
| Owner-scoped actual-request inspection | `059fafe3b671a1c8741c7b820ba5bc2432d69d92` | `50e162d87b58fd2f82690268d3d2e0333cd956b6` |
| Personal Music DJ core | `26229734cf84486383c7a065b825880690a46687` | `5ff2dbd834c6b3a5e4d1dacdae4767d510d1e098` |
| Personal saved-link YouTube playback | `593b7e673c4e9c31f4207923a26ce2a84b87084b` | `a0edfd0fee71c6e794cc12f67514e0554b951e48` |

The shared-index conflict retained both request-inspection types and Music DJ exports. `chat-view.tsx` merged automatically; review confirms both generation details and the current-session audio cleanup guard remain. No integration-only runtime fixes were required.

## Preserved boundaries

- Version comparison reads one selected owner-authorized snapshot and the current unsaved editor draft. It compares complete schema content and cover/rating without invoking save, restore or publish. Existing review-diff defaults and custom content remain intact.
- Request capture/read requires current recognized card ownership (`worlds.creatorId`) AND ownership of that private session (`playSessions.userId`). There is no original-author or administrator exception. Receipts remain redacted, bounded, process-local and private; they do not enter ordinary message/session/archive/sandbox payloads.
- Personal saved links and audio mode stay listener/account scoped. One visible official YouTube player serializes BGM and verified cues with bookmark return. Uploaded audio retains simultaneous cue playback with a 0.4 BGM gain multiplier (60% ducking). Search credentials remain unimplemented.

## Combined verification

All resource-heavy operations ran sequentially in the integration build slot. Shared and engine production builds, app `tsc -b` plus full Vite production build, server TypeScript and production `tsup` build, and engine/shared typechecks passed. The Vite build retains existing route-test-file, mixed dynamic-import and large-chunk advisories. The comparison worker is 5.75 kB; the lazy request-inspection panel is 6.11 kB.

- 100 focused app/editor/chat/music/audio/store tests passed across 18 files.
- 56 isolated server tests passed across seven files, covering provider receipts, redaction/retention, current-owner/private-session permission checks, send/regenerate/continue binding, Music DJ decisions and version read/restore boundaries. Databases were in-memory PGlite; provider responses were mocked.
- 16 engine diff tests passed. Focused lint passed on comparison and Music DJ runtime/settings files. Diff whitespace checks passed.
- Synthetic integrated Chromium smoke passed at 1365×1000 and 390×844 with no horizontal overflow or application page errors. It covered unsaved draft comparison, safe prompt display and player denial, uploaded BGM identity and 60% duck/volume restoration, one mocked official player, serial cue/bookmark return, hide/show, and navigation disposal.
- Opening the actual-request dialog over the mocked player paused the occluded media. Closing it required explicit resume and made no additional music decision. All model responses/audio were mocked; iframe requests were fulfilled with labeled local mock HTML. The combined smoke made zero real external requests and zero real model calls.

Ignored evidence is in `packages/app/output/integration-qa/` (fixture/config) and the task's sibling `integration-evidence/` directory (logs, browser driver/results and screenshots). The loopback QA server was stopped after verification. Full app/server test suites were not run; focused affected suites were used.

## Baseline failures, separate from integration

The full engine run finished with 1,474 passing tests and the same three failures in untouched `vn-dialogue-upgrade.test.ts`:

- upgrades saved choice labels without replacing authored interface code
- moves the old shipped Persona button into a greeting-only row without touching status configuration
- centers the shipped Export button when Persona is hidden without replacing custom menu code

All three were previously reproduced from an untouched archive of `fd66ec2`; no additional engine failures appeared in the combined branch. Broader individual-task notes document other baseline fixtures; this report does not claim those suites were rerun during integration.

## Approved public YouTube result and remaining limits

The music task subsequently supplied the explicitly approved login-free public demo check on source commit `593b7e6`: all 11 checks passed, with actual official script/player/media and mocked auth/session/model responses. No source changes were necessary, so the integrated playback source is identical. Native 5–8s cues ended at 8.005315s and 8.003498s and returned to bookmarked BGM positions. Manual pause canceled automatic return; explicit resume and hiding/removing the player worked. Integration did not duplicate that external test.

See [the updated Music DJ report](personal-music-dj.md#verification-and-remaining-limits) and ignored `output/music-dj-youtube-qa/public-playback-summary.md`. Physical mobile browsers/audio hardware, audible output, regional availability, seamless loops and ad delivery remain unverified. Ordinary ad requests were allowed in the public check; recorded browser CORS/telemetry errors mean ad delivery cannot be certified. No paid model calls, search credentials or live application data were used.
