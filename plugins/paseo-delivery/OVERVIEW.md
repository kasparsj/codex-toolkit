# Toolkit Delivery plugin

Toolkit Delivery adds a repository-scoped `/delivery` command to Paseo. Run it from a workspace composer to open or focus that workspace's native Delivery panel. The backend refreshes the selected workspace through the Paseo SDK, derives the Git repository from its server-side directory, and invokes the portable TypeScript engine. Opening, refreshing, switching to, closing, or reopening the panel never starts or resumes work.

The panel shows repository-runner state separately from delivery stages. An explicit Start creates one one-shot runner. Closing the panel or reloading the plugin leaves explicitly started work running; reopening reconnects to durable state. Pause establishes a safe barrier, Stop drains and exits while preserving unfinished work, Cancel owns a separate effect-disposition flow, and process loss remains uncertain until explicit safe recovery.

## Trusted engine configuration

The plugin resolves a source engine only by walking ancestors of its own module location. It does not search the daemon working directory. If a bundled runtime does not expose `import.meta.url`, or the engine is not installed beside the plugin, configure the absolute engine command in the backend's normal private file:

```text
~/.config/codex-toolkit/delivery-v2/dashboard.json
```

The parent directory must be owner-owned mode `0700`; the JSON must be an owner-owned, non-symlink regular file mode `0600`:

```json
{
  "cliArgv": [
    "/absolute/path/to/node-22.19-or-newer",
    "--experimental-strip-types",
    "/absolute/path/to/packages/delivery/src/cli.ts"
  ],
  "workspaceOperatorGrant": "an-explicit-protected-host-control-grant"
}
```

`workspaceOperatorGrant` is optional and remains backend-only. It enables revision-bound delivery controls and digest-bound publication actions; it does not enable unattended scheduling or bypass repository publication policy. The legacy `operatorGrant` key is ignored. The browser never receives this grant, GitHub credentials, private profiles, publisher configuration, state roots, or executable paths.

**Retry reviewer preflight** appears only for a protected refusal proving that review work never began. It retains the exact implementation and check evidence, requires explicit authorization, and cannot retry uncertain or accepted work. A stopped repository stays stopped until Resume; a paused repository requires Resume or Stop before new retry authorization.

The backend also supports `PASEO_DELIVERY_DASHBOARD_CONFIG` and `DELIVERY_REGISTRY_DIR` for an isolated installation. Paseo 0.15.4 preserves these variables for both `daemon start` and `daemon run`. Set them when starting a new daemon; reusing a running instance does not update its environment. Use the default dashboard path for normal persistent startup. A disposable foreground host can use `paseo daemon run --home <isolated-home>` with explicit environment values. The [repository experience guide](../../docs/paseo-delivery-v2/repository-experience.md#host-and-engine-configuration) contains the isolated-host recipe and its validation limitation.

## First-use repository setup

When a repository has no protected binding, the panel can:

- import an existing owner-only Delivery profile; or
- create one from protected policy, publisher, executor, checker, reviewer, and skill-source assets.

Create mode requires separate non-empty planning and implementation allowlists containing narrow repository-relative slash paths. Setup validates the repository and every asset before saving. A new profile uses PR publication `off`, issue publication `off`, and unattended scheduling disabled. Saving does not create a run, launch a process, inherit a global grant, change credentials, or authorize publication.

The client sends only a workspace ID, exact scope/revision, request ID, allowed action, setup asset references, and—when explicitly publishing—the projected draft digest. Operational RPCs cannot supply a repository, working directory, state root, executable, credential, grant, or provider.

## Publication and portability

Publication safeguards remain in the engine: exact candidate and base identity, stage handoff digest, checks, independent review, policy, publisher actor/repository identity, and current GitHub readback. With publication `off`, an operator can use the CLI-only `export-handoff` and read-only `bind-manual-pr` route without changing policy. The panel does not expose arbitrary output paths or perform that manual publication.

The engine and protected state remain usable through the TypeScript CLI without Paseo. The plugin has no merge, deployment, approval, mark-ready, label, credential-management, or schedule-enablement endpoint. The old global Delivery sidebar is superseded as the primary workflow. Existing Python delivery code remains rollback/reference material until the separate final-candidate acceptance matrix passes.
