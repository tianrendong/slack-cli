import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Loads `.env` files without overriding existing env vars. Earlier files win:
 * 1. `.env` next to the source checkout (dev installs)
 * 2. `$XDG_CONFIG_HOME/slack-cli/.env` (default `~/.config/slack-cli/.env`)
 */
export async function loadLocalEnv(): Promise<void> {
  const configBase = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  for (const envPath of [join(import.meta.dirname, "..", ".env"), join(configBase, "slack-cli", ".env")]) {
    await loadEnvFile(envPath);
  }
}

async function loadEnvFile(envPath: string): Promise<void> {
  try {
    const raw = await readFile(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const parsed = parseEnvLine(line);
      if (!parsed) continue;

      const [key, value] = parsed;
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

function parseEnvLine(line: string): [string, string] | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;

  const withoutExport = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
  const equalsIndex = withoutExport.indexOf("=");
  if (equalsIndex === -1) return undefined;

  const key = withoutExport.slice(0, equalsIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return undefined;

  const rawValue = withoutExport.slice(equalsIndex + 1).trim();
  return [key, unquote(rawValue)];
}

function unquote(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  const commentIndex = value.indexOf(" #");
  if (commentIndex !== -1) {
    return value.slice(0, commentIndex).trimEnd();
  }

  return value;
}
