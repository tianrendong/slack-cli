# slack-cli

Local Slack CLI for searching and reading Slack.

## Install

```bash
brew install tianrendong/tap/slack-cli
```

Optional OAuth app credentials go in `~/.config/slack-cli/.env`
(see `.env.example`).

## Download attachments

```bash
slack download F0123ABC --out ./image.jpg
```

You can also pass a Slack file URL. Downloads require a Slack user token with
`files:read`. If you use `slack auth login`, add `files:read` to your Slack app's
user token scopes and include it alongside your existing scopes in
`SLACK_USER_SCOPES` before signing in again.

## Setup from source

```bash
bun install
cp .env.example .env
bun link
```

Configure credentials in `.env`. Never commit `.env`.

## Environment

The CLI only reads its own `.env` files: the one in its source checkout and
`~/.config/slack-cli/.env`. Bun's automatic
loading of the current working directory's `.env` is disabled via
`bun --no-env-file` in the shebang and package scripts, so running `slack` from
another repo won't pick up that repo's Slack credentials.

Token resolution:

1. `SLACK_CLI_USER_TOKEN` env var, if set (CLI-specific; the generic
   `SLACK_USER_TOKEN` is intentionally ignored).
2. Stored token in `~/.config/slack-cli/auth.json` (from `slack auth token` or
   `slack auth login`).

`slack auth status` shows the token source, user name/ID, team, and scopes.
