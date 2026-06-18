---
description: Release
argument-hint: [mode] [type]
---

Arguments:

- {mode} - release mode. Allowed values: release | release candidate | rc. Default: release candidate.
- {type} - version bump type. Allowed values: major | minor | patch. Default: patch.

# Validation

- If the `mode` is not semantically one of the allowed values, stop and show the user:
  ```
  Invalid mode '{mode}'. Available options:
  - release (or r) - Create a stable release
  - release candidate (or rc) - Create a release candidate/pre-release
  ```
- If the `type` is not semantically one of the allowed values, stop and show the user:
  ```
  Invalid type '{type}'. Available options:
  - major - Breaking changes (x._._ - resets minor and patch to 0)
  - minor - New features (_.x._ - resets patch to 0)
  - patch - Bug fixes (_._.x)
  ```
- Validate that no uncommitted changes are present.

# Prerequisites

Checkout the `main` branch and pull latest changes.

# Step 1: Bump version in `Cargo.toml`

Update the version in `src-tauri/Cargo.toml` file.

First, determine the base version bump according to `type`:
- **major**: Increment major, reset minor and patch to 0 (e.g., 0.1.25 → 1.0.0)
- **minor**: Increment minor, reset patch to 0 (e.g., 0.1.25 → 0.2.0)
- **patch**: Increment patch only (e.g., 0.1.25 → 0.1.26)

Then apply `mode` suffix:

If `mode` is "release" (or similar affirmative value like "r"):
 - Use the bumped version as-is (stable release)
 - Drop the `-rc.X` suffix if present (e.g., 0.1.23-rc.2 → 0.2.0 for minor bump)

If `mode` is "release candidate", "rc" (or similar):
 - If current version is stable (e.g., 0.1.22): apply bump and add -rc.1 (e.g., 0.1.22 → 0.2.0-rc.1 for minor)
 - If current version is already RC (e.g., 0.1.23-rc.1): increment only the rc number (0.1.23-rc.1 → 0.1.23-rc.2), ignore `type` parameter

# Step 2: Run check

Run `npm run be:check` to update the lock file.

# Step 3: Commit and push changes

Stage both version files and commit:
```bash
git add Cargo.lock src-tauri/Cargo.toml && git commit -m "chore: bump version to x.x.x" && git push origin main
```
(replace x.x.x with actual version)

# Step 4: Trigger release

Always trigger the release workflow, but with the appropriate prerelease flag:

If `mode` is "release" (stable release):
```bash
gh workflow run release.yml --ref main -f prerelease=false
```

If `mode` is "release candidate" or "rc" (RC/pre-release):
```bash
gh workflow run release.yml --ref main -f prerelease=true
```

After triggering:
1. Wait 2 seconds for the run to register: `sleep 2`
2. Get the run URL and show it to the user: `gh run list --workflow=release.yml --limit=1 --json url --jq '.[0].url'`
