# Agent Reach

Bring Agent Reach style internet routing into NanoClaw.

Use this skill when the user wants web search, web reading, GitHub lookup, social/community lookup, or video transcript extraction. Treat it as a router plus operating guide for upstream tools such as `mcporter`, `xhs-cli`, `twitter-cli`, `rdt-cli`, `yt-dlp`, `gh`, and `curl https://r.jina.ai/...`.

## Route Table

| User intent | Read next |
| --- | --- |
| Web search / semantic search | [references/search.md](references/search.md) |
| XiaoHongShu / Douyin / Twitter / Weibo / Bilibili / V2EX / Reddit | [references/social.md](references/social.md) |
| GitHub / repos / issues / PRs | [references/dev.md](references/dev.md) |
| Web pages / articles / WeChat articles / RSS | [references/web.md](references/web.md) |
| YouTube / Bilibili subtitles / podcast transcription | [references/video.md](references/video.md) |
| LinkedIn / jobs / company research | [references/career.md](references/career.md) |

## Quick Commands

```bash
# Web search through Exa via mcporter
mcporter call 'exa.web_search_exa(query: "query", numResults: 5)'

# Generic web page reading
curl -s "https://r.jina.ai/http://example.com"

# GitHub repo search
gh search repos "query" --sort stars --limit 10

# Twitter/X search
twitter search "query" --limit 10

# XiaoHongShu search
xhs search "query"

# Reddit search
rdt search "query" --limit 10

# YouTube or Bilibili subtitle extraction
yt-dlp --write-sub --write-auto-sub --skip-download -o "/tmp/%(id)s" "URL"
```

## Operating Rules

- Prefer the upstream tool directly. Do not wrap tool output in extra shell scripts unless the task needs normalization.
- Start with read-only commands before write actions such as posting, commenting, liking, or following.
- For cookie-gated channels, confirm the user already logged in locally and only then ask for the minimal cookie export.
- Keep temporary output under `/tmp/` and avoid writing to the repo unless the user asked for a persistent artifact.

## Setup Flow

```bash
agent-reach doctor
```

If the environment is missing tools, use the upstream install guide:

`https://raw.githubusercontent.com/Panniantong/agent-reach/main/docs/install.md`

Treat these as optional channel unlocks, not mandatory dependencies:

- `xhs-cli` for XiaoHongShu
- `douyin-mcp-server` for Douyin
- `twitter-cli` for Twitter/X
- `rdt-cli` for Reddit
- `mcporter + Exa` for semantic search and WeChat article search
- `yt-dlp` for YouTube/Bilibili subtitles

## Notes

- NanoClaw's managed MCP model is best for native stdio servers. Agent Reach is broader: it combines CLI tools, mcporter aliases, and external MCP services.
- Because of that, this bundle focuses on skill routing and operator guidance instead of pretending every channel is a first-class NanoClaw managed MCP server.
