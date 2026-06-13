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

## License

[MIT](LICENSE) 
