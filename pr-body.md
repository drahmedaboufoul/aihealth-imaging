## P0.6 scrub — public-repo hygiene

### What was in the public repo
- **`.agents/`** — 73 files, ~1 MB of Mavis internal design-taste skills (emilkowalski, Leonxlnx, pbakaus/impeccable, etc.)
- **`skills-lock.json`** — 3.5 KB lockfile referencing the above skills
- **`handoff/fussen-report/`** — 36 KB DentalX AI competitive analysis (feature-capture report, walkthrough of a competitor's product, written for internal use)

**Total: ~1 MB of Mavis-internal scaffolding + competitive research that should never have been in a public repo.**

These are NOT PHI. This is a hygiene issue (third-party skill licensing + competitor intel leaking into a public OSS-style repo).

### What this PR does

1. **Removes from tracking** (76 files, 23,497 deletions, 9 insertions)
2. **Adds them to `.gitignore`** so they cannot be re-committed accidentally
3. **Scrubs them from git history** with `git filter-repo` (rewrites every prior commit so the paths never existed)

### Verification

- `git log chore/scrub-internal-dirs -- <each-path>` → **0 matches** (paths do not exist in any commit on this branch)
- `git rev-list --all --objects` on this branch → **0 references** to any of the 3 paths
- Verified fresh clone of the pushed branch: working tree clean, history clean
- Verified no app code references any of the 3 paths (grep over the entire repo, excluding the offending dirs themselves)
- `.agents/`, `skills-lock.json`, `handoff/fussen-report/` were the only paths touched. `handoff/EXOCAD_ALIGNMENT.md` and `handoff/INFRASTRUCTURE.md` were **not** in the audit and are kept untouched.

Backup of the pre-scrub `.git` directory is at `C:\Users\Hi\.mavis\workspace\portfolio-scan\.git-backup-pre-filter-repo` in case rollback is ever needed.

---

## ⚠️ CRITICAL: This is a history rewrite. Force-push is required to actually clean the public repo.

This branch is the **scrubbed, rewritten** history. `origin/main` is **still the unscrubbed history** and still contains every one of the offending files in its past commits. **As long as `origin/main` points at the old SHA (`395a3e3`), the public repo still leaks this content** — anyone with `git clone` access can check out the offending files from any past commit, and GitHub's web UI can still surface them.

**This PR cannot be merged normally** (a merge commit would preserve both histories). To complete the scrub, you must replace `origin/main` with the content of this branch. Two safe options:

### Option A — local force-push (recommended)
```bash
cd path/to/aihealth-imaging
git fetch origin
git checkout chore/scrub-internal-dirs
git push --force-with-lease origin chore/scrub-internal-dirs:main
```
`--force-with-lease` (not `--force`) checks that `origin/main` hasn't moved since you fetched; safer if anyone else has pushed in the meantime.

### Option B — GitHub UI "Update branch"
1. Settings → Branches → Branch protection rules on `main` → enable "Allow force pushes" (or "Allow force pushes to specific people" → yourself)
2. In this PR, click "Update branch" or use the "..." menu → "Update branch" with force-push

### After force-push
- `origin/main` will point at the rewritten history
- `origin/main`'s SHA will change from `395a3e3` → `1d64963`
- Anyone with a local clone will need to `git fetch` + `git reset --hard origin/main` (or re-clone)

---

## Why history matters for a PUBLIC repo

- The files in `.git/objects/` survive every `git push` even after a regular `git rm`
- GitHub's web UI renders every commit, every blob, every past file — including files deleted in the most recent commit
- Competitors / security researchers regularly mine public-repo history for leaked credentials, internal docs, and competitive intel
- The fussen-report specifically describes DentalX AI's product surface in a way that an internal doc should describe a competitor, not a publicly-indexed artifact

## Reverting

The pre-scrub `.git` is backed up. To roll back the history rewrite:
```bash
cd path/to/aihealth-imaging
rm -rf .git
cp -r /path/to/.git-backup-pre-filter-repo .git
```
After that, the rewritten branch can be force-deleted and the repo is back to its pre-scrub state.

---

## Origin (P0 audit)

From the AWS migration plan audit, P0.6: ~1 MB of Mavis internal skills + 36 KB of competitive research sitting in the public repo. Hygiene issue, not PHI, but should be scrubbed.

## What is NOT in this PR

- `handoff/EXOCAD_ALIGNMENT.md` — keep, not in audit
- `handoff/INFRASTRUCTURE.md` — keep, not in audit
- Any code in `src/`, `api/`, `supabase/`, `tests/` — untouched
- P0.1 (UAE PHI defang) — already merged to main, untouched
