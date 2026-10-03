# Watch Skill: provenance (group repository copy)

Owner, 3 Oct 2026: install the Watch Skill watcher on all agents.

- **Upstream:** `https://github.com/oxbshw/watch-skill`, release `core-v1.4.3`,
  commit `f1317c8fe64744a606c31867b05fbbe3144268c6`, MIT ("Copyright (c) 2026
  oxbshw"). PyPI `watch-skill==1.4.3`, whose wheel and sdist carry PEP 740
  attestations to that commit. No upstream file is copied into this
  repository; the installed package carries its own licence.
- **Files here, the same bytes in every group repository:**
  - `.claude/hooks/watch.sh`: installer, launcher and hooks;
  - `.claude/hooks/watch-requirements.txt`: the hash-locked install set, whose
    SHA-256 the script checks before installing anything;
  - `.claude/skills/watch-skill/SKILL.md`: how agents use it, and the rules.
- **What the wrapper does:** installs with `--require-hashes --no-deps` and
  wheels only; serves 17 of the 39 tools (none that runs commands, records a
  screen, drives a browser, shares HTML or installs anything); fixes the
  settings so no frame, audio or text reaches a cloud model; ignores every
  stray setting and `.env`; refuses Watch Skill's own downloads.
- **The rule no setting can enforce:** what a tool returns goes to the calling
  agent's own model provider. Never point it at patient recordings, clinical
  images or a clinic folder.
- **The vetting record, the findings behind each setting and the upgrade
  steps** live in xaen-core: `.claude/skills/watch-skill-UPSTREAM.md` and the
  "Watch Skill" section of its `CLAUDE.md`. Upgrade there first, then ship
  the same bytes here in one PR.
