# TypeScript runtime migration package

This private package is the independent Node 24 candidate runtime under development. Python remains the default. No production entry point selects this package. The `prototype/` wheel experiment remains separate from package behavior.

```bash
cd packages/runtime-ts
npm ci --ignore-scripts
npm run typecheck
npm test
```

Tests use Node's built-in TS execution and test runner. Config parity tests import the normal `@nanobot/runtime` package entry and compare private real config files with the Python reference in a separate process; set `NANOBOT_TEST_PYTHON` to an installed project Python if the repository `.venv/bin/python` is unavailable. No runtime code imports or spawns Python. Only TypeScript and Node typings are development dependencies.

## Configuration

`loadConfig(path?, options?)` returns a `Configuration` with typed camelCase `data`, canonical `sourcePath`, `runtimeDataDir` and expanded `workspacePath`. `options.home` explicitly selects an isolated instance and its default workspace; it never changes process-global home state. `options.env`, `userHome` and `timezone` make isolated applications and tests independent of the host defaults. `resolveConfigEnvVars(config, env?)` returns a separate resolved configuration when references change, preserving the original templates and OAuth fields. `resolveEnvRefs` implements the lenient single-value lookup. `saveConfig(config, path?)` persists aliases, excludes OAuth credentials, retains explicitly supplied/mutated OAuth request settings, and performs a synced temporary write plus atomic rename while preserving an existing file's mode. Save defaults to the configuration's own source path, so two instances cannot overwrite one global selected path.

The complete Python DTO graph's public fields, defaults, alias choices, constraints and serialization exclusions are exported to `src/config/contract.json` and `types.ts`; the decoder and cross-field migrations execute in TypeScript. This avoids reducing configuration to the shared smoke fixture. Legacy API blocks, MyTool/workspace settings, proxy migration, timezone modes, presets/API preferences, provider aliases and retired selectors are handled at the boundary. Nested `NANOBOT_*` settings retain file-over-environment precedence. Unknown DTO fields follow each model's ignore/allow/forbid policy; dynamic channels and custom providers retain their supported data. Config errors distinguish JSON/root/schema/I/O/missing-env failures and retain ordered field locations. Pydantic-specific English error wording is not reproduced.

Regenerate the development-time contract after changing Python configuration models, then review the diff and parity cases:

```bash
uv run --no-sync python -m scripts.export_ts_config_contract
uv run --no-sync python -m scripts.export_ts_config_contract --check
```

Config parsing does not install a process-global SSRF whitelist; execution policy will consume the loaded settings in batch 4. Provider routing helpers, cron schedule construction and gateway settings mutations belong to their later owners. Named-other-user `~name` expansion and native Windows/macOS file-mode/rename behavior are not verified here. The current tests compare representative valid and invalid configurations, including the full default graph, rather than every possible Pydantic coercion combination; new public config behavior should extend the shared parity cases.

## Events, queues and admission

The package exports typed internal `EventMap`/`RuntimeEvent` values, inbound/outbound message types, `MessageBus`, `RuntimeEventPublisher`, `EventSink` and `RuntimeAdmission`. Runtime handle types remain generic so model state stays owned by the later runtime owner. Events are internal trusted values; transport adapters must decode untrusted payloads before publishing. `bus.on(kind, handler)` filters known events (including progress/file-edit and side-channel/command-result subtype relationships); `subscribe` retains catch-all support for the `AgentEvent` union. Known event payloads are checked at publish/sink boundaries; extensions use `extension:<name>` kinds with a typed `payload`, so arbitrary or widened kind strings cannot impersonate known events. `npm run typecheck:events` independently compiles the positive forwarding/extension cases and expected invalid-payload cases.

`publish` awaits local subscribers in registration order, isolates ordinary subscriber failures, and propagates cancellation. Synchronous callbacks do not introduce suspension. `publishNowait` starts on the next microtask and returns a retained task with `promise` and `cancel`; `drain` waits for owned scheduled publications, including follow-up publications started by handlers. Separate publications may interleave, matching Python; there is no global event FIFO. `publishEvent` queues routed output independently of local observers. `consumeInbound` returns a `{ message, release }` claim that registers activity synchronously before removing the message, including before the awaiting caller resumes. Prefer `withInbound(handler, signal?)`, which releases activity after awaited handling or errors. The bus automatically registers queued inbound and scheduled local work with admission; maintenance cannot observe an idle gap between dequeue and dispatch. Paused claims leave the queued item intact. Queued messages retain FIFO order and event identity, and routing metadata is shallow-copied. The outbound compaction text fallback is generated from the existing command catalog; it does not project gateway wire frames.

Node cancellation uses `AbortSignal`: handlers receive the publication's signal and should pass it into asynchronous waits/operations. Queue consumes and admission waits remove cancelled waiters, including a consumer cancelled after wakeup, without losing queued work. A handler that ignores its signal cannot be forcibly interrupted in JavaScript; its scheduled dispatch remains owned until it settles, then rejects cancellation. Drain therefore cannot report idle while that handler is still running. No artificial bus-close operation discards queues: admission pause rejects new inbound work, accepted inbound/output remains consumable, and owners stop producers before draining/disconnecting, as in Python. Drain covers local scheduled dispatch, not network delivery completion or unrelated caller-owned awaited publications.

Admission's synchronous checks, activity count, registered pending-work checks and pause/resume operations prevent an idle-check/intake gap on one event-loop thread. The `withActivity` and `withPausedIfIdle` helpers release their guards after errors and awaited cleanup. These are not cross-process profile ownership locks. The runtime publisher copies turn context and consumes per-session/run latency, runtime identity and ordered usage exactly once on completion. Canonical usage event types and the small reported/sum helpers support these publisher cases; provider normalization/retries remain in batch 2B.

Regenerate/check the outbound fallback after command-catalog changes with `uv run --no-sync python -m scripts.export_ts_bus_contract [--check]`. The shared `test/fixtures/bus-events.json` scenario is consumed by both the Python bus reference test and the Node suite. The Node suite also reuses shared client-event compaction phases while keeping wire projection outside the bus.
