# Proposed implementation boundary (pending consensus)

The engine owns these portable commands; plugin uses only fixed executable + argument arrays and stdin JSON, never a Python bridge. Operational directory is always freshly SDK-resolved by server, never accepted from an operational RPC client.

- `workspace-status --directory <cwd>` returns identity, setup, runner and safe runs.
- `workspace-setup --directory <cwd> --expected-revision <n> --request-id <id>` reads one setup JSON request on stdin. Validates and binds only; never executes. Import `{profilePath}` or structured creation `{policyPath,skillsRoot,publisherConfigPath,executorConfigPath,checkerConfigPath,reviewerConfigPath}` referencing protected existing asset files. Generated foreground policy off/off/auto_schedule:false. Explicit asset paths are accepted ONLY by setup; RPC controls never choose state/executable/repository.
- `runner-control --directory <cwd> --expected-revision <n> --request-id <id> --action start|pause|resume|stop|recover [--issue <n>]` requests fenced lifecycle control. No automatic launch on reads. Pending drain is not acknowledged paused/stopped.
- `workspace-command --directory <cwd> --delivery-id <id> --expected-revision <n> --request-id <id> --action <existing-run-action> [--digest <exact>]` delegates through existing grants/gates and rechecks repository binding. Optional internal command can wrap existing controls instead.

Envelope stays `{ok:true,data}` or `{ok:false,error:{code,message}}`.
DTO proposed fields:
`identity:{repo,gitRoot,commonDir,worktree,branch,head}`;
`setup:{configured,revision,defaultProfilePath,problems:string[]}`;
`runner:{revision,status,desiredState,observedState,reason?,heartbeatAt?,deliveryId?,generation?}`;
`runs:DeliveryRun[]`, `operatorActions:OperatorAction[]`, `generatedAt`, `warnings:string[]`.

Default registry under owner-only Toolkit config outside Paseo, trusted process override DELIVERY_REGISTRY_DIR. Root's environment override not client input. Registry binds one profile/state root per canonical repo and rejects replacement while bound/active. Monorepo plugin defaults to sibling engine CLI with process.execPath; explicit host cliArgv retains installed-package use. A missing engine installation is a visible prerequisite error, never inferred executable code from repo contents.

Owner A may refine exact field spelling before product coding, then notify B/leader; B must consume the shared boundary rather than invent another engine/registry.
