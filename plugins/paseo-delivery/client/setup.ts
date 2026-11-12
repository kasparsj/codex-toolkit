export function parseAllowedPaths(value: string, label: string): { paths?: string[]; error?: string } {
  const paths = value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  if (!paths.length) return { error: `Add at least one ${label} path.` };
  for (const path of paths) {
    const segments = path.split("/");
    if (path.startsWith("/") || path === "." || path.includes("\\") || /[?*\[\]]/.test(path) || segments.some((segment) => !segment || segment === "." || segment === "..")) {
      return { error: `${label} path "${path}" must be a narrow repository-relative slash path without glob characters, empty segments, dot or dot-dot segments.` };
    }
  }
  return { paths: [...new Set(paths)].sort() };
}

export function setupRequestKey(scope: string, repo: string, revision: number, setup: unknown): string {
  return [scope, repo, String(revision), JSON.stringify(setup)].join("\u0000");
}

export function requestIdFor(cache: Map<string, string>, key: string, create: () => string): string {
  const existing = cache.get(key);
  if (existing) return existing;
  const created = create(); cache.set(key, created); return created;
}

export function setupFailureIsUncertain(message: string | undefined): boolean {
  return /outcome[^.]*uncertain|outcome is unknown|DAEMON_REQUEST_TIMEOUT|network|connection|disconnected|transport/i.test(message ?? "");
}

export function setupUncertaintyActive(value: string | undefined): boolean { return value === "setup" || Boolean(value?.startsWith("setup:")); }

export function setupFeedback(validationError: string | undefined, error: string | undefined, uncertain: boolean): string | undefined {
  return validationError ?? error ?? (uncertain ? "The returned setup result could not be bound safely to this repository. Reconcile before retrying." : undefined);
}
