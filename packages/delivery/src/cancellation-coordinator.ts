import { digest, requireCondition } from "./core.ts";
import { DeliveryEngine } from "./engine.ts";
import type { CancellationContext, CancellationOwnedAdapters } from "./ports.ts";
import { processIdentity, RepositoryRegistry, type CancellationReservation } from "./repository.ts";

export interface CoordinatedCancellation {
  context: CancellationContext;
  reservation: CancellationReservation;
}

export function beginCoordinatedCancellation(options: { registry: RepositoryRegistry; engine: DeliveryEngine; repo: string; deliveryId: string; expectedRevision: number; requestId: string; inputDigest: string; grant?: string }): CoordinatedCancellation {
  const before = options.registry.readSession(options.repo), generation = before.generation || options.engine.store.read(options.repo, options.deliveryId).claim_generation, ownerTokenDigest = before.owner_token_digest ?? digest({ repo: options.repo, generation, stopped: true });
  const reserved = options.registry.reserveCancellation(options.repo, { delivery_id: options.deliveryId, request_id: options.requestId, input_digest: options.inputDigest, expected_revision: options.expectedRevision, generation, owner_token_digest: ownerTokenDigest }), reservation = reserved.reservation;
  const context: CancellationContext = { repo: options.repo, delivery_id: options.deliveryId, expected_revision: options.expectedRevision, request_id: options.requestId, input_digest: options.inputDigest, repository_generation: reservation.generation, ...(options.grant === undefined ? {} : { grant: options.grant }) };
  let begun;
  try { begun = options.engine.beginCancellation(context); }
  catch (error) { if (reserved.rollback_snapshot) options.registry.rollbackPendingCancellation(options.repo, reservation.token, reserved.rollback_snapshot); throw error; }
  requireCondition(begun.request_digest === options.inputDigest, "engine cancellation request digest changed", "REQUEST_CONFLICT");
  if (reservation.epoch.startsWith("pending:")) options.registry.bindCancellationEpoch(options.repo, reservation.token, begun.epoch);
  else requireCondition(reservation.epoch === begun.epoch, "repository and engine cancellation epochs differ", "REQUEST_CONFLICT");
  return { context, reservation: reserved.replayed ? reservation : options.registry.readSession(options.repo).cancellation! };
}

export async function reconcileCoordinatedCancellation(options: { registry: RepositoryRegistry; engine: DeliveryEngine; coordinated: CoordinatedCancellation; adapters?: CancellationOwnedAdapters }): Promise<"reconciling" | "draining" | "complete" | "uncertain"> {
  const original = options.coordinated.reservation;
  if (original.phase === "complete") return "complete";
  const claimed = options.registry.reserveCancellation(options.coordinated.context.repo, { delivery_id: original.delivery_id, request_id: original.request_id, input_digest: original.input_digest, expected_revision: original.expected_revision, generation: original.generation, owner_token_digest: original.owner_token_digest }).reservation;
  requireCondition(claimed.token === original.token && claimed.epoch === original.epoch, "cancellation identity changed during observer takeover", "RUNNER_BARRIER");
  if (claimed.phase === "complete") return "complete";
  const result = await options.engine.reconcileCancellation(options.coordinated.context, options.adapters ?? {});
  const refreshedSession = options.registry.readSession(options.coordinated.context.repo), refreshed = refreshedSession.cancellation;
  requireCondition(refreshed?.token === claimed.token && refreshed.epoch === claimed.epoch && refreshed.input_digest === claimed.input_digest && refreshed.generation === claimed.generation, "cancellation identity changed after engine reconciliation", "RUNNER_BARRIER");
  if (refreshed.phase === "complete") return "complete";
  const phased = options.registry.updateCancellationPhase(options.coordinated.context.repo, claimed.token, result.status === "draining" || result.status === "complete" ? "draining" : "reconciling");
  if (phased.cancellation?.phase === "complete") return "complete";
  if (result.status !== "draining" && result.status !== "complete") return result.status;
  const currentIdentity = processIdentity(process.pid);
  if (phased.owner_pid !== null && (phased.owner_pid !== process.pid || phased.owner_process_identity !== currentIdentity)) return "draining";
  const acknowledged = options.registry.acknowledgeCancellationDrain(options.coordinated.context.repo, claimed.generation, claimed.owner_token_digest, claimed.token);
  if (acknowledged.cancellation?.phase === "complete") return "complete";
  const claimGeneration = options.engine.store.read(options.coordinated.context.repo, claimed.delivery_id).claim_generation;
  options.registry.withCancellationFinalization({ repo: options.coordinated.context.repo, delivery_id: claimed.delivery_id, request_id: claimed.request_id, input_digest: claimed.input_digest, epoch: claimed.epoch, reservation_token: claimed.token, generation: claimed.generation, claim_generation: claimGeneration, owner_token_digest: claimed.owner_token_digest }, (fence) => options.engine.finalizeCancellation(options.coordinated.context, fence));
  return "complete";
}
