# omnicross

<div align="center">

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/) [![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/) [![npm: @omnicross/core](https://img.shields.io/badge/npm-%40omnicross%2Fcore-cb3837.svg?logo=npm)](https://www.npmjs.com/package/@omnicross/core)

[English](../README.md) · [简体中文](README.zh.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Italiano](README.it.md) · [Español (España)](README.es-ES.md) · **Español (Latinoamérica)** · [Português (Brasil)](README.pt-BR.md) · [Português (Portugal)](README.pt-PT.md) · [Nederlands](README.nl.md) · [Dansk](README.da.md) · [Svenska](README.sv.md) · [Norsk bokmål](README.nb.md) · [Suomi](README.fi.md) · [Polski](README.pl.md) · [Čeština](README.cs.md) · [Magyar](README.hu.md) · [Română](README.ro.md) · [Български](README.bg.md) · [Русский](README.ru.md) · [Українська](README.uk.md) · [Ελληνικά](README.el.md) · [Türkçe](README.tr.md) · [العربية](README.ar.md) · [ไทย](README.th.md) · [Tiếng Việt](README.vi.md) · [Bahasa Indonesia](README.id.md) · [Bahasa Melayu](README.ms.md)

**Un núcleo de servicio LLM universal — enruta, transforma y hace proxy de cualquier proveedor detrás de un solo conjunto de APIs.**

</div>

---

`omnicross` recibe una solicitud LLM entrante — OpenAI `/v1/chat/completions`, Anthropic `/v1/messages`, Gemini y más — determina **qué proveedor, cuenta y clave** debe responderla (tus propias claves de API, un pool de múltiples claves, o una identidad OAuth de suscripción), la procesa a través de una cadena de transformación + autenticación, y la envía al upstream mediante proxy — recodificando la respuesta de vuelta al formato de wire que el llamador solicitó.

Se entrega de varias formas:

- **🖥️ Como aplicación de escritorio** — una ventana nativa de Tauri v2 (`apps/desktop`) que presenta la GUI completa del Panel de Control y empaqueta y gestiona el daemon por ti (bandeja del sistema, inicio automático, ciclo de vida del daemon). **La forma principal en que la mayoría de las personas usan omnicross** — sin terminal, sin npm, sin configuración de CORS.
- **🌐 En tu navegador** — ¿prefieres no instalar una app nativa? `omnicross ui` inicia el daemon y abre la misma GUI en tu navegador (servida por el propio daemon en `/ui` — mismo origen, sin configuración adicional) para gestionar proveedores, claves, cuentas y lanzamientos de Code CLI.
- **🚀 Como daemon headless** — el CLI/daemon `omnicross`: un proceso Node puro con una API HTTP local, un panel de administración y comandos para claves, proveedores, inicio de sesión OAuth y lanzamiento de Code CLIs. Perfecto para servidores y flujos de trabajo orientados a la terminal; también es lo que impulsa la app de escritorio y el Panel de Control en el navegador.
- **📦 Como librería** — `npm install @omnicross/core` e integra el núcleo de servicio directamente dentro de cualquier proyecto Node.

El núcleo de servicio en sí es Node puro — sin Electron, sin dependencia de ningún framework; la UI es una app web simple, y la capa de escritorio es una delgada capa Tauri sobre ella.

## 🏗️ Arquitectura

Una solicitud entrante llega a través de un **ingress** (el proxy residente en proceso, o el servidor de API saliente independiente), se resuelve a un **proveedor + identidad**, es convertida por la **cadena de transformadores** y se envía al **upstream** mediante proxy — luego la respuesta fluye de regreso a través de la misma cadena, recodificada al formato de wire del llamador.

```mermaid
flowchart LR
    subgraph clients["Callers"]
        APP["Your app / SDK<br/>(OpenAI · Anthropic · Gemini wire format)"]
        CLI["Code CLI<br/>(claude · codex · gemini · qwen · …)"]
    end

    subgraph omnicross["omnicross"]
        direction TB
        ING["Ingress<br/>resident proxy · outbound-API server"]
        RES["Resolve<br/>provider · account · key"]
        AUTH["Auth<br/>BYO key · key-pool · subscription OAuth"]
        TX["Transformer chain<br/>request ↔ response re-encode"]
    end

    UP["Upstream provider<br/>OpenAI · Anthropic · Gemini · OpenRouter · …"]

    APP -->|"/v1/chat/completions<br/>/v1/messages · /v1/responses"| ING
    CLI -->|launched against the proxy| ING
    ING --> RES --> AUTH --> TX --> UP
    UP -.->|streamed response, re-encoded| APP

    GUI["Control Panel<br/>(browser /ui · Tauri desktop)"] -.->|admin HTTP API| omnicross
```

| Componente | Ubicación |
| --- | --- |
| Frontend del Panel de Control (Vite + React) | `@omnicross/ui` (`packages/ui` — publica solo su `dist/` compilado) |
| Capa de escritorio (Tauri v2) | `apps/desktop` |
| Runtime independiente (API HTTP · panel · CLI · sirve la UI en `/ui`) | `@omnicross/daemon` |
| Ingress · dispatch · transformador · proxy | `@omnicross/core` |
| OAuth de suscripción + estrategias de autenticación | `@omnicross/subscriptions` |
| Tipos de contrato compartidos + presets de proveedores | `@omnicross/contracts` |
| Lanzamiento de Code CLI (proxy-env + supervisor) | `@omnicross/cli-launcher` |

## ✨ Características

- **GUI del Panel de Control** — una UI de React sobre la API de administración localhost del daemon: gestiona proveedores, claves y cuentas de suscripción visualmente en lugar de mediante archivos de configuración. Se entrega como una app de escritorio nativa Tauri v2 (la forma habitual de acceder — bandeja del sistema, inicio automático, daemon integrado, sin Electron), o servida en tu navegador con un comando (`omnicross ui`).
- **Formato de wire cualquiera a cualquiera** — acepta solicitudes con formato OpenAI / Anthropic / Gemini y las dirige a un proveedor que habla un formato *diferente*; la cadena de transformadores convierte tanto la solicitud como la respuesta en streaming.
- **Claves propias + pools de múltiples claves** — vincula tus propias claves de proveedor, o agrupa muchas claves por proveedor con round-robin ponderado y failover automático en `429 / 529 / 401 / 403`.
- **Suscripción como proveedor** — dirige solicitudes a través de una suscripción de Claude / ChatGPT (Codex) / Gemini mediante OAuth, o una clave bearer de OpenCodeGo, en lugar de una clave de API medida.
- **Presets de proveedores** — un catálogo curado de endpoints/plantillas de proveedores (OpenAI, Anthropic, Gemini, DeepSeek, OpenRouter, Groq, Mistral, y muchos más) que puedes mapear a una entrada de configuración con un solo comando.
- **Proxy nativo de streaming** — un proxy residente en proceso retransmite streams SSE verbatim cuando los formatos coinciden, y los recodifica cuando no.
- **Lanzador de Code CLI** — inicia `claude` / `codex` / `gemini` / `qwen` / `copilot` / `opencode` contra un proxy local para que una sesión de CLI pueda ejecutarse en **cualquier** proveedor o suscripción que hayas configurado.
- **Agnóstico al host y tipado** — Node puro + TypeScript, tipos de contrato con dependencias mínimas publicados por separado, sin acoplamiento a ninguna app host.

## 📦 Estructura

Este es un monorepo de workspace único: paquetes publicables en `packages/`, apps ejecutables en `apps/`. Los nombres de paquetes npm conservan el scope `@omnicross/`; los nombres de directorio eliminan el prefijo `omnicross-`.

| App | Qué es |
| --- | --- |
| `apps/desktop` | **omnicross-desktop** — la app de escritorio nativa Tauri v2: envuelve el frontend `@omnicross/ui` como una ventana nativa y empaqueta y gestiona el daemon (bandeja del sistema, inicio automático, ciclo de vida del daemon). Ver [`apps/desktop/README.md`](../apps/desktop/README.md). |

Los paquetes publicados:

| Paquete | npm | Qué es |
| --- | --- | --- |
| `packages/contracts` | [`@omnicross/contracts`](https://www.npmjs.com/package/@omnicross/contracts) | Tipos de contrato con dependencias mínimas + helpers de valores en tiempo de ejecución (configuración LLM, tipos completion/chat, presets de proveedores, configuración de thinking, uso, tipos de token de suscripción/cuenta). Se consume mediante subpaths (`@omnicross/contracts/llm-config`, `/provider-presets`, …). |
| `packages/core` | [`@omnicross/core`](https://www.npmjs.com/package/@omnicross/core) | El núcleo de servicio — dispatch de proveedores, pipeline de completion, transformadores, el proxy de proveedores y la superficie de API saliente. |
| `packages/subscriptions` | [`@omnicross/subscriptions`](https://www.npmjs.com/package/@omnicross/subscriptions) | Estrategias de autenticación de suscripción como proveedor, flujos OAuth (Claude / Codex / Gemini), y el dispatcher de escenarios OpenCodeGo. |
| `packages/cli-launcher` | [`@omnicross/cli-launcher`](https://www.npmjs.com/package/@omnicross/cli-launcher) | El mecanismo de ciclo de vida de subprocesos `ProcessSupervisor` + constructores de configuración de lanzamiento proxy-env por CLI. |
| `packages/daemon` | [`@omnicross/daemon`](https://www.npmjs.com/package/@omnicross/daemon) | Un embebedor Node puro de `@omnicross/core` con una API HTTP de administración + panel, el CLI `omnicross`, y servicio del Panel de Control en `/ui` en el mismo origen. |
| `packages/ui` | [`@omnicross/ui`](https://www.npmjs.com/package/@omnicross/ui) | El frontend del Panel de Control (Vite + React). Publica solo su `dist/` compilado (assets estáticos, cero dependencias en tiempo de ejecución); el daemon lo sirve en `/ui`, la capa Tauri lo envuelve. |

## 🚀 Inicio rápido

### Opción A — App de escritorio (recomendada para la mayoría de los usuarios)

Descarga el instalador para tu sistema operativo desde el [último release](https://github.com/Dumoedss/omnicross/releases/latest) y ejecútalo:

- **Windows** — `*-setup.exe` (NSIS) o `*.msi`
- **macOS** — `*.dmg` (universal — Apple Silicon + Intel)
- **Linux** — `*.AppImage`, `*.deb` o `*.rpm`

La app empaqueta y gestiona todo por ti — el daemon **y** un runtime privado de Node — así que no hay nada más que instalar. Solo descarga, ejecuta el instalador y ábrela.

> ¿Quieres compilarla tú mismo? Ver [`apps/desktop/README.md`](../apps/desktop/README.md) (`npm run build:app`, requiere Rust).

### Opción B — Panel de Control en tu navegador

¿Prefieres no instalar una app? Un comando — el daemon sirve la misma UI él mismo (mismo origen que su API de administración — sin CORS, sin `.env`):

```bash
npm install -g @omnicross/daemon
omnicross ui --config ./omnicross.config.json   # boots the daemon + opens http://127.0.0.1:8766/ui/
```

Agrega `--no-open` para omitir el lanzamiento del navegador. Los flujos de trabajo de desarrollo del frontend están en [`packages/ui/README.md`](../packages/ui/README.md).

### Opción C — daemon headless

Todo lo que hace la app — y más — está disponible desde la terminal:

```bash
npm install -g @omnicross/daemon
```

```bash
# Boot the daemon (BYO-key serving) against a config file
omnicross start --config ./omnicross.config.json

# Map a curated provider preset + your key into the config
omnicross providers presets --config ./omnicross.config.json
omnicross providers add openai --key $OPENAI_API_KEY --config ./omnicross.config.json

# Mint a local API key for your clients (shown once)
omnicross keys add my-app --config ./omnicross.config.json

# Log in to a subscription via browser OAuth (claude | codex | gemini)
omnicross login claude --config ./omnicross.config.json

# Launch a Code CLI against the in-process proxy on any configured provider
omnicross launch claude --provider openai --model gpt-4o --config ./omnicross.config.json
```

Ejecuta `omnicross --help` para la lista completa de comandos.

### Opción D — como librería

```bash
npm install @omnicross/core @omnicross/contracts
```

```ts
import type { LLMProvider } from '@omnicross/contracts/llm-config';
// import the serving-core pieces you need from @omnicross/core

// Wire the serving core into your own Node app: supply a provider-config
// source + key store, then route inbound requests through the proxy.
```

> Las importaciones por subpath mantienen el grafo de dependencias ajustado, p. ej.
> `@omnicross/contracts/provider-presets`, `@omnicross/core/provider-proxy`.

## 🛠️ Desarrollo

```bash
git clone https://github.com/Dumoedss/omnicross.git
cd omnicross
npm install          # workspace symlinks for @omnicross/* + external deps
npm run typecheck    # tsc --noEmit per package
npm test             # vitest (tests run against src via aliases)
npm run build        # tsup per package → dist/ (ESM + CJS + .d.ts)
```

Las pruebas y las verificaciones de tipos resuelven las importaciones de `@omnicross/*` al **código fuente** del paquete mediante aliases, por lo que no se necesita una compilación previa. `npm run build` emite el `dist/` de cada paquete para publicación.

Para el desarrollo del Panel de Control, `npm run dev` (raíz del repositorio) es el bucle de un solo comando: genera un `omnicross.dev.config.json` ignorado por git en la primera ejecución, inicia el daemon en `127.0.0.1:8766`, e inicia el servidor de desarrollo Vite de la UI en `http://localhost:1430` (Ctrl+C detiene ambos). El servidor de desarrollo hace proxy de `/admin/*` al servidor del daemon, de modo que el navegador permanece en el mismo origen — el daemon no envía encabezados CORS por diseño. El frontend en sí es el paquete workspace `@omnicross/ui` — `npm run build -w @omnicross/ui` refresca el `dist/` servido por el daemon. Para la ventana nativa (requiere Rust): `npm run dev:app` ejecuta `tauri dev`, y `npm run build:app` empaqueta el ejecutable de release + instaladores con el runtime del daemon **y un binario privado de Node** integrado (la salida está en `apps/desktop/src-tauri/target/release/`; las máquinas de destino no necesitan nada instalado — detalles en [`apps/desktop/README.md`](../apps/desktop/README.md)).

## 📄 Licencia

[MIT](../LICENSE) 

Partes de `@omnicross/core` y otros paquetes adaptan trabajo de terceros bajo sus propias licencias — consulta los archivos `NOTICE` en los paquetes correspondientes.
