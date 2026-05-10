# Social And Community

Use platform-native upstream tools where possible. Start read-only, then escalate to write actions only if the user asked.

## XiaoHongShu

```bash
xhs search "query"
xhs read NOTE_ID_OR_URL
xhs comments NOTE_ID_OR_URL
xhs hot
```

- Install with `pipx install xiaohongshu-cli`
- Login with `xhs login`
- Do not fabricate a bare `note_id`; prefer a URL or an ID returned by `xhs search`

## Douyin

```bash
mcporter call 'douyin.parse_douyin_video_info(share_link: "https://v.douyin.com/xxx/")'
mcporter call 'douyin.get_douyin_download_link(share_link: "https://v.douyin.com/xxx/")'
```

- Install `douyin-mcp-server`
- Register it with `mcporter`
- Treat this as an optional channel unlock

## Twitter / X

```bash
twitter feed -n 20
twitter tweet URL_OR_ID
twitter user-posts @username -n 20
twitter search "query" -n 10
```

- Install with `pipx install twitter-cli`
- Expect search instability when X changes upstream APIs

## Reddit

```bash
rdt search "query" --limit 10
rdt read POST_ID
rdt sub python --limit 20
```

## V2EX

```bash
curl -s "https://www.v2ex.com/api/topics/hot.json" -H "User-Agent: agent-reach/1.0"
curl -s "https://www.v2ex.com/api/topics/show.json?node_name=python&page=1" -H "User-Agent: agent-reach/1.0"
```

## Weibo

- Prefer reading public pages through general web reading when no dedicated MCP is configured
- If a Weibo MCP alias exists under `mcporter`, use that instead

## Bilibili

```bash
yt-dlp --dump-json "https://www.bilibili.com/video/BVxxx"
yt-dlp --write-sub --write-auto-sub --skip-download -o "/tmp/%(id)s" "URL"
```
