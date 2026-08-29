# @omnicross/core

The omnicross LLM serving core — provider dispatch, the completion pipeline, the transformer chain, the outbound API server, and the resident provider proxy. Embed it in any Node project, or run it via [`@omnicross/daemon`](https://www.npmjs.com/package/@omnicross/daemon).

Part of the [omnicross](https://github.com/Dumoedss/omnicross) monorepo — see the root README for the full overview.

```bash
npm install @omnicross/core @omnicross/contracts
```

The published core runtime remains supported on Node.js `>=20.9`. The monorepo's
official OpenAI JavaScript SDK contract suite is contributor tooling, uses
`openai@7.8.x`, and requires Node.js 22 or newer. Run it from the repository root
with `npm run test:images-sdk-contract`; the command checks the Node major before
loading the SDK. The SDK is intentionally not a runtime or package-local
development dependency of `@omnicross/core`.

## License

[MIT](LICENSE) 

This package adapts third-party work under its own license — see the `NOTICE` file.
