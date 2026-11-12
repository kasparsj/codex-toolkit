import type { DeliverySnapshot } from "../shared/rpc";

export type DeliveryQueryKey = readonly ["toolkit-delivery", string, string];

export interface MutationOrigin {
  hostId: string;
  workspaceId: string;
  queryKey: DeliveryQueryKey;
  scopeDigest: string;
  repo: string;
  worktree: string;
  commonDir: string;
}

export function mutationOrigin(hostId: string, workspaceId: string, queryKey: DeliveryQueryKey, snapshot: DeliverySnapshot): MutationOrigin {
  return { hostId, workspaceId, queryKey, scopeDigest: snapshot.scopeDigest, repo: snapshot.identity.repo, worktree: snapshot.identity.worktree, commonDir: snapshot.identity.commonDir };
}

export function sameMutationOrigin(left: MutationOrigin | undefined, right: MutationOrigin | undefined): boolean {
  return Boolean(left && right && left.hostId === right.hostId && left.workspaceId === right.workspaceId && left.scopeDigest === right.scopeDigest);
}

export function applyMutationSnapshot(input: {
  origin: MutationOrigin;
  snapshot: DeliverySnapshot;
  current: MutationOrigin | undefined;
  cached: DeliverySnapshot | undefined;
  write(snapshot: DeliverySnapshot): void;
  clearCurrentFeedback(): void;
}): "current" | "background" | "stale" | "identity-mismatch" {
  const { origin, snapshot, current, cached } = input;
  if (snapshot.identity.repo !== origin.repo || snapshot.identity.worktree !== origin.worktree || snapshot.identity.commonDir !== origin.commonDir) return "identity-mismatch";
  if (current && current.hostId === origin.hostId && current.workspaceId === origin.workspaceId && current.scopeDigest !== origin.scopeDigest) return "stale";
  if (cached && cached.scopeDigest !== origin.scopeDigest) return "stale";
  input.write(snapshot);
  if (sameMutationOrigin(origin, current)) { input.clearCurrentFeedback(); return "current"; }
  return "background";
}
