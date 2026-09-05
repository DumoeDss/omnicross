# Codex subscription image adapter

The production adapter supports non-stream `gpt-image-2` generation and one-image edits. Generation uses the Codex Responses upstream; edits use the separate Codex Images Edits upstream. Mask edits, multiple reference images, and public partial-image streaming remain unsupported.

Runtime availability is still fail-closed and account-bound. Adapter declarations, selected-account evidence, and observed-protocol evidence are resolved independently. An explicit live verification performs a minimal generation followed by an edit, then persists only HMAC-scoped account evidence. Text Responses success, a configuration toggle, or a model name alone never upgrades image capability.

Request and response bodies, image Base64, credentials, and raw account identifiers are redacted at the shared proxy-aware egress seam.

See the repository documentation:

- [Image generation development guide](../../../../docs/image-generation-development.md)
- [Image generation usage guide](../../../../docs/image-generation-usage.md)
