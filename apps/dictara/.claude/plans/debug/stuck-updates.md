# GitHub Download Counter Test

Testing when GitHub increments the download counter for release assets.

## Test Release
- **Release**: [v0.1.26-rc.1](https://github.com/vitalii-zinchenko/dictara/releases/tag/v0.1.26-rc.1)
- **Asset**: `Dictara_aarch64.app.tar.gz`
- **Size**: 17,401,951 bytes (~17 MB)
- **URL**: https://github.com/vitalii-zinchenko/dictara/releases/download/v0.1.26-rc.1/Dictara_aarch64.app.tar.gz

## How to Get Download Count

Using GitHub CLI:
```bash
gh api repos/vitalii-zinchenko/dictara/releases/tags/v0.1.26-rc.1 \
  --jq '.assets[] | select(.name == "Dictara_aarch64.app.tar.gz") | {name: .name, download_count: .download_count}'
```

Or using curl:
```bash
curl -s https://api.github.com/repos/vitalii-zinchenko/dictara/releases/tags/v0.1.26-rc.1 \
  | jq '.assets[] | select(.name == "Dictara_aarch64.app.tar.gz") | {name: .name, download_count: .download_count}'
```

---

## Test 1: Baseline Measurement

**Date**: 2026-01-24
**Time**: 20:28 (before test)

**Download Count**: 1

---

## Test 2: After Running Download Script

**Test Plan**:
1. 5 full downloads (complete) - Downloaded full 17MB files
2. 5 partial downloads (first 1MB only) - Used HTTP range requests (bytes 0-1048575)

**Test Execution**:
- Started: 20:29
- Phase 1 (Full): Completed 5 full downloads (5 × 17MB = 85MB)
- Phase 2 (Partial): Completed 5 partial downloads using `curl -r 0-1048575` (5 × 1MB = 5MB)
- Finished: 20:30

**Expected Results**:
- If GitHub counts on request start: counter should increase by 10 (1 → 11)
- If GitHub counts on completion: counter should increase by 5 (1 → 6)

**Note**: HTTP range requests send `Range: bytes=0-1048575` header, so GitHub may handle these differently than aborted downloads.

**Actual Results**:

**First Check** (20:31 - ~1 minute after test):
```json
{
  "name": "Dictara_aarch64.app.tar.gz",
  "download_count": 2,
  "updated_at": "2026-01-23T04:30:10Z"
}
```

**Download Count**: 2 (increased by only **1**, not 5 or 10!)

**Analysis**:
This is unexpected! Possible explanations:

1. **GitHub deduplicates requests from same IP/session** - Multiple downloads from the same source in a short time might only count as 1
2. **Stats haven't fully updated yet** - GitHub might batch update statistics
3. **HTTP Range requests don't count** - The 5 partial downloads with `Range: bytes=0-1048575` header might not be counted
4. **CDN caching** - Subsequent requests might have been served from cache without hitting the counter

**Next**: Need to wait longer and check again, or test from different IP addresses

---

## Notes
- GitHub API stats may have a delay (few minutes to update)
- Will check counter multiple times over 5-10 minutes
