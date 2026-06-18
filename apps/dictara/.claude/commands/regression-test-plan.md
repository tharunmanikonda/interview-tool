---
description: Regression test plan
argument-hint: []
---

Your goal is to create a comprehensive regression test plan covering all changes since the last stable release.

You are an orchestrator - all real work needs to be done in sub-agents.

# Step 1: Get the last stable release git commit

Use the `gh` CLI to get the last stable release tag, excluding release candidates (RC versions).

**Command:**
```bash
gh release list --limit 50 --json tagName,isPrerelease,createdAt --jq '.[] | select(.isPrerelease == false) | .tagName' | head -n 1
```

**Example output:**
```
v0.1.22
```

Then get the commit SHA for this tag:
```bash
git rev-list -n 1 <tag-name>
```

**Example:**
```bash
git rev-list -n 1 v0.1.22
# Output: a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0
```

# Step 2: Get a list of commits from the release commit to HEAD

Get all commits between the last stable release and the current HEAD.

**Command:**
```bash
git log <last-release-tag>..HEAD --oneline --no-merges
```

**Example:**
```bash
git log v0.1.22..HEAD --oneline --no-merges
```

**Example output:**
```
969a3e8 chore: bump version to 0.1.23-rc.1
fb1a24e docs(commands): add RC version support to bump-version command
f7c16cc feat(landing): filter stats to stable versions and add dev script
1640912 fix(recording): enable stop button in hands-free mode
12994ac feat(onboarding): add microphone permission step
```

For detailed commit info:
```bash
git log <last-release-tag>..HEAD --no-merges --format="%H|%s|%b|%an" --name-status
```

# Step 3: Analyze each commit and extract test requirements

For **each commit**, spawn a sub-agent (using the Task tool) to analyze:

**What to extract from each commit:**
1. **Type of change:** feat, fix, chore, refactor, docs, test, perf
2. **Affected components/files:** What areas of the codebase changed?
3. **User-facing impact:** Does this affect user experience? How?
4. **Edge cases:** What could go wrong? What scenarios need testing?
5. **Integration points:** Does this affect other features?

**Sub-agent prompt template:**
```
Analyze commit <commit-sha> and create test scenarios:

Commit: <commit-message>
Files changed: <file-list>

Extract:
1. What functionality changed?
2. What are the user-facing scenarios to test?
3. What edge cases need coverage?
4. What could break in related features?
5. Are there UI, API, or data changes that need verification?

Return a structured test plan for this commit.
```

**Focus areas by change type:**
- `feat:` - New functionality, happy path + edge cases, integration with existing features
- `fix:` - Verify the bug is fixed, ensure no regression in the fixed area
- `refactor:` - Ensure behavior is unchanged, performance hasn't degraded
- `perf:` - Measure performance improvements, ensure no functionality broke
- `chore:` - Check if it affects dependencies, build, deployment, or configs that impact runtime behavior
- `docs:` - Usually skip unless documentation changes indicate behavior changes

# Step 4: Consolidate and create the final regression test plan

**CRITICAL:** One line per test case. Humans will read this - keep it scannable.

**Format:**

```markdown
# Regression Test Plan v{version}

**From:** v0.1.22 → v0.1.23 ({X} commits) | **Date:** 2026-01-12

## Summary of Changes

**Features:**
- Added microphone permission step in onboarding
- Landing page now filters stats to show only stable versions
- Dev script added for local development

**Fixes:**
- Stop button now enabled in hands-free mode during recording

**Other:**
- Version bump command supports RC format

---

## 🔴 Critical
- [ ] One-line test case
- [ ] Another one-line test case

## 🟡 New Features
- [ ] One-line test case

## 🟢 Regression
- [ ] One-line test case

## Platforms
- [ ] macOS • Windows • Linux
```

**Rules:**
- Start with "Summary of Changes" - bullet point list grouped by type (Features, Fixes, Other)
- One line = one test
- Group tests by priority: 🔴 Critical > 🟡 Features > 🟢 Regression
- Skip chore/docs commits unless they affect functionality
- Deduplicate similar tests

**Output:** `.claude/test-plans/regression-v{version}.md`
