# instagram-agent — provenance (repository copy)

Installed 2026-11-03 on the owner's direction: *"github.com/Jakeschincariol/instagram-agent-skill install this skill on the tower VM and all dev logic and repos"*. The same files sit in every group repository that carries the group's vendored skills. The full record (the vetting, what it found, and the group's answers) is in xaen-core: `.claude/skills/instagram-agent-UPSTREAM.md` and `docs/instagram/README.md`.

| | |
| --- | --- |
| Upstream | https://github.com/Jakeschincariol/instagram-agent-skill |
| Pinned at | `d03c56b` (`d03c56bb598be770c60b201f94237e5d1a4268a6`, 2026-09-13), plugin version 1.0.0 |
| Licence | MIT, © 2026 Jake Schincariol. Full text: `instagram-agent-LICENSE`. |
| Group rules | `.claude/skills/instagram/SKILL.md` (Xaen's own file, the same bytes in every repository; it wins over upstream) |

Thirteen skills are vendored **verbatim and byte-identical to upstream at `d03c56b`**: `ig-reel`, `ig-viral`, `ig-caption`, `ig-carousel`, `ig-story`, `ig-profile`, `ig-plan`, `ig-human`, `ig-comment`, `ig-reply`, `ig-dm`, `ig-repurpose`, `ig-audit`. `templates/voice.md` is kept as `instagram/voice-template.md`. Upstream's `README.md`, `.gitignore` and `.claude-plugin/` are not vendored. Don't edit these files here.

## Vetting, in short (3 Nov 2026, read in full before installing)

- None of the thirteen posts, sends, likes, follows or signs in: each ends in text for the owner to paste.
- The six Python scripts (`caption.py`, `hookscore.py`, `beats.py`, `swipe.py`, `humanize.py`, `detect.py`) import only the standard library (and `swipe.py` the sibling `hookscore`). They open no socket, run no subprocess, call no `eval` or `exec`, and write only to an output path the caller gives.
- `ig-reel/hooks.json` is 26 hook *formulas* (data), not Claude Code hooks. Nothing here registers a hook, a setting, an MCP server or a plugin, and nothing runs on install.
- No hidden or bidi-control characters in any file.
- Found and answered by the group rules: invented example figures (rule 2), the humanizer stripping Arabic's right-to-left mark (rule 7), research in a browser and `yt-dlp` (rule 6), and files under `~/.claude/instagram/` (rule 10).

## Updating

Update in xaen-core first (its vetting steps and tests), then copy the same files here: the thirteen `ig-*` folders, `instagram-agent-LICENSE`, `instagram/voice-template.md`, `instagram/SKILL.md` and this file. Then run `sha256sum -c` on the block below from `.claude/skills/`.

## Checksums

Run from `.claude/skills/`: `sha256sum -c` on this block.

```sha256sum
ece765baf4a08ef74047c5d3d9ca522824db29cf46cde9329acc690dd0a60bb0  ig-audit/SKILL.md
44bd93bfbceabebd0eac6742aecd948be4c3aa97c57f830845e1b9b6450b55b6  ig-caption/SKILL.md
7952b512abaac7521d6f5838ef7a2c6b04c06146372fd658466814a7e9893917  ig-caption/caption.py
de943e5720ea6e08c4aa0e56ed3f87994d83fae238105e3fe31acc68d8ff44f7  ig-carousel/SKILL.md
c872ba255cd70f6827eb22b45d7caec32814dda283f8346f6bfb4a021947202e  ig-comment/SKILL.md
6ce9eaf37997e90e79fc190edcd7b5d3e4d0d0735238a9ae7fd8b08a2ace485b  ig-dm/SKILL.md
bd66947ff98edc0ad73bb30f614b3a0060d89b864656bf1401bd472694483b93  ig-human/SKILL.md
d8cf740741968f25ce49ec6cc65538f53e97f28f6f2ce21b7f21864475fe2075  ig-human/detect.py
d1c579613d9201f0f77e09978d870e3454092b94b4cfecfbb4465c4f0f198283  ig-human/humanize.py
987dedae2008742c04ba8e2728f9149f67dc6a665beba891731d6e048abdab2d  ig-human/slop.json
4e42e13b8a044c23083db7e88d28f0465986602725246a8eacda433d53079918  ig-plan/SKILL.md
a2bda7e39066b71f89a6185a640f4cb5fec1c027e9ff3afe40787a965a3e1e15  ig-profile/SKILL.md
962085d9157b553386f1f62d90fa54ff1d4acae53a2e08b8372464beda49047a  ig-profile/rubric.json
fc0374ccc88485d999fa0e2dcd4c7c3932d6949e58008cb6e6f1c484015c5631  ig-reel/SKILL.md
2f8a4ecb9e28be0a09a35c418d45665cf1d5aa16e7f852ed051e62f1c6983414  ig-reel/beats.py
147230762fd9e17cf58302913cb97069b3a3c7edae211b3b0196c180adf1412f  ig-reel/hooks.json
8e1d10edda81dcdf0f18cd24ae37716a7ca30873af777e0f65383089addfe69e  ig-reel/hookscore.py
926f324f71939e368da3011aaa2ca6aef4b9f1219d29315f732c3dc1c992972f  ig-reply/SKILL.md
545f240a5f13657db9f9245f286d4a01e145718ef49d38ff2a2f0cc84322eb19  ig-repurpose/SKILL.md
91ab3d60fa7ca87034767d147c31fa3f3db9dca11d6d83296aaede934a885637  ig-story/SKILL.md
22c2e46a442b4f992d9876aaa72f8f56502dd54a08291f5572afb42ccb16f616  ig-viral/SKILL.md
8c7075910414fe5bb46a28b8433fbe1f7cdceece4ca9cb098f5ad809bdbbe84b  ig-viral/swipe.py
857c8d5276809c8196b3cd7cb3300324768bfc562b2b6281b06d6865058e186c  instagram-agent-LICENSE
8089a6c57b4a149c82bf8ee8bb85c9d7bbe6638ab4fee906fe491e1e403147c6  instagram/voice-template.md
```
