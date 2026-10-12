# Yumina Story Features Roadmap

Current status: Phase 1 is implemented in source, built locally, and verified with mocked tests and browser QA. Services have not been restarted. Phases 2–4 remain planned; no release dates are set.

## Phase 1 — Routes and Endings (source ready)

- Add first-class route and ending entities, with separate editor tabs for Classic/chat, VN, and custom UI stories.
- Structured mode is on by default. Creators can turn it off for open-ended stories.
- Support one active route at a time. The engine owns route conditions, stats, state, and fixed outcomes.
- Let creators choose authored ending prose or AI-written prose constrained by the ending’s fixed outcome.
- Preserve snapshots, reverts, branches, and checkpoints across route and ending edits.

Verification: [Routes and Endings QA](qa/routes-endings/verification.md).

## Phase 2 — Nexus Points (planned)

- Add hidden, creator-authored milestones that unlock deterministically.
- A milestone can carry a background, scene, or animation payload.
- Keep Nexus Points independently usable; they do not require Scene Shifts.

## Phase 3 — Scene Shifts (planned; separate, opt-in feature)

- Offer automatic 16:9 background generation through Anima at significant setting or story moments.
- Keep this feature off by default and separate from Nexus Points.
- When story context is available, overlap background generation with story generation; cache and reuse generated backgrounds.
- Prefer reusable backgrounds authored by the creator over generating a new one.

## Phase 4 — Creator Gallery and Reuse (planned; optional)

- Give creators a gallery of all generated backgrounds, including sensitive imagery.
- Tell players that all generated backgrounds are shared with the creator, and require explicit opt-in before enabling Scene Shifts.
- Let creators explicitly choose “Use in Nexus point” for a background.
- Never promote generated imagery into routes or canon automatically.

## Dependencies and boundaries

- Routes and Endings are the foundation for later story structure; Nexus Points can be used on their own.
- Scene Shifts are a separate, opt-in capability. The creator gallery is optional and supports explicit reuse, without changing story canon.
