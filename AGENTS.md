General guidance:
- Tooling and package manager: use pnpm. Enable with `corepack enable`; install with `pnpm install`.
- Linting and formatting: run `pnpm run lint` (eslint). Format with `pnpm run format` (prettier). CI and pre-commit use lint-staged to check `src/**/*.{ts,tsx}` with prettier --check and eslint.
- Type checking and builds: `pnpm run typecheck` must pass; `pnpm run build` runs typecheck then bundles via esbuild config.
- Tests: run `pnpm run test` (vitest run). Tests use jsdom and extend `expect` with `@testing-library/jest-dom` via `test-setup.ts`. Prefer mocking only fetch/IO boundaries; keep tests small and typed. We want high coverage, fast tests, but balance with minimal tests and minimal mocking to make the tests easy to maintain.
- Code style: always type function arguments and return values; avoid `any`. Prefer descriptive names and early returns. Keep comments minimal and purposeful.
- UI/tests: use Testing Library patterns; avoid relying on implementation details. Clean DOM state is handled in `test-setup.ts`.

Detailed documentation index:
- [overall-structure.md](architecture-docs/overall-structure.md) explains the high level design of the audio system, and its integration with Obsidian.
- [audio-player.md](architecture-docs/audio-player.md) explains in detail the state machine and flow of the audio player.
- [adding-a-provider.md](architecture-docs/adding-a-provider.md) explains how to add a new TTS provider to the audio system.

## Styling Guidance

Use "Title Case" for headings. Within the settings section, use full sentence descriptions with periods.

## Aloud iOS Fork: Sources of Truth

- Fork: `aako/obsidian-aloud-tts`. Obsidian plugin ID: `aloud-ios-fork`; keep it distinct from the upstream plugin.
- Maintain [docs/PROJECT_STATE.md](docs/PROJECT_STATE.md) as the concise handover, issue register, and manual-test status. Clearly distinguish verified behavior from hypotheses and device tests not yet performed.
- Follow [.github/ALOUD_RELEASE.md](.github/ALOUD_RELEASE.md) for releases. Never run the inherited `version-bump.sh` or `Version bump and trigger release` workflow for this fork.
- Branch from the current fork `main` and prefer one independently reversible concern per PR. Documentation/workflow PRs do not need a manifest version bump; before a new published build, assign a unique `0.15.1-ios.N` version.

## Reliability Invariants

1. **No surprise bills:** Offline cache reads, integrity checks, failed iCloud downloads, and migrations must not silently trigger paid TTS. Durable usage reservation must precede requests. CI and unit tests must not send billable provider traffic.
2. **Complete synthesis identity:** Cache keys and obsolete-request checks must represent all sound-affecting inputs: provider, model, voice, text, generation controls, and relevant format/pause choices. Never return audio for another synthesis configuration.
3. **Preserve user data:** Existing permanent audio, checkpoint files, and cache metadata are user data. Migrations must preserve compatibility and include a rollback plan; do not auto-delete, overwrite, or bulk-regenerate audio. Deleting shared chunks requires an explicit warning and user action.
4. **State availability accurately:** Distinguish playable verified audio, known-but-unavailable iCloud files, and genuinely absent audio. Missing local bytes do not imply permission to incur provider costs.
5. **Own asynchronous work:** Each request captures immutable provider/voice/options; stale work may not contaminate active playback or silently change synthesis configurations.
6. **Test on devices:** Green CI does not establish iPhone suspend/resume, AirPods controls, iCloud synchronization, or offline reliability. Do not claim these are verified without real device tests.
7. **Protect credentials:** Never commit real API keys, personal vault files, cached audio, or reading data. Test artifacts contain only the bundled plugin files.

## Development and Review

- Suggested verification: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`. State exactly which checks ran, their outcomes, and what was not tested.
- Each behavior-changing PR should describe the changed invariants, regression/fault tests, existing cache/progress compatibility, possible paid API calls, manual acceptance steps, and rollback.
- PR CI creates a short-lived ZIP with `main.js`, `manifest.json`, `styles.css` **only after all validation passes**. Review changes before installing third-party artifacts; install test builds only into a **separate Obsidian test vault**, never the production vault.
- Merge only after review and green CI; publish only via the manual release gate on `main`. The PR artifact is **not** a GitHub release or BRAT update.
