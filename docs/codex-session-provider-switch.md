# Codex session provider migration

The Code CLI page now includes a Codex Sessions panel. It scans the project
folder entered there against the Codex data directory on the daemon host,
shows the session id, provider, model, timestamps and rollout state, and lets
the operator migrate selected sessions from any provider to any other provider.

The migration is deliberately scoped to selected session ids. It updates only
the structured JSON properties `model_provider` and `model_provider_id` in the
rollout JSONL, then updates `threads.model_provider` in `state_5.sqlite` in the
same operation. Model names and message/tool text are not changed. The current
provider filter is optional; leaving it empty means “match every structured
provider value in the selected sessions”.

## Runtime and storage

- `CODEX_HOME` selects the Codex data directory. If it is unset, Omnicross uses
  the current user's `.codex` directory.
- Rollouts are discovered under `CODEX_HOME/sessions/**/*.jsonl`.
- The SQLite index is `CODEX_HOME/state_5.sqlite`.
- The session feature requires a daemon runtime with `node:sqlite` support
  (Node.js 22.16 or newer). Older runtimes still run the daemon, but report the
  SQLite session feature as unavailable.
- The admin routes use the existing AdminServer authentication and are not
  exposed through the unauthenticated health endpoint.

## Admin API

List sessions for a project:

```text
GET /admin/api/codex-sessions?projectPath=<absolute-path>
```

Preview a migration:

```json
POST /admin/api/codex-sessions/preview
{
  "projectPath": "E:\\AI\\ChatAI\\Agents\\VibeCodingProjects\\elftia",
  "sessionIds": ["01a00000-0000-7000-8000-000000000001"],
  "fromProvider": "openai",
  "toProvider": "omnicross"
}
```

`fromProvider` may be omitted or blank. Apply uses the same body:

```text
POST /admin/api/codex-sessions/apply
```

The apply operation checks that rollout files did not change while they were
being prepared, stages replacements in the same directory, updates SQLite in
a transaction, and retains timestamped `.provider-switch-*.bak` files beside
each changed JSONL/database file. If the transaction fails, changed JSONL files
are restored from those backups.

The daemon does not return rollout contents or conversation bodies through any
of these endpoints.
