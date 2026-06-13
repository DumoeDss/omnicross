/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DAEMON_BASE_URL?: string;
  readonly VITE_DAEMON_ADMIN_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
