# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A learning project (in Spanish) for agentic design patterns, built with TypeScript + the Vercel AI SDK (`ai` package). Each pattern lives under `src/patterns/<pattern-name>/` and demonstrates a "without the pattern" vs. "with the pattern" comparison (e.g. tool use vs. no tool use, planning vs. no planning), printing a token/step usage comparison table at the end via `console.table`.

## Commands

- `npm install` — install dependencies
- `npm run dev` — run `src/main.ts` with `tsx` (loads `.env` automatically via `--env-file=.env`)
- `npm run watch` — same as `dev` but restarts on file changes
- `npm run build` — type-check and compile to `dist/` via `tsc`
- `npm start` — run the compiled output from `dist/main.js` (loads `.env`)

There is no test suite and no linter configured. To exercise a specific pattern, edit `src/main.ts` to import and `await` that pattern's `*Main()` function (only one is typically active at a time; the others are commented out).

## Setup

Copy `.env.template` to `.env` and fill in only the API key for the provider you intend to use (see `src/helpers/selected-model.ts` for how the active model/provider is chosen — currently `openai('gpt-5-mini')`). Supported providers: Groq, Anthropic, OpenAI, Google Gemini, and Ollama (local, via community provider `ollama-ai-provider-v2`).

## Architecture

- **`src/helpers/selected-model.ts`** is the single place that picks the active model/provider — swap the exported `model` here to change what every pattern uses. Comment/uncomment the relevant provider import and `export const model = ...` line.
- **`src/helpers/create-tracer.ts`** provides `createTracer(label)`, used as the `onStepFinish`/`onStepEnd` callback in every `generateText` call. It logs each step's tool calls, tool results, and text to the console, and its `.summary()` returns `{ steps, totalTokens }` for the final comparison table. New patterns should follow this same tracer + summary-table convention.
- **`src/helpers/string-colors.ts`** monkey-patches `String.prototype` with ANSI color getters (`.green`, `.yellow`, `.blue`, `.red`, `.purple`) for console output; imported once for side effects in `main.ts` (`import './helpers/string-colors.js'`).
- **`src/actions/get-message-model.ts`** is a basic connectivity check for whichever provider/model is configured, including a `getMessageFromModelFailSafe` variant with detailed Spanish-language diagnostics for common API errors (401/403/429/404/5xx, `ECONNREFUSED`, `ENOTFOUND`).
- **`src/patterns/<name>/<name>.ts`**: each file is self-contained — it defines its own scenario/data, a "without pattern" function, a "with pattern" function, and an exported `<name>Main()` that runs both and prints the comparison table. Look at `src/patterns/planning/planning.ts` and `src/patterns/tools-use/tool-use.ts` as the reference shape for adding a new pattern.
- Module resolution is Node16/ESM (`"type": "module"` in `package.json`) — all relative imports must use explicit `.js` extensions even though the source is `.ts` (e.g. `import { model } from '../../helpers/index.js'`).
- `src/helpers/index.ts` re-exports everything from the helpers directory; prefer importing from `../../helpers/index.js` rather than reaching into individual helper files.

## AI SDK usage

This project has a bundled skill at `.agents/skills/ai-sdk/SKILL.md` for AI SDK questions. Key points it makes: never write AI SDK code from memory since APIs change frequently across versions — instead read the version-matched docs/source bundled in `node_modules/ai/docs/` and `node_modules/ai/src/` (and `node_modules/@ai-sdk/<name>/docs/` for provider packages) before writing or modifying code that calls the SDK.
