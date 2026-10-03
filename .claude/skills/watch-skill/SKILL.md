---
name: watch-skill
description: >-
  Watch a video, screen recording or meeting recording and answer questions
  about it with timestamps, through the "watch" MCP server (Watch Skill 1.4.3,
  locked down for the Xaen group). Use when someone shares a video file or a
  public video link, asks "what happens at 2:30", wants chapters, a bug report
  from a recording, or a check of a video's opening hook. Not for patient
  recordings, clinical images or anything filmed in the clinic.
---

# Watch Skill: eyes for the agent, kept local

The `watch` MCP server turns a video into frames, captions and timestamps that
you can read and cite. It is Watch Skill (MIT, `oxbshw/watch-skill` 1.4.3)
behind the Xaen wrapper `.claude/hooks/watch.sh`, which installs a
hash-checked copy and serves only the tools below.

## The tools you have

| Tool | Use it to |
|---|---|
| `watch_video` | Index a local video file or a public video link. Returns a report and key frames. |
| `watch_batch` | Index a playlist, a folder or a list of videos. |
| `get_status`, `cancel_job` | Follow or stop a background index. |
| `list_videos`, `search_videos` | See what is indexed and find a moment across videos. |
| `ask_video` | Ask about one indexed video. It answers only from what it found, with timestamps. |
| `get_moment` | Get the frames around a timestamp. Read them yourself. |
| `extract_chapters`, `extract_bug_report`, `analyze_hook` | Chapters, a located error, or a score for the opening seconds. |
| `library_synthesize`, `library_overview` | Answer across many indexed videos. |
| `check_source`, `stats`, `execution_plan`, `report_mistake` | Freshness, savings, what a run would send, and a correction. |

Use the video id that `watch_video` or `list_videos` gives you, never the file
name.

## How to work

1. **List first.** Call `list_videos` before indexing; a video already indexed
   answers at once.
2. **Cite the moment.** Every claim about a video carries its timestamp
   (`01:32`). If you did not see it in a frame or caption, do not say it.
3. **Trust a refusal.** When `ask_video` says the video does not show the
   answer, that is the answer. Use `get_moment` on the nearest timestamps and
   read the frames yourself before saying anything more.
4. **Read the frames.** No model reads on-screen text for you here (OCR and
   cloud vision are off), so look at the frames `get_moment` returns.

## What is switched off, on purpose

- **No cloud model sees anything.** Cloud vision, cloud speech to text and
  scene descriptions are off; the only model it may call is a local Ollama on
  the same machine. Fetching a public video by its link is the one network
  use.
- **No commands, no screen recording, no browser.** `verify_contract`,
  `loop_*`, `capture`, live sessions, the HTML viewer and `doctor` are not
  served. Do not try to install or run the `watch-skill` command-line tool
  yourself, and never run upstream's setup command or `npx skills add`.
- **Captions only from the source.** Local speech to text is not installed, so
  a local file with no captions has no transcript. Say so; do not invent one.

## Rules

- **Never point it at patient recordings, clinical photos or videos, or a
  clinic folder.** What the tools return (frames and text) goes to your own
  model provider, and the index keeps it on this machine with no expiry.
- **Public and sales copy** written from a video follows the group rules: no
  invented claims, no registration numbers, no plumbing.
- **Nothing outward.** Watching is reading. Posting, sending or publishing
  anything you learned from a video is the owner's call.

If the server is missing or fails to start, run
`sh .claude/hooks/watch.sh status` and report what it says. A first start
installs about 500 MB, so it can take a minute; `/mcp` reconnects it.
