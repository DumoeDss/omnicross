# Ship Log: rasen-managed-route-lease

- Date: 2026-08-11
- Pipeline: `small-feature`
- Delivery mode: **local**
- Branch: `feature/rasen-managed-route-lease`
- Push: **no**
- Pull request: **no**
- Archive timing: **on-merge**
- Archived in ship: **no**

## Scope

Local delivery includes the Route Lease implementation, focused regressions, consumer and requirements documentation, Rasen planning artifacts, and canonical review evidence. Machine-local `.rasen` ephemera, `.codex`, external worktrees, credentials, generated configuration, and temporary IPC artifacts are excluded.

## Verification

- Final independent review: **PASS** — `evidence/review-loop-round-3-final-report.md`
- Open Blocker/Major findings: **0**
- Focused Route Lease gate: **11 files passed; 115 tests passed; 1 skipped**
- Narrow terminal/Admin lifecycle gate: **3 files passed; 26 tests passed; 1 skipped**
- `@omnicross/cli-launcher` typecheck: **passed**
- `@omnicross/core` typecheck: **passed**
- `@omnicross/daemon` typecheck: **passed**
- `rasen validate rasen-managed-route-lease --json`: **passed**
- `git diff --check`: **passed** (Windows LF/CRLF advisories only)

The sole skip is the explicit, local, non-billable real-macOS Terminal eventual-child test. No physical macOS execution is claimed; this is a disclosed platform-evidence gap, not an open implementation finding.

## Delivery

The ship stage creates a local feature-branch commit only. It does not push, open a pull request, tag, publish packages, create a release, deploy, or archive the change. The commit SHA is recorded in machine-local Rasen run-state and the lead's completion report after creation.
