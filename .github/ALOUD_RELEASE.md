# Aloud iOS Fork: verification and release

The `Aloud - Verify and publish` GitHub Actions workflow is the release gate for this fork. Do not use the inherited `Version bump and trigger release` workflow or `version-bump.sh` for the iOS fork: those still reflect the upstream version scheme and remotes.

## Proposed changes

1. Branch from the latest released Aloud iOS commit or from the current `main` once this workflow is merged.
2. Make source changes, update `manifest.json` to the next unique `0.15.1-ios.N` version, and commit. (The workspace package versions need not be changed for an iOS fork pre-release.)
3. Push your branch to `aako/obsidian-aloud-tts` and open a PR targeting `main`.
4. GitHub Actions runs typecheck, lint, formatting,  tests and the complete build. Check the PR's **Validate source and build** status.
5. Review and merge the PR. Do not publish a release before the merge and a successful Actions run on `main`.

## Publish a tested version, explicitly

1. Navigate to **GitHub → aako/obsidian-aloud-tts → Actions → Aloud - Verify and publish**.
2. Select **Run workflow**, choose branch **main**, and enter the exact version from `manifest.json` (e.g. `0.15.1-ios.8`). This action is the explicit release approval.
3. The workflow validates the code again and, only on `main` with the matching version, builds the plugin and publishes a GitHub prerelease with the BRAT assets `main.js`, `manifest.json`, and `styles.css`.
4. Confirm the prerelease under GitHub Releases and update the fork through BRAT in Obsidian. Test on Mac and iPhone.

Publishing never runs automatically on a push, tag, or pull request. A GitHub Action token with job-scoped `contents: write` replaces the old missing `GH_RELEASE_TOKEN` secret. If GitHub's repository/organization policy blocks writes, review the **Actions → General → Workflow permissions** setting; do not create a personal token just for this.

The first migration PR deliberately contains the existing work from `main` through `0.15.1-ios.7` plus the v8 changes. Future pull requests should start from merged `main`, so they will contain only new changes.

## Test an Unmerged PR Without Publishing

On a pull request targeting `main`, the **Validate source and build** job runs typecheck, lint, formatting, tests and build. **Only after all checks pass**, it attaches an artifact named `aloud-pr-<number>-<run>-<attempt>`. The downloaded ZIP contains exactly `main.js`, `manifest.json`, and `styles.css` at its root. It expires after 14 days.

1. Open the PR's successful **Aloud - Verify and publish** workflow run. Download the artifact from **Artifacts**, or follow the link in the job summary. GitHub sign-in may be needed.
2. Extract all three files into a **separate test vault** at `.obsidian/plugins/aloud-ios-fork/`. Restart Obsidian, enable Community Plugins, then enable **Aloud (iOS Fork)** in that vault.
3. Run the targeted acceptance checks and report what was not tested. For iPhone testing, sync the **test vault**, not your production vault. Review any untrusted PR code before installing its build.
4. Roll back by removing the test plugin files or discarding the test vault. This does **not** change `main`, publish a release, or update BRAT.

Documentation/workflow-only PRs require no version bump. For a new user-facing release, assign a unique `manifest.json` version on a code PR, merge after verification, and explicitly run the manual publishing workflow on `main`. The inherited version-bump workflow remains off limits.
