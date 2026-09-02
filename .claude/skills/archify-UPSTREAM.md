# Archify — provenance

Installed 2026-09-02 on owner direction ("i want to install this into aihmc repo first
and then all repos", linking https://github.com/tt-a1i/archify).

| Vendored dir | Skill name | Upstream                           | Pinned at                                          |
| ------------ | ---------- | ---------------------------------- | -------------------------------------------------- |
| `archify/`   | archify    | https://github.com/tt-a1i/archify | `06dd052` (2026-09-02), skill version 2.17.0-dev.1 |

## What Archify is

An agent skill (MIT) that turns a codebase or a plain-language system description into a
self-contained interactive HTML diagram: architecture, workflow, sequence, data-flow and
lifecycle types, dark/light themes, before/after deltas, PNG/SVG/WebM export. The agent
authors a small typed JSON spec, then `node bin/archify.mjs validate|deliver` compiles it
deterministically and refuses to hand over an artifact that fails its own checks.

## How it was installed

Exactly what the upstream installer copies for a project-scoped Claude Code install:

```bash
npx -y skills add tt-a1i/archify --skill archify --agent claude-code --copy --yes
```

That is the `archify/` subdirectory of the upstream repo at the pinned commit — the skill
plus the renderer it needs at runtime. Unlike Soup (a pip CLI, skill-only vendoring) the
renderer IS the skill here: `SKILL.md` drives `bin/archify.mjs`, so the JavaScript ships
with it. Verified at vendoring:

- **No install step.** `bin/archify.mjs guide` and `validate` run on Node ≥ 18 with no
  `node_modules`; the `devDependencies` in its `package.json` (ajv, parse5, saxes,
  simple-icons) are only used by the upstream generator scripts, whose outputs are
  already committed. Do not `npm install` inside the skill directory.
- **No network at runtime.** The one outbound call is the optional update checker
  (`scripts/check-update.mjs`, reads a static manifest under `tt-a1i.github.io`); it only
  notifies, never downloads or executes anything — see "Update awareness" in `SKILL.md`.
- `test/` and `examples/*.html` are upstream's own suite and rendered showcases (about
  5 MB of the 7.5 MB). They are kept so the vendored tree matches the pinned upstream
  byte for byte; keep this repo's test globs scoped to its own source so they stay inert.

## Group rollout

Same shape as Soup: installed in the billing (aihmc) repo first (aihealth-medical-center-billing#554),
then in every other group repo the same day, so the same diagramming skill is loaded wherever the work
happens. Re-pull from upstream rather than editing the copy when it changes; refresh the
pinned commit in this file when you do.

## Carried guardrails

- A diagram of one of the group's systems is a map of its attack surface. Keep generated
  HTML out of public buckets and out of customer-facing surfaces; treat it like the
  security-audit docs.
- The skill's "artifact first, validate every edit, never describe a non-zero exit as
  success" discipline is the same truthfulness rule this group already runs under —
  follow it, don't hand-edit a passed candidate.
- Never fabricate branding: query `node bin/archify.mjs brands "<name>" --json` for a
  real mark or leave the node unbranded.
