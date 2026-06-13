# @omnicross/cli-launcher

omnicross CLI-launcher — the `ProcessSupervisor` subprocess-lifecycle mechanism (dual timeout, scope cancellation, cross-platform kill-tree) plus per-CLI proxy-env wiring for spawning coding-CLI backends.

Part of the [omnicross](https://github.com/Dumoedss/omnicross) monorepo — see the root README for the full overview.

```bash
npm install @omnicross/cli-launcher
```

> **Note**: this package depends on `node-pty` (via the prebuilt
> [`@karinjs/node-pty`](https://www.npmjs.com/package/@karinjs/node-pty) fork),
> a **native** module. Prebuilt binaries cover the common platforms; on a
> platform without a prebuild, installation falls back to compiling from source
> and requires a local C/C++ toolchain (node-gyp).

## License

[MIT](LICENSE) 

This package adapts third-party work under its own license — see the `NOTICE` file.
