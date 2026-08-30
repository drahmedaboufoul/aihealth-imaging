# Soup — provenance

Installed 2026-08-30 on owner direction ("install this in xaen core and all repos and
for your logic also", linking https://github.com/MakazhanAlpamys/Soup).

| Vendored dir | Skill name | Upstream | Pinned at |
|---|---|---|---|
| `soup/` | soup | https://github.com/MakazhanAlpamys/Soup | `6236763` (2026-08-30), PyPI `soup-cli` 0.73.3 |

## What Soup is

A Python CLI that drives LLM fine-tuning and post-training from a single `soup.yaml`:
SFT plus preference training (DPO/ORPO/SimPO/KTO), QLoRA, evaluation, export
(GGUF/ONNX/AWQ/GPTQ) and a local OpenAI-compatible server. Apache-2.0, Python 3.10–3.12,
`Development Status :: 3 - Alpha`, 175 releases.

## What was installed, and why it is skill-only

**The skill is vendored; Soup's source is not.** Three reasons, all following existing
group precedent:

1. Soup is a **pip package**, not a skill library. `pip install soup-cli` is the install
   path; copying 23 MB of upstream source into 30 repos would be a stale fork within a
   week at its release cadence. This is the same call made for Shannon
   (`docs/security/shannon-runner.md`) — reference the tool, vendor only the knowledge
   needed to drive it.
2. The xaen-core rule "don't vendor the full libraries — it floods the skill loader"
   applies: one skill directory, not the upstream tree.
3. Licence is clean (Apache-2.0, unlike the AGPL `apps/mirofish` quarantine), so this is
   a deliberate engineering choice rather than a licence constraint.

**Not registered in `console/src/data/skillsCatalogCuration.js`.** That file's `VENDORED`
map is asserted by `console/test/agent-skills-catalog.test.js` to contain only ids
present in the generated `agent-skills-catalog.json`, which is built from three specific
upstreams (VoltAgent, gooseworks-ai, mukul975). Soup is in none of them, so adding it
there would fail the test. The catalog is an index of those three libraries; this skill
is a direct install and lives only in `.claude/skills/`.

## Scope of the rollout

The skill is installed in **all 30 group repos** so the same guidance is loaded wherever
the work happens. The `soup-cli` **dependency** was added only where a Python project
actually exists — 26 of the 30 repos are Node/TypeScript with no Python at all, and
creating a `requirements.txt` inside a Next.js storefront to hold an ML training CLI
would be noise, not an install. Repos that gained the real dependency are listed in
`docs/soup/README.md` in xaen-core.

## Carried guardrails

- Soup writes a local audit line per invocation to `~/.soup/audit.jsonl` by default
  (`--no-audit-log` / `SOUP_NO_AUDIT_LOG=1` opts out).
- Training data drawn from the medical repos is real patient data: de-identify before it
  becomes a JSONL, never `soup push` it to a public hub, and run the `memorization` check
  in `soup diagnose`.
- The upstream "8B on a 4 GB GPU" figure is BETA, opt-in (`stream_layers: true`), and was
  measured on v0.72.2 before a v0.73.0 correctness repair. Quote it as upstream's
  measurement, not as one this group reproduced.
