# ADR-005: AI classification confidence handling — margin-aware routing

**Status:** Accepted · **Date:** 2026-07-26 · **Answers brief §4.5** · **Related:** [ADR-009](009-deflection-is-not-auto-resolution.md)

## Context

Classification will sometimes be wrong. The brief asks: *"What confidence threshold triggers 'unclassified, route to human triage' versus 'auto-route to suggested queue'? How does the system handle a ticket the AI classifies with 60% confidence as Product X and 35% as Product Y?"*

The costs are asymmetric and that asymmetry should drive the design:

- **Auto-routing wrongly** sends a ticket to the wrong team, where it waits, gets bounced, and burns SLA. Expensive.
- **Over-triaging** puts work back on a human the model could have saved. Cheap, but it erodes the entire value of the AI layer.

## Decision

**Two numbers per prediction — top confidence `p1` *and* margin (`p1 − p2`) — routed into three bands.**

| Condition | Action |
|---|---|
| `p1 ≥ 0.80` **and** margin `≥ 0.25` | **Auto-route** to the suggested product/queue |
| `0.50 ≤ p1 < 0.80`, **or** margin `< 0.15` | **Soft-route** to the suggested queue, flagged `AI-uncertain`, surfaced in triage for one-click confirmation |
| `p1 < 0.50` | **Unclassified → human triage** |

Both probabilities and the model version persist in `ticket.ai_classification`. Thresholds live in `product.config.ai_thresholds` — **config, not code.**

## The brief's worked example

**60% Product X vs 35% Product Y** → `p1 = 0.60`, margin `= 0.25`.

`p1` falls in the middle band → **soft-route to Product X, flagged AI-uncertain.**

- **Not auto-routed**, because 0.60 is below the 0.80 bar — the model is not confident enough to act unsupervised.
- **Not dumped as unclassified**, because a clear leader exists. Discarding that signal wastes information and forces a human to redo work the model already did. The human gets a pre-filled suggestion to confirm or override, not a blank queue entry.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| **Two-number bands (`p1` + margin)** | ✅ **Chosen** | A prediction that is 60% confident and 2% ahead of second place is a *completely different situation* from one that is 60% confident and 30% ahead. Top-1 confidence alone cannot distinguish them, and the correct action differs. |
| **Single threshold on `p1`** | ❌ Rejected | Simplest, and wrong. It auto-routes confident-but-contested predictions — precisely the ones most likely to be wrong. |
| **Binary auto-route / triage, no middle band** | ❌ Rejected | Throws away a usable signal. Every soft-routable ticket becomes full manual triage, which is most of the AI layer's value discarded for implementation simplicity. |
| **Learned/calibrated per-category thresholds** | ⚪ Deferred | Correct at volume. Needs production data we do not have; the fixed bands are the sane cold start. The config-not-code decision is what makes this migration cheap later. |
| **Always auto-route, let humans correct** | ❌ Rejected | Optimises the metric (auto-routing rate) at the expense of the outcome (tickets reaching the right team). Misrouted high-severity tickets breach SLA. |

## Consequences

**Positive**
- Every misclassification is explainable after the fact — both probabilities and `model_version` are stored, so "why did it do that in March?" survives a model swap.
- Uncertain tickets **degrade to manual, never to incorrect**. If the model regresses, throughput drops; correctness does not.
- Per-product thresholds mean a product with high-stakes routing can demand more confidence without a platform deploy.
- The bands map 1:1 to the AI Insights confidence-distribution panel, so the operational view visualises the actual decision rule.

**Negative**
- Three bands are more to explain than one threshold. Mitigated: the worked example above is in the demo script and answers it in 20 seconds.
- The initial numbers (0.80 / 0.25 / 0.50 / 0.15) are judgement, not measurement. Stated plainly rather than dressed up — and they are tunable the moment real volume exists.

## Related

HLD [§15.2](../HLD.md), [§15.3](../HLD.md), [§15.5](../HLD.md) · [ai-service/SKILLS.md](../../ai-service/SKILLS.md) · [demo-script.md §4](../demo-script.md)
