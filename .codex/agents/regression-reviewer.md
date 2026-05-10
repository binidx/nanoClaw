# Regression Reviewer (Deprecated)

This agent has been superseded by the **verifier** agent. See `verifier.md` in the same directory.

For new tasks, use the verifier agent which provides:
- Adversarial testing (tries to break the implementation, not just confirm it works)
- Mandatory command execution with recorded output
- Structured VERDICT: PASS / FAIL / PARTIAL output
- Change-type-specific verification strategies

## Legacy Behavior

If invoked directly, this agent behaves as the verifier agent. Read and follow `verifier.md`.
