# Aloud iOS Fork — Project State

**Reviewed:** 2026-10-23. **Repo:** [aako/obsidian-aloud-tts](https://github.com/aako/obsidian-aloud-tts). **Obsidian ID:** `aloud-ios-fork`.

This is the durable project handover, not a substitute for reading the current code or physical-device verification. Start with [AGENTS.md](../AGENTS.md) and [release instructions](../.github/ALOUD_RELEASE.md). Check `main`, `manifest.json`, PRs, and GitHub Actions before relying on this dated baseline.

## Verified Baseline

- Fork `main` at review: `b618cbb465fa17a016ac21a862e274730e3759a8`, containing merged PR #1.
- Most recently published version at review: [`0.15.1-ios.8`](https://github.com/aako/obsidian-aloud-tts/releases/tag/0.15.1-ios.8), with successful release and CI workflows.
- Last locally reported automated suite: 440 passing tests, plus typecheck/lint/format/build verification. These are **not** evidence of real iOS/iCloud reliability.
- The fork uses a distinct Obsidian plugin ID; publishing is guarded and deliberately manual.

## Existing Capabilities (Code Present)

- Sentence-aware playback, text highlighting, speed controls, navigation, and conservative saved reading checkpoints.
- Provider integrations including Azure and Google Chirp 3 HD, with voice options and local conservative usage ledgers.
- Permanent vault audio caching used by listening and article pre-caching; article cache jobs support estimating, pause/resume, explicit deletion, and cached-MP3 ZIP export.
- `ios.8` added ordinary-playback-to-shared-cache writes and configuration change handling. Live voice-switch races and cross-device behavior still require investigation.
- Alternating metadata snapshots improve interrupted-write recovery but do not create cross-device transactions.

## Speechify Provider Candidate

- Speechify Simba streaming provider is proposed in a feature PR, not yet shipped.
- Uses the native `/v1/audio/stream` MP3 endpoint; defaults to Simba 3.2 and `geffen_32`.
- The local cap starts at zero and reserves characters before each request; this is **not** Speechify account billing or free-tier entitlement. Free starter credits are not monthly.
- Test with a short sentence on a separate vault before approving full-article synthesis. Physical audio playback, catalog availability, and real-account credit behavior remain unverified.

## Prioritized Risk Register — Investigation Needed

1. **Incomplete cache identity:** Audit every provider. ElevenLabs stability/similarity parameters and OpenAI-compatible response format are examples of audio-affecting options absent from the current common hash.
2. **Asynchronous voice/provider switching:** Test in-flight requests, mutable settings, obsolete completions, and duplicate paid generation.
3. **Cache scalability and resilience:** Investigate repeated full-folder size scans, per-read hashing, and all-or-nothing startup when one article-job entry is corrupt. Protect existing audio.
4. **Cross-device consistency:** iCloud placeholders, simultaneous writes, and per-device usage ledgers need explicit rules and failure tests. iCloud file sync is not a transactional database.
5. **Paid-regeneration prevention:** Unavailable or corrupt known cached audio must not silently cause new billable synthesis.

These are review findings and test targets, not assertions that each failure has been observed in production.

## Work Sequence

1. **Workflow foundation PR:** This document, fork-specific instructions, and a verified PR-only plugin ZIP. No synthesis code or manifest-version changes.
2. **Candidate `ios.9` stabilization:** Small reviewable PRs fixing known correctness risks; regression tests; physical-device acceptance. Avoid simultaneous architectural replacement.
3. **Possible later `ios.10` refactor:** Evaluate one synthesis/cache service, immutable request configurations, and migration-safe indexing. Proposal only; do not start a rewrite without a bounded design and tests.

## PR Acceptance and Rollback Contract

Every behavior change records what changed, what actually passed, what was not verified, compatibility with existing cache and reading-progress data, possible provider costs, manual tests, and a safe rollback. CI must never need real paid TTS keys.

For applicable iPhone tests: switching voice while buffered; pausing and resuming after app suspension; AirPods and Lock Screen commands; offline playback of fully downloaded cached audio; interrupted iCloud downloads; restarting with saved progress. Mark each result observed or untested rather than assuming a pass.

## PR Test Builds

The [Aloud CI workflow](../.github/workflows/release.yml) creates a **test-only GitHub Actions artifact** on PRs targeting `main`, **after** typechecking, lint, formatting, unit tests, and build pass. Download the artifact from the successful PR workflow run; it unzips to exactly `main.js`, `manifest.json`, and `styles.css` at its root. Copy those files to a **separate test vault** under `.obsidian/plugins/aloud-ios-fork/`. Restart Obsidian and enable the plugin in that vault. For iOS, use a synced *test* vault rather than the production vault.

PR artifacts expire after 14 days, are not signed user-facing releases, and cannot be installed through BRAT. Do not use unknown third-party PR binaries without code review. The separately guarded **manual** release process is unchanged.
