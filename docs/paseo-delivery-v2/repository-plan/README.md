# Reviewed repository Delivery plan

This directory publishes the exact repo-local planning artifacts approved by the sequential Planner → Architect → Critic review on 2026-11-11. The copied source files are byte-for-byte identical to their approved `.omx/plans` counterparts.

| Artifact | Purpose | Approved SHA-256 |
| --- | --- | --- |
| [Implementation plan](implementation-plan.md) | Component boundaries, ownership, execution, migration and delivery sequence | `ad5daffad62c3bde80d3ccc3e3412769c83c9dd5a96a75d30a4a82a29ea7e92c` |
| [Acceptance test specification](test-spec.md) | Atomic repository and retained local-mode acceptance coverage | `36a76c26aee01d72bb2739ce9818ec73fd63bc2f54e092eff226c89951112aa5` |
| [Runtime interface](runtime-interface.md) | Frozen repository CLI, DTO and ownership seam | `27e12d65ddd67abec2f4a1872a31047ed55f07c1a379e8b6ffb112543901b673` |
| [Architect review](architect-review.md) | Architecture approval for the exact three artifacts above | `37bde3142ac6b92935f3861ad3114564b39b4a7c82e08611cada7906ca1806c3` |
| [Critic review](critic-review.md) | Independent consensus approval for the same revision | `663ea43023f3a6a7d4bb2881b3726ea6662e7501f4f70931bd03e1324bdebdd1` |

The later independent implementation review produced an approved post-review repair addendum. These files are also byte-for-byte copies of their `.omx/plans/repository-delivery/` sources:

| Artifact | Purpose | Approved SHA-256 |
| --- | --- | --- |
| [Post-review repair plan](post-review-repair-plan.md) | Repairs the reviewed adapter, engine, publication, repository and cancellation boundaries without reducing scope | `f766c8013e05c73e62d694a07a3c8fd4b9309e3cb45202b8188a8d71bbb7de4d` |
| [Post-review repair test specification](post-review-repair-test-spec.md) | Adds R01–R11 atomic repair assertions while retaining all original targets | `71f17f8f4c175da4a5a4196595a61acc764e36fd06c16ee754a6c50481021f3f` |
| [Post-review Architect receipt](post-review-architect.md) | Architecture approval for the exact repair artifacts | `686e4766570c9ad39f28d64f1f57449af5fc56d6297ca5ddf93f2090fb0c96a1` |
| [Post-review Critic receipt](post-review-critic.md) | Independent consensus approval for the exact repair artifacts | `fc2ad4de77b01946565c3aac7ebdae05eb7e6e9d695ea894a274cc3412fb6d66` |
| [Post-review handoff receipt](post-review-handoff.json) | Planning review routing and matching artifact digests | `5f57b7dda7a23a437e8579b3fbc4b43b72140a65b98387785650773be245b15d` |

The Architect and Critic approvals are planning approvals only. They authorized implementation after consensus; they do not establish implementation acceptance.

Implementation proceeded beyond both approved plans. Candidate 8 was later rejected by independent code and architecture review, the full engine suite and real Pi compatibility evidence. Subsequent repairs remain work in progress until one coherent frozen source set passes the full suite, independent re-review, integrated provider and packaged journeys, and final native validation. Final acceptance therefore remains pending per [the atomic evidence matrix](../evidence/repository-experience/criteria.md). Historical test totals, planning approvals and copied artifacts do not pass those criteria.

No session-routing data, handoff tokens, operator grants or protected configuration are included here.
