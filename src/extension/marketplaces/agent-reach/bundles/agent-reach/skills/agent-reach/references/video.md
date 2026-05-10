# Video And Audio

Use `yt-dlp` for metadata and subtitles before reaching for heavier transcription flows.

## Commands

```bash
yt-dlp --dump-json "URL"
yt-dlp --write-sub --write-auto-sub --sub-lang "zh-Hans,zh,en" --skip-download -o "/tmp/%(id)s" "URL"
```

## Rules

- Prefer existing subtitles over full audio transcription.
- Use `/tmp/` for subtitle output and summarize from the generated text.
- For Bilibili, expect some server-side access issues and switch to cookies or a better network path only when needed.
