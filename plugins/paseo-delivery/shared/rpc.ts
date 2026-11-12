import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const state = z.enum(["pending", "running", "waiting", "attention", "blocked", "failed", "completed", "cancelled", "stale", "unknown"]);
const link = z.string().url().refine((value) => new URL(value).protocol === "https:" && new URL(value).hostname === "github.com", "link must be an HTTPS github.com URL").optional();
const check = z.object({ name: z.string(), status: state, summary: z.string().optional(), url: link });
const action = z.enum(["pause", "resume", "cancel", "recover", "publish_plan", "publish_implementation", "correct", "recheck_ready", "retry_review"]);
export const operatorActionSchema = action;
export type OperatorAction = z.infer<typeof action>;
const runnerAction = z.enum(["start", "pause", "resume", "stop", "recover"]);
export type RunnerAction = z.infer<typeof runnerAction>;
const requestId = z.string().min(8).max(160);
const expectedRevision = z.number().int().nonnegative();
const scopeDigest = z.string().regex(/^[0-9a-f]{64}$/);
const absolutePath = z.string().min(1).max(4096).refine((value) => value.startsWith("/"), "path must be absolute");
const repositoryRelativePath = z.string().min(1).refine((value) => {
  const segments = value.split("/");
  return !value.startsWith("/") && value !== "." && !value.includes("\\") && !/[?*\[\]]/.test(value) && !segments.some((segment) => !segment || segment === "." || segment === "..");
}, "path must be a narrow repository-relative slash path without glob characters");

export function operatorRequestKey(input: { repo: string; deliveryId: string; revision: number; action: OperatorAction; draftDigest?: string }): string {
  return [input.repo, input.deliveryId, String(input.revision), input.action, input.draftDigest ?? ""].join("\u0000");
}

export const runSchema = z.object({
  repo: z.string(), deliveryId: z.string(), status: z.string(), revision: z.number().int().nonnegative(), updatedAt: z.string(), stale: z.boolean(),
  objective: z.string().max(500).optional(), selectedStage: z.string().max(100).optional(), sourceRevision: z.union([z.string(), z.number()]).optional(), currentRevision: z.union([z.string(), z.number()]).optional(), evidenceAt: z.string().optional(), evidenceStale: z.boolean().default(false),
  issueUrl: link, prUrl: link,
  stages: z.array(z.object({ id: z.string(), label: z.string(), status: state, summary: z.string().optional(), attempts: z.number().int().nonnegative().optional() })).default([]),
  blockers: z.array(z.object({ code: z.string(), message: z.string(), stage: z.string().optional() })).default([]),
  review: z.object({ headSha: z.string().optional(), baseSha: z.string().optional(), fresh: z.boolean(), instructions: z.array(z.string()).default([]), receipts: z.array(z.object({ login: z.string(), state: z.string(), commitId: z.string().optional(), submittedAt: z.string().optional(), url: link })).default([]) }).optional(),
  checks: z.object({ local: z.array(check).default([]), actions: z.array(check).default([]) }).optional(),
  evidence: z.array(z.object({ id: z.string(), kind: z.string(), label: z.string(), summary: z.string().optional(), url: link, createdAt: z.string() })).default([]),
  history: z.array(z.object({ revision: z.number().int().nonnegative(), at: z.string(), event: z.string(), summary: z.string().optional() })).default([]),
  finalReport: z.union([z.string(), z.object({ status: z.string(), summary: z.string() })]).nullish(),
  draft: z.object({ kind: z.enum(["plan_pr", "implementation_pr", "issue"]), id: z.string(), digest: z.string(), status: z.string(), title: z.string().optional(), bodyAvailableInCli: z.boolean().default(true), publicationMode: z.enum(["off", "explicit", "automatic"]).optional() }).optional(),
  unresolvedEffects: z.array(z.string().min(1).max(300)).max(50).default([]),
  availableActions: z.array(action).default([]),
});

const identitySchema = z.object({ repo: z.string(), gitRoot: absolutePath, commonDir: absolutePath, worktree: absolutePath, branch: z.string().nullable(), head: z.string().regex(/^[0-9a-f]{40}$/) });
const setupSchema = z.object({ configured: z.boolean(), revision: expectedRevision, defaultProfilePath: absolutePath, problems: z.array(z.string().min(1).max(500)).max(50).default([]) });
const runnerSchema = z.object({
  revision: expectedRevision,
  status: z.enum(["starting", "running", "pausing", "paused", "stopping", "stopped", "blocked", "uncertain"]),
  desiredState: z.enum(["running", "paused", "stopped"]), observedState: z.enum(["alive", "not_running", "lost", "unknown"]),
  reason: z.string().max(500).optional(), heartbeatAt: z.string().optional(), deliveryId: z.string().optional(), generation: z.number().int().nonnegative().optional(),
});

export const workspaceSnapshotSchema = z.object({
  schemaVersion: z.number().int(), generatedAt: z.string(), scopeDigest, identity: identitySchema, setup: setupSchema, runner: runnerSchema,
  runs: z.array(runSchema).default([]), operatorActions: z.array(action).default([]), warnings: z.array(z.string().min(1).max(500)).max(50).default([]),
});
export type DeliverySnapshot = z.infer<typeof workspaceSnapshotSchema>;
export type DeliveryRun = z.infer<typeof runSchema>;

const workspaceInput = z.object({ workspaceId: z.string().min(1).max(200) });
export const workspaceStatusRpc = defineRpc({ name: "toolkit-delivery.workspace-status", input: workspaceInput, output: workspaceSnapshotSchema });

export const setupRequestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("import"), profilePath: absolutePath }),
  z.object({
    mode: z.literal("create"), policyPath: absolutePath,
    policy: z.object({ ref: z.string(), sha: z.string().regex(/^[0-9a-f]{40}$/), digest: z.string().regex(/^[0-9a-f]{64}$/), fetched_at: z.string() }),
    skillsRoot: absolutePath, publisherConfigPath: absolutePath, executorConfigPath: absolutePath,
    checkerConfigPath: absolutePath.optional(), reviewerConfigPath: absolutePath.optional(),
    allowedPaths: z.object({ plan: z.array(repositoryRelativePath).min(1), implementation: z.array(repositoryRelativePath).min(1) }),
  }),
]);
export type SetupRequest = z.infer<typeof setupRequestSchema>;
export const workspaceSetupRpc = defineRpc({ name: "toolkit-delivery.workspace-setup", input: workspaceInput.extend({ expectedRevision, expectedScope: scopeDigest, requestId, setup: setupRequestSchema }), output: workspaceSnapshotSchema });
export const runnerControlRpc = defineRpc({ name: "toolkit-delivery.runner-control", input: workspaceInput.extend({ expectedRevision, expectedScope: scopeDigest, requestId, action: runnerAction, issue: z.number().int().positive().optional() }), output: workspaceSnapshotSchema });
export const workspaceCommandRpc = defineRpc({ name: "toolkit-delivery.workspace-command", input: workspaceInput.extend({ deliveryId: z.string(), expectedRevision, expectedScope: scopeDigest, requestId, action, draftDigest: z.string().regex(/^[0-9a-f]{64}$/).optional() }), output: workspaceSnapshotSchema });
