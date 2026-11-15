export interface ParsedArgs {
  command?: string;
  subcommand?: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseCliArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i += 1) {
    const raw = rest[i];
    if (!raw) continue;

    if (raw === "--") {
      positionals.push(...rest.slice(i + 1));
      break;
    }

    if (raw.startsWith("--")) {
      const withoutPrefix = raw.slice(2);
      const [key, inlineValue] = withoutPrefix.split("=", 2);
      if (!key) continue;

      if (inlineValue !== undefined) {
        flags[key] = inlineValue;
        continue;
      }

      const next = rest[i + 1];
      if (next && !next.startsWith("-")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }

    if (raw.startsWith("-") && raw.length > 1) {
      const key = raw.slice(1);
      flags[key] = true;
      continue;
    }

    positionals.push(raw);
  }

  const subcommand = positionals.shift();
  return { command, subcommand, positionals, flags };
}

export function readStringFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

export function readBoolFlag(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true;
}

export function readIntFlag(
  flags: Record<string, string | boolean>,
  name: string,
  fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  const raw = readStringFlag(flags, name);
  if (!raw) return fallback;

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`--${name} must be an integer`);
  }

  if (options.min !== undefined && value < options.min) {
    throw new Error(`--${name} must be at least ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`--${name} must be at most ${options.max}`);
  }

  return value;
}
