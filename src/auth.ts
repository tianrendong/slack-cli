import { mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { WebClient } from "@slack/web-api";

export interface StoredAuth {
  userToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
  team?: {
    id?: string;
    name?: string;
  };
  enterprise?: {
    id?: string;
    name?: string;
  } | null;
  authedUser?: {
    id?: string;
  };
  updatedAt: string;
}

interface SlackOAuthResponse {
  ok: boolean;
  error?: string;
  authed_user?: {
    id?: string;
    scope?: string;
    access_token?: string;
    token_type?: string;
    expires_in?: number;
    refresh_token?: string;
  };
  team?: {
    id?: string;
    name?: string;
  };
  enterprise?: {
    id?: string;
    name?: string;
  } | null;
}

const DEFAULT_SCOPES = [
  "channels:read",
  "groups:read",
  "im:read",
  "mpim:read",
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "users:read",
  "search:read.public",
  "search:read.private",
  "search:read.mpim",
  "search:read.im",
  "search:read.users",
  "search:read",
];

/**
 * CLI-specific env override for the Slack user token. Intentionally not
 * `SLACK_USER_TOKEN`, which other projects' `.env` files commonly set.
 */
export const ENV_TOKEN_VAR = "SLACK_CLI_USER_TOKEN";

export function authFilePath(): string {
  const base = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(base, "slack-cli", "auth.json");
}

export async function readStoredAuth(): Promise<StoredAuth | undefined> {
  try {
    const raw = await readFile(authFilePath(), "utf8");
    return JSON.parse(raw) as StoredAuth;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function writeStoredAuth(auth: StoredAuth): Promise<void> {
  const path = authFilePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function clearStoredAuth(): Promise<void> {
  await rm(authFilePath(), { force: true });
}

export async function storeUserToken(token: string): Promise<StoredAuth> {
  const client = new WebClient(token);
  const test = await client.auth.test();
  const auth: StoredAuth = {
    userToken: token,
    team: {
      id: typeof test.team_id === "string" ? test.team_id : undefined,
      name: typeof test.team === "string" ? test.team : undefined,
    },
    authedUser: {
      id: typeof test.user_id === "string" ? test.user_id : undefined,
    },
    updatedAt: new Date().toISOString(),
  };
  await writeStoredAuth(auth);
  return auth;
}

export async function getAuthForApi(): Promise<StoredAuth> {
  const envToken = process.env[ENV_TOKEN_VAR];
  if (envToken) {
    return {
      userToken: envToken,
      updatedAt: new Date().toISOString(),
    };
  }

  const stored = await readStoredAuth();
  if (!stored) {
    throw new Error("Not authenticated. Run `bun run slack auth login` or `bun run slack auth token xoxp-...`.");
  }

  if (shouldRefresh(stored)) {
    return refreshStoredToken(stored);
  }

  return stored;
}

function shouldRefresh(auth: StoredAuth): boolean {
  if (!auth.refreshToken || !auth.expiresAt) return false;
  const fiveMinutesFromNow = Date.now() + 5 * 60 * 1000;
  return auth.expiresAt <= fiveMinutesFromNow;
}

async function refreshStoredToken(auth: StoredAuth): Promise<StoredAuth> {
  const clientId = process.env["SLACK_CLIENT_ID"];
  const clientSecret = process.env["SLACK_CLIENT_SECRET"];
  const refreshToken = auth.refreshToken;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Stored Slack token is expiring/expired, but SLACK_CLIENT_ID and SLACK_CLIENT_SECRET are not set for refresh.",
    );
  }
  if (!refreshToken) {
    throw new Error("Stored Slack token has no refresh token.");
  }

  const response = await slackOauthAccess({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const user = response.authed_user;
  if (!response.ok || !user?.access_token) {
    throw new Error(`Slack token refresh failed: ${response.error ?? "missing authed_user.access_token"}`);
  }

  const refreshed: StoredAuth = {
    ...auth,
    userToken: user.access_token,
    refreshToken: user.refresh_token ?? refreshToken,
    expiresAt: user.expires_in ? Date.now() + user.expires_in * 1000 : undefined,
    scope: user.scope ?? auth.scope,
    tokenType: user.token_type ?? auth.tokenType,
    updatedAt: new Date().toISOString(),
  };

  await writeStoredAuth(refreshed);
  return refreshed;
}

export async function runOAuthLogin(options: { openBrowser?: boolean } = {}): Promise<StoredAuth> {
  const clientId = requireEnv("SLACK_CLIENT_ID");
  const clientSecret = requireEnv("SLACK_CLIENT_SECRET");
  const redirectUri = process.env["SLACK_REDIRECT_URI"] ?? "http://localhost:3119/slack/oauth/callback";
  const userScope = process.env["SLACK_USER_SCOPES"] ?? DEFAULT_SCOPES.join(",");
  const state = randomBytes(24).toString("hex");
  const callbackUrl = new URL(redirectUri);

  const authorizeUrl = new URL("https://slack.com/oauth/v2/authorize");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("user_scope", userScope);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("state", state);

  console.log("Open this URL in your browser:");
  console.log(authorizeUrl.toString());
  console.log("");
  if (options.openBrowser !== false) {
    await openBrowser(authorizeUrl.toString());
  }
  console.log(`Waiting for OAuth callback on ${redirectUri}`);

  const code = await waitForOAuthCode(callbackUrl, state);
  const response = await slackOauthAccess({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  const user = response.authed_user;
  if (!response.ok || !user?.access_token) {
    throw new Error(`Slack OAuth failed: ${response.error ?? "missing authed_user.access_token"}`);
  }

  const auth: StoredAuth = {
    userToken: user.access_token,
    refreshToken: user.refresh_token,
    expiresAt: user.expires_in ? Date.now() + user.expires_in * 1000 : undefined,
    scope: user.scope,
    tokenType: user.token_type,
    team: response.team,
    enterprise: response.enterprise,
    authedUser: { id: user.id },
    updatedAt: new Date().toISOString(),
  };

  await writeStoredAuth(auth);
  return auth;
}

async function openBrowser(url: string): Promise<void> {
  const opener = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";

  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const proc = Bun.spawn([opener, ...args], {
    stdout: "ignore",
    stderr: "ignore",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.log("Could not open the browser automatically; use the URL above.");
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function waitForOAuthCode(callbackUrl: URL, expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.stop(true);
      reject(new Error("Timed out waiting for Slack OAuth callback"));
    }, 5 * 60 * 1000);

    const server = Bun.serve({
      hostname: callbackUrl.hostname,
      port: Number(callbackUrl.port || "80"),
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname !== callbackUrl.pathname) {
          return new Response("Not found", { status: 404 });
        }

        const error = url.searchParams.get("error");
        if (error) {
          clearTimeout(timeout);
          server.stop(true);
          reject(new Error(`Slack OAuth returned error: ${error}`));
          return new Response("Slack auth failed. You can close this tab.", { status: 400 });
        }

        const state = url.searchParams.get("state");
        if (state !== expectedState) {
          clearTimeout(timeout);
          server.stop(true);
          reject(new Error("Slack OAuth state mismatch"));
          return new Response("Slack auth failed: state mismatch. You can close this tab.", { status: 400 });
        }

        const code = url.searchParams.get("code");
        if (!code) {
          return new Response("Missing OAuth code", { status: 400 });
        }

        clearTimeout(timeout);
        server.stop(true);
        resolve(code);
        return new Response("Slack auth complete. You can close this tab.");
      },
    });
  });
}

async function slackOauthAccess(params: Record<string, string>): Promise<SlackOAuthResponse> {
  const body = new URLSearchParams(params);
  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Slack OAuth HTTP ${response.status}`);
  }

  return response.json() as Promise<SlackOAuthResponse>;
}
