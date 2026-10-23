# @omnicross/daemon

The omnicross standalone daemon — a bare-Node embedder of `@omnicross/core` with an admin HTTP API + dashboard. Ships the `omnicross` CLI for managing keys, providers, subscription OAuth login, and launching Code CLIs against an in-process proxy.

Part of the [omnicross](https://github.com/Dumoedss/omnicross) monorepo — see the root README for the full overview.

```bash
npm install -g @omnicross/daemon
omnicross --help
```

```bash
# Boot the daemon (BYO-key serving)
omnicross start --config ./omnicross.config.json
```

## Lifecycle regression checks

From the repository root, using Node.js 22:

```bash
npm test -- packages/daemon/src/__tests__/route-lease-terminal-lifecycle.test.ts --maxWorkers=2 --testTimeout=30000 --hookTimeout=30000
```

Terminal natural-exit checks prepare and import the real child module before
starting the listener-lifetime measurement. Preparation uses the runner's normal
hook deadline; execution retains its 10-second watchdog and 15-second test timeout.
The peer-claim deadline starts when the pipe is listening, so writing launch
artifacts cannot consume the connection's claim budget.
The one-shot stdin handoff is closed before execution so the harness cannot keep
the child alive. Neither listener case uses `process.exit()` to force success;
failure and cancellation kill the actual Node process and await its closure.

Only the tested child sets `NODE_DISABLE_COMPILE_CACHE=1`: Node's optional
compile-cache flush can delay OS process exit after JavaScript has already
finished, even with no live listener or socket. The parent keeps its own cache
configuration. These checks measure natural listener/socket teardown, not cache
persistence; timeout diagnostics distinguish process exit from stdio closure.

## License

[MIT](LICENSE) 
