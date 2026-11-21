# Pi Slack CLI Extension

Local Pi extension that exposes a local `slack` CLI as first-class Pi tools.

The extension does **not** talk to Slack directly. It shells out to a local
executable named `slack`, so each user authenticates with their own Slack account
and can only read/search Slack content they personally have access to.

## Tools

- `slack_thread` — read a Slack thread from a permalink, or from channel + thread timestamp.
- `slack_read` — read recent channel history.
- `slack_search` — search Slack with Slack search syntax.
- `slack_channels` — list/search accessible channels (results cached locally for 24 h).
- `slack_permalink` — resolve a message/thread URL or channel + timestamp into a permalink.
- `slack_download` — download a file or image attached to a Slack message by file ID or Slack file URL (attaches images inline when <= 4 MB).
- `slack_auth_status` — check local Slack CLI authentication.

### `slack_channels` cache

| Detail | Value |
|---|---|
| Cache file | `~/.cache/pi/slack-channels.json` |
| Default TTL | 24 h |
| Override TTL | `SLACK_CHANNEL_CACHE_TTL_HOURS=<hours>` env var |
| Bypass cache | pass `force: true` to the tool |

The first call fetches from Slack and writes the cache. Subsequent calls within
the TTL window return instantly from disk. The `query` parameter always filters
in-memory (the cache stores the full channel list).

**Privacy**: channel names and IDs are written to `~/.cache/pi/slack-channels.json`.
If your account has access to private channels, their names will appear in the
cache file.

## Commands

This extension does not add any slash commands. It only adds LLM-callable tools.

## Install the Pi extension

From the root of this repo:

```bash
mkdir -p ~/.pi/agent/extensions
cp -R pi-extension ~/.pi/agent/extensions/slack-cli
```

This copies the extension to:

```text
~/.pi/agent/extensions/slack-cli
```

Then reload Pi:

```text
/reload
```

## Install a compatible Slack CLI

The extension resolves the Slack CLI from the first path that exists:

1. `$SLACK_CLI_PATH`
2. `~/.pi/agent/bin/slack`
3. `~/.bun/bin/slack`
4. `/opt/homebrew/bin/slack`
5. `/usr/local/bin/slack`
6. `slack` on `PATH`

Any executable is fine as long as it supports these commands:

```text
slack auth status
slack search <query> [--limit N] [--json]
slack read <channel-id|#channel-name> [--limit N] [--after date] [--before date] [--json]
slack thread <url> [--limit N] [--json]
slack thread <channel-id|#channel-name> <thread_ts> [--limit N] [--json]
slack channels [query] [--limit N] [--json]
slack permalink <url>
slack permalink <channel-id|#channel-name> <message_ts>
slack download <file-id|slack-file-url> [--out <path>] [--json]
```

### Tianren's local Slack CLI layout

If using Tianren's Bun-based Slack CLI, install Bun first:

```bash
curl -fsSL https://bun.sh/install | bash
```

Put the Slack CLI repo at `~/tools/slack-cli`, install dependencies, and create
the wrapper the extension looks for:

```bash
cd ~/tools/slack-cli
bun install

mkdir -p ~/.pi/agent/bin
cat > ~/.pi/agent/bin/slack <<'EOF'
#!/bin/bash
exec "$HOME/.bun/bin/bun" run "$HOME/tools/slack-cli/src/index.ts" "$@"
EOF
chmod +x ~/.pi/agent/bin/slack
```

If your CLI lives somewhere else, either put a compatible `slack` executable on
`PATH` or set:

```bash
export SLACK_CLI_PATH=/absolute/path/to/slack
```

## Authenticate to your Slack workspace

Fastest path if you already have a Slack user token:

```bash
slack auth token xoxp-your-user-token
slack auth status
```

OAuth login is also supported by Tianren's CLI if you have a Slack app client ID
and secret. Put them in the CLI repo's `.env`:

```bash
cat > ~/tools/slack-cli/.env <<'EOF'
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
SLACK_REDIRECT_URI=http://localhost:3119/slack/oauth/callback
EOF

slack auth login
slack auth status
```

Add this redirect URL to your Slack app:

```text
http://localhost:3119/slack/oauth/callback
```

Suggested user token scopes:

```text
channels:read
groups:read
im:read
mpim:read
channels:history
groups:history
im:history
mpim:history
users:read
search:read.public
search:read.private
search:read.mpim
search:read.im
search:read.users
search:read
files:read
```

Tokens are stored by the CLI at:

```text
~/.config/slack-cli/auth.json
```

## Verify in Pi

After installing/authenticating the CLI and reloading Pi, ask Pi to use the tools,
for example:

```text
read this Slack thread: https://your-workspace.slack.com/archives/C123/p1713890000123456
```

## Troubleshooting

- `spawn slack ENOENT`: Pi cannot find the CLI. Create `~/.pi/agent/bin/slack`,
  put `slack` on `PATH`, or set `SLACK_CLI_PATH`.
- `Not authenticated`: run `slack auth login` or `slack auth token ...` outside
  Pi, then retry the Slack request.
- Slack URLs from another workspace fail: authenticate with a user token for that
  workspace.
- `slack_channels` can be slow or rate-limited on the first call because it may
  need to page through many Slack conversations. Subsequent calls within the TTL
  window are served instantly from the local cache. Prefer `slack_search` or
  direct channel IDs when possible.
- **Stale channel list**: use `force: true` on `slack_channels`, or delete
  `~/.cache/pi/slack-channels.json`, to force a fresh fetch.
