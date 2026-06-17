---
name: AdaptiveSmoke
steps:
  - type: agent
    agent: Ask the System
    action: Diagnose
    toolset: vault-readonly
    successWhen: output_includes
    successText: ADAPTIVE_SMOKE_PASS
    onFailure: continue
    maxAttempts: 1
  - type: agent
    agent: Ask the System
    action: Diagnose
    toolset: vault-readonly
    runIf: previous_failed
---

# AdaptiveSmoke

This project-scoped workflow is a live smoke test for adaptive workflow control.

The first step intentionally requires the marker `ADAPTIVE_SMOKE_PASS`, which the diagnostic action is not expected to emit. Because `onFailure: continue` is set, the workflow should mark step 1 failed but handled, then run step 2 through `runIf: previous_failed`.

## Marker Contract

- Step 1 intentionally checks for `ADAPTIVE_SMOKE_PASS` to exercise failure handling.
- Step 2 should run only after step 1 fails.
