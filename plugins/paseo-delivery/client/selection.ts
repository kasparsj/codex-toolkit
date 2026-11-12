export function storedRunSelection(state: unknown, expectedScope?: string): string | undefined {
  if (!state || typeof state !== "object") return undefined;
  const panelState = state as { scope?: unknown; selected?: unknown };
  if (expectedScope !== undefined && typeof panelState.scope === "string" && panelState.scope !== expectedScope) return undefined;
  const selected = panelState.selected;
  return typeof selected === "string" ? selected : undefined;
}

export function reconcileRunSelection(current: string | undefined, visibleIds: readonly string[]): string | undefined {
  return current && visibleIds.includes(current) ? current : visibleIds[0];
}
