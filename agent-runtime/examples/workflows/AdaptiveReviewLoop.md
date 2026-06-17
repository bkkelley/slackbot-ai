---
name: AdaptiveReviewLoop
steps:
  - type: agent
    agent: Builder
    action: Draft Change
    toolset: code
    successWhen: output_includes
    successText: READY_FOR_REVIEW
    maxAttempts: 2
    jumpOnSuccess: 2
  - type: agent
    agent: Reviewer
    action: Review Change
    toolset: code
    successWhen: output_includes
    successText: APPROVED
    onFailure: continue
    jumpOnFailure: 3
    maxVisits: 3
  - type: agent
    agent: Builder
    action: Apply Review Feedback
    toolset: code
    runIf: previous_failed
    successWhen: output_includes
    successText: READY_FOR_REVIEW
    maxAttempts: 2
    jumpOnSuccess: 2
    maxVisits: 3
  - type: approval
    prompt: "Reviewer approved the change. Publish it?"
    timeoutMinutes: 60
    onDeny: abort
    onTimeout: abort
  - type: agent
    agent: Publisher
    action: Publish Change
    toolset: default
---

# AdaptiveReviewLoop

This is a checked-in example of the adaptive workflow pattern:

1. Builder drafts the change and emits `READY_FOR_REVIEW`.
2. Reviewer emits `APPROVED` when the work is acceptable.
3. If review does not produce `APPROVED`, the workflow jumps to the feedback step.
4. The feedback step applies fixes, emits `READY_FOR_REVIEW`, then jumps back to review.
5. A human approval gates final publishing.

## Marker Contract

- `Builder / Draft Change` must emit `READY_FOR_REVIEW` only when the draft is ready for review.
- `Reviewer / Review Change` must emit `APPROVED` only when no blocking issues remain.
- `Builder / Apply Review Feedback` must emit `READY_FOR_REVIEW` only when fixes are ready for another review.
