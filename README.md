# Scrima

Scrima is an AI coaching platform that analyzes gameplay and builds a persistent model of a player's skills, habits, and improvement over time.

The project is organized as a pnpm monorepo:

- `packages/client` — Tauri desktop application with a React interface
- `packages/server` — Fastify API, analysis pipeline, and coaching services
- `packages/shared` — shared TypeScript contracts and validation schemas
- `packages/web` — Next.js website and account experience

## Requirements

- Node.js 22 or newer
- pnpm 10 or newer
- Rust toolchain and Tauri prerequisites for desktop development

## Getting started

Install dependencies:

```sh
pnpm install
```

Run the development services:

```sh
pnpm dev
```

Run repository checks:

```sh
pnpm check
pnpm test
pnpm build
```

Environment variables are documented in the example environment files within each package. Never commit real credentials or local environment files.

## Status

Scrima is under active development.
