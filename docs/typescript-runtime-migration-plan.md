# TypeScript runtime migration plan

This plan implements the [TypeScript runtime design](./typescript-runtime-design.md) in `packages/runtime-ts/` in the existing repository. The Python implementation at `37c2af8ff` is the initial reference for observable behavior. Use the current Python implementation when an intervening change intentionally updates a supported contract. Each batch lists the existing tests to consult and the planned TypeScript tests to add.

Implement in this order **0 → 1 → 2A → 2B → 3 → 4 → 5 → 6**. Batch 5 is the first usable opt-in gateway. Batch 6 is the default-runtime decision. Each batch has a completion gate and can contain several independently testable changes. Land each change with its focused verification and run the full batch checks before starting the next batch.

| Batch | Suggested order within the batch |
| --- | --- |
| 0 | Shared config and wire fixtures → deterministic provider and stored-session fixtures → packaged gateway prototype |
| 1 | Config loading and saving → typed events, delivery, admission and drain |
| 2A | Driver and schema interoperability → history and ordered writes → checkpoints, cancellation and recovery |
| 2B | Chat requests and text streaming → tool calls and usage → timeout, retry and cancellation |
| 3 | Runner with deterministic tools → context assembly and loop → persisted turn and stop behavior |
| 4 | Scoped operations and policy → actual tools backed by the verified operations |
| 5 | Gateway identity and HTTP reads → WebSocket turns, mutations and media → installed WebUI and TUI pilot |
| 6 | Provider and background feature parity → channels, SDK and plugins → ownership handoff and rollback → installed release checks |

## Batch 0 · Establish the behavioral baseline

- Capture representative config, HTTP, WebSocket, and runtime-event inputs and outputs using synthetic data. Reuse [shared client event fixtures](../packages/client-events/fixtures.json) where they cover the case. Add deterministic model responses, tool results and usable database samples for the later batches.
- Make contract fixtures usable from Python and TypeScript. Normalize generated identifiers and timestamps only where the value is incidental. Preserve identity relationships, ordering, presence or omission of fields, error outcomes and durable state.
- Prototype the distribution before choosing the server runtime. Package a minimal TS gateway process and its managed runtime in a representative platform wheel, then launch and stop it through the installed entry point in a private home with Node, Bun and Git absent from `PATH`. Record which runtime and dependencies the wheel supplies and how the launcher finds them.
- **Completion**. The Python runtime passes the shared scenarios. Each scenario states the public observable behavior and identifies its Python reference. The packaging prototype demonstrates that the runtime candidate can satisfy the current install contract. Proposed test in `packages/runtime-ts/test/` is `wire-contract.test.ts`.
- **Reference tests**. [Client contract](../tests/webui/test_client_contract.py) · [Notification contract](../tests/webui/test_notification_contract.py) · [Import boundaries](../tests/architecture/test_import_boundaries.py) · [Native packaging acceptance](../.github/workflows/native-acceptance.yml) · [Clean-install requirements](./releasing.md#non-publishing-preview-preflight)

## Batch 1 · Port configuration, admission and the message bus

- Port config aliases, defaults, environment interpolation, runtime paths and atomic writes. Keep temporary profile state isolated from the user's normal instance.
- Port typed events, queued inbound and outbound delivery, awaited local subscribers, and admission and drain coordination. Establish the TypeScript core and adapter dependency boundary.
- **Completion**. Config round-trips preserve the existing values and unknown or invalid inputs follow the Python baseline for supported paths. Local events and routed deliveries retain their respective ordering even if a handler is slow. Proposed test is `config-bus.test.ts`.
- **Reference tests**. [Config migration](../tests/config/test_config_migration.py) · [Environment interpolation](../tests/config/test_env_interpolation.py) · [Atomic config saves](../tests/config/test_config_atomic_save.py) · [Runtime events](../tests/bus/test_runtime_events.py)

## Batch 2A · Port SQLite and session ownership

- Verify the driver candidate supports SQLite JSON, WAL, transactions, interruption of long reads, and concurrent serving while storage waits for a lock. Port v1–v6 schema migrations, legacy JSONL import for the current release line, and location and permissions checks.
- Port session generations, ordered writes, snapshot reads, pending inputs, and recovery checkpoints. Keep model replay separate from display facts, including history paging, forks, and compaction boundaries.
- **Completion**. Open an existing Python test database, migrate it as needed, write from TS, then reopen and write from Python. Test crash recovery, rejected stale writes, and a cancelled read alongside an accepted write. Proposed tests are `session-sqlite.test.ts` and the storage cases in `legacy-cutover.test.ts`.
- **Reference tests**. [Schema](../tests/session/test_sqlite_schema.py) · [SQLite storage and import](../tests/session/test_sqlite_storage.py) · [Display history](../tests/session/test_display_history.py) · [Recovery](../tests/session/test_recovery.py)

## Batch 2B · Port the first model provider

- Define the provider boundary and port OpenAI-compatible Chat. Include streamed text and tool arguments, normalized usage, cancellation, idle timeout, and retry classification.
- Exercise success and failure with a local HTTP stub and recorded synthetic chunks. Cover stream closure, partial output and the final completion condition.
- **Completion**. The same fixtures produce equivalent public stream events, tool calls, usage and error outcomes in Python and TS. Proposed test is `provider-openai.test.ts`.
- **Reference tests**. [OpenAI-compatible behavior](../tests/providers/test_openai_compat_spec.py) · [Streaming and cancellation](../tests/providers/test_internal_streaming.py) · [Tool arguments](../tests/providers/test_provider_tool_arguments.py) · [Usage](../tests/providers/test_usage_contract.py)

## Batch 3 · Port AgentRunner and AgentLoop

- Implement the runner first. Feed tool results back into the model, enforce iteration and context budgets, and publish progress and completion. Use deterministic tools while validating state transitions.
- Wire the loop to the bus, session store and provider. Cover per-session work selection, follow-up input, `/stop`, concurrent sessions, and durable delivery.
- Port `ContextBuilder` with the loop. Capture the actual model request before the first response and again after a restart. Compare project `AGENTS.md`, agent and project workspace selection, bootstrap instructions, existing memory, enabled skills, and replayed history with the Python reference. Include a temporary chat case and verify its memory exclusion.
- **Completion**. The captured model requests match the reference for first and resumed turns. Run a complete model → tool → model turn and recover it through persisted history. Verify that stopping a turn preserves the supported follow-up behavior, accepted writes settle under cancellation, and a reset rejects late activity from the previous session generation. Proposed tests are `agent-runner.test.ts` and `agent-loop.test.ts`.
- **Reference tests**. [Runner core](../tests/agent/test_runner_core.py) · [Tool execution](../tests/agent/test_runner_tool_execution.py) · [Loop integration](../tests/agent/test_loop_runner_integration.py) · [Context assembly](../tests/agent/test_context_builder.py) · [Workspace scope](../tests/agent/test_workspace_scope.py) · [History replay](../tests/agent/test_history_replay.py) · [Cancellation](../tests/agent/test_task_cancel.py) · [Turn delivery](../tests/agent/test_turn_delivery.py) · [Pending input on stop](../tests/command/test_stop_pending_queue.py)

## Batch 4 · Port execution policy and tools

- Port scoped filesystem operations, outbound HTTP policy, and subprocess lifetime and sandbox behavior. Validate these boundaries before enabling real file operations, Shell, HTTP or MCP in the pilot.
- Bring the tools online in that order as their supporting operations pass. Preserve tool schema validation, cancellation, resource cleanup, and the existing platform behavior.
- **Completion**. Supported operations and permission denials match Python within the same workspace policy. Run real process and sandbox checks on the applicable platforms before the pilot enables those capabilities. Proposed test is `execution-policy.test.ts`.
- **Reference tests**. [Workspace policy](../tests/security/test_workspace_policy.py) · [Network policy](../tests/security/test_security_network.py) · [Sandbox and shell](../tests/tools/test_sandbox_shell_boundary.py) · [Process cleanup](../tests/tools/test_shell_reap.py) · [MCP schemas](../tests/tools/test_mcp_schema_integration.py)

## Batch 5 · Integrate the gateway and run an opt-in pilot

- Compose the TS gateway and turn the shipped client's calls into a route and event checklist for `webui.core.v1`. Cover authenticated bootstrap and reads, session and settings mutations, chat and delivery events, and attachment and media operations. Record any deferred behavior under a named optional capability and verify its controls and requests are gated. Keep the terminal identity handshake independently testable.
- Run the same black-box checks against separately launched Python and TS gateways and connect the shipped WebUI and TUI. Use an isolated instance and local model fixture. Verify unauthorized requests are denied, authorized session changes persist, attachment uploads and downloads stay in scope, and restart and reconnect revalidate credentials and host identity. Include a remote-host scenario where the client serves executable assets from its local installation.
- **Completion**. The checklist covers every required core interface, both same-release clients pass against the real TS gateway, and two clients observing one turn produce one execution. Demonstrate event delivery and history recovery after reconnect. The TS gateway can be explicitly selected for a pilot whose resolved writable roots are verified to be disjoint from the source instance. Proposed test is `gateway-smoke.test.ts`.
- **Reference tests**. [Real gateway smoke](../tests/webui/test_gateway_webui_smoke.py) · [WebSocket integration](../nanobot/channels/websocket/tests/test_websocket_integration.py) · [HTTP routes and authorization](../nanobot/channels/websocket/tests/test_websocket_http_routes.py) · [Attachment ingress](../nanobot/channels/websocket/tests/test_attachment_ingress.py) · [Remote proxy](../tests/webui/test_remote_proxy.py) · [WebUI client](../webui/src/tests/nanobot-client.test.ts) · [TUI client](../tui/src/client/client.test.ts)

## Batch 6 · Complete supported features and decide the default switch

- Port the remaining supported model adapters and OAuth paths, Dream, schedules, local triggers, subagents, and external channels used by the default distribution. Verify the supported feature matrix on TS. Keep SDK hook compatibility covered separately from Python tool plugins.
- Verify that CLI, service and updater launches honor explicit Python selection for plugin-dependent instances. Run discovery and invoke a representative `nanobot.tools` entry point through the selected gateway, including an error result. If a plugin-dependent instance is selected for TS, report the required Python selection before cutover.
- Exercise install, service, update, asset and shutdown paths with the shipped runtime on the release matrix. Launch from installed wheels with Node, Bun and Git absent from `PATH`. Record startup, streaming and storage contention results from the pilot.
- Implement the shared ownership and handoff protocol. Use separate processes to try Python and TS starts on the same profile and on overlapping store roots. Verify that another gateway, service, or write-capable SDK entry point cannot initialize those stores during the protected handoff or write while the other engine owns them. Stop the handoff coordinator before activation and verify that the same job can resume or roll back with its reservation intact. Rehearse both directions, including data created after TS takes ownership. Document the commands for inspecting the recorded owner and phase, resuming a handoff, and rolling it back.
- **Completion**. The supported feature, installed-package, SDK and plugin cases pass. The handoff permits only the verified runtime to write, and rollback is tested for all persisted formats used by the release. Extend `legacy-cutover.test.ts` to cover ownership contention, interrupted handoff, and rollback before switching the default entry point.
- **Reference tests**. [Codex WebSocket](../tests/providers/test_openai_codex_websocket.py) · [Dream](../tests/agent/test_dream_run.py) · [Subagents](../tests/agent/test_subagent_lifecycle.py) · [Cron](../tests/cron/test_cron_service.py) · [Triggers](../tests/triggers/test_local_triggers.py) · [Channel contracts](../tests/channels/test_channel_contracts.py) · [SDK facade](../tests/test_nanobot_facade.py) · [Python tool entry points](../tests/agent/test_tool_loader_entrypoints.py) · [Gateway service](../tests/gateway/test_gateway_service.py) · [Windows shutdown](../tests/gateway/test_windows_shutdown.py) · [Release packaging](../tests/cli/test_tui_release_packaging.py) · [Data access](../tests/test_data_access.py) · [Profile ownership](../tests/test_update_profiles.py) · [Update restart](../tests/test_update_restart.py)

## Baseline verification

The planning checks at `37c2af8ff` passed 404 Python cases across the configuration, event, storage, provider, runner, cancellation and client contract suites. A separate run passed two real Python gateway smoke scenarios covering bootstrap, history hydration and restart recovery. These runs establish reference behavior. TypeScript verification begins when the corresponding batch adds its implementation and tests.

From the repository root, run the reference tests for a batch with `uv run --no-sync python -m pytest -q` followed by their paths. The two real gateway scenarios can be selected with the following command.

```bash
uv run --no-sync python -m pytest -q tests/webui/test_gateway_webui_smoke.py \
  -k 'bootstrap_message_and_thread_hydration or restart_restores_a_completed_answer'
```

## Batch 0 evidence and review gate

Batch 0 now has shared config and gateway scenarios, deterministic OpenAI-compatible tool argument chunks and expected normalized results, and a stored-session record with fixed timestamps. [Fixture index](../packages/runtime-ts/test/fixtures/README.md) maps each scenario to its Python reference and describes constructing a v1 database using the existing SQL fixture. Existing client-event fixtures remain the source for runtime and wire event examples.

The isolated [managed Node wheel prototype](../packages/runtime-ts/prototype/README.md) passed installed-entry HTTP startup and graceful SIGTERM/SIGINT shutdown on Linux x86_64 with Node 24.22.3 supplied by the wheel, a private unchanged home, and an empty-directory PATH. The Node binary and all generated wheel/venv artifacts remain outside tracked source. The experiment does not establish the other release platforms or SQLite driver gates.

Verification on this batch: the focused Python config, client/notification/import contracts, OpenAI-compatible provider, SQLite schema and storage suites passed 369 cases; the two selected real gateway bootstrap/history and restart scenarios passed. Ruff passed for the touched Python files. The wheel probe passed both signal cases, including under Python `-O`, with the pinned official Node archive and its same-archive LICENSE. First-round review corrections also enforce exactly one provider tool call and preserve session timestamps/generation across migration, save and reopen. Stop here for independent batch review; batch 1 may start only after explicit approval.

## Batch 1 evidence and review gate

Batch 1 adds the private `@nanobot/runtime` Node package with a normal exported entry point, native TS tests, a pinned development lockfile and strict type checking. Configuration covers the exported complete Python DTO graph rather than a fixture-only subset: aliases/defaults, source precedence, legacy migrations, templates and missing references, canonical instance paths, error locations, OAuth serialization exclusions and atomic saves are exercised against private real files and the Python oracle. [Package README](../packages/runtime-ts/README.md) describes API ownership, regeneration checks and unverified boundaries.

The event batch separates ordered awaited local subscribers from independent routed inbound/output FIFOs, retains scheduled publications until settled, and ports typed runtime contexts, completion metadata, event sinks and maintenance admission. The shared slow-subscriber scenario is consumed by Python and TS; Node tests additionally cover cancellation before/after queue wakeup, retained non-cooperative callbacks, nested publications during drain, per-run completion consumption, subtype filtering, and synchronous busy/pause behavior. AbortSignal cancellation is cooperative; a callback that ignores cancellation remains owned until it settles. Admission is process-local and does not implement the later profile handoff lock.

The independently verified implementation commits are `1fa3568e7` (configuration), `26785a039` (events/admission) and `2c0334be4` (whole-config missing-env validation before expansion). Clean `npm ci --ignore-scripts --no-audit --no-fund` and strict `npm run typecheck` passed. Final package tests passed 51 cases (34 config, including 28 Python parity scenarios, plus 17 bus cases); the four planned Python config/runtime-event reference suites passed 40 cases. Both generated-contract `--check` commands, Ruff for the affected Python files and `git diff --check` passed. No production runtime selection, user profile or wheel resources changed in this batch. Stop here for independent review; batch 2A may start only after explicit approval.

### Batch 1 first-review corrections

The normal inbound consume entry now returns an activity claim established synchronously with dequeue, and `withInbound` releases that claim after handling or errors. Queued/scheduled bus work is automatically visible to admission. Known event kinds form a complete payload union; extension kinds use a separate namespace, and independent compile-negative tests cover incomplete events, wrong payload types, kind widening and invalid extensions while retaining typed forwarding.

Configuration reads preserve the operating system's symlink-before-parent traversal order, including a dangling source's canonical owner and default save target. Exported environment-root names follow Pydantic's explicit-alias behavior; template lookups require own environment keys. Proxy migration uses Python credential quoting, and raw authority/path validation rejects URLs that WHATWG parsing would repair. Real-file Python oracle scenarios cover each reported configuration difference and default-save location.

The corrective implementation commits are `f62ec5c2e` (claims and event types) and `9084c3cd2` (config paths, environment and proxy parity); `4194aec43` strengthens selected-home comparison against fresh Python defaults. The package suite passed 62 cases (44 config and 18 bus), and the final focused source/home tests passed 2 cases after that assertion was strengthened. Both strict typecheck commands, both generated-contract checks, Ruff and diff checks passed. The selected Python config/bus/maintenance reference suites passed 121 cases. The package's documented platform and cooperative-cancellation limits still apply. Stop for the second independent review; batch 2A remains blocked until explicit approval.

### Batch 1 second-review result and deferred issues

The second review of `328ee6ec4` did not pass. The user explicitly agreed to defer the two findings below and deliver the branch as development work. The earlier passing checks do not establish batch 1 acceptance; implementation fixes and batch 2A remain paused. This record does not initiate a third review.

| Priority | Trigger and impact | Follow-up acceptance |
| --- | --- | --- |
| P1 | An explicit home is `instance/missing/..`, where `instance/config.json` already exists and `missing` does not. TS opens the unnormalized home path, receives ENOENT and loads defaults; canonical source binding then points at the existing config, so `saveConfig` can overwrite it. Python normalizes the selected home before opening its config. Explicit config-path symlink/parent traversal must retain its separate Python open semantics. | Use temporary real files and the [Python config oracle](../packages/runtime-ts/test/config-reference.py) to compare explicit-home loading, source identity and save results; verify the existing config is preserved and extend the existing explicit-path symlink/parent cases. |
| P2 | A root environment variable named `modelPresets` or `model_presets` contains a valid complete JSON object. Python accepts it, while TS reports `invalid_schema`. Nested environment forms were fixed, but root JSON values remain unsupported. | Add real temporary config-file cases to the [Node config parity suite](../packages/runtime-ts/test/config.test.ts), comparing both aliases' complete JSON roots and file precedence with the Python oracle; retain nested-form coverage. |

## Batch 2A evidence and review gate

After the user authorized continuing with the recorded batch 1 findings deferred, batch 2A was implemented from `7e5d97ed0` through `7e31c8141`. The independent increments are `55d2fa256` (interruptible SQLite driver and Python schema interoperability), `1de95401b` (ordered session state and display history), `39b443925` (namespace identity and native file primitives), `2869e7978` (atomic legacy JSONL import), `2d596b7bd` (checkpoints and interrupted-work recovery), and `7e31c8141` (Python JSON equality during draft merging). Each increment was committed and ordinarily pushed after its focused verification.

The asynchronous `sqlite3` driver passed a real long-read interruption alongside an accepted write, and an external SQLite write lock left Node timers, readers and an HTTP response responsive. Accepted writes settle before cancellation is reported. The exported Python v1–v6 migrations and shared stored-session fixture passed Python write → TS migrate/read/write → Python reopen/write → TS read. Ordered drafts reject stale generations, preserve independent metadata changes and compaction boundaries, and keep display facts separate from model messages. Shared history and checkpoint scenarios execute against real Python oracles; a SIGKILL after checkpoint commit recovers only durable work. Recovery candidate selection, pending follow-up acknowledgement and restoration are storage operations; automatic execution and gateway delivery belong to later loop and adapter stages.

The namespace and legacy-import checks use isolated temporary paths, actual Python/Node file-lock contention, exact nanosecond timestamps, private durable backups and resumable source cleanup. The JSONL increment passed 6 Node import cases plus 5 driver cases and 55 Python storage/location cases before its commit. Duplicate JSON keys, conflicting sources, changed cleanup sources, interrupted imports and checkpoint eligibility are covered. The completed import marker prevents an old source from being imported again.

Final verification: clean `npm --prefix packages/runtime-ts ci --no-audit --no-fund` built the native addon successfully; `npm --prefix packages/runtime-ts test` passed 99 cases. Both strict TypeScript checks and all three generated-contract/schema `--check` commands passed. The Python recovery, display-history, SQLite-schema, SQLite-storage and session-location suites passed 121 cases. Ruff passed for the exporters and Python test oracles, and local documentation links and `git diff --check` passed. [Package README](../packages/runtime-ts/README.md) and [fixture index](../packages/runtime-ts/test/fixtures/README.md) describe the executable APIs and scenarios.

These measurements establish Linux x86_64 behavior with Node 24.22.3. Native lock/timestamp branches on other platforms and installed-wheel distribution of the native addons remain release gates; source installation currently needs the native build toolchain. Model request assembly, graph transport expansion, full runtime ownership handoff and production runtime selection remain later work. The two deferred batch 1 configuration findings and upstream event-contract additions were not changed. Stop here for independent batch 2A review; batch 2B may start only after the coordinator's explicit handoff.
