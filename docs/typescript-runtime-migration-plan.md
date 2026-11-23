# TypeScript runtime migration plan

This plan implements the [TypeScript runtime design](./typescript-runtime-design.md) in `packages/runtime-ts/` in the existing repository. The Python implementation at `37c2af8ff` is the initial reference for observable behavior. Use the current Python implementation when an intervening change intentionally updates a supported contract. Each batch lists the existing tests to consult and the planned TypeScript tests to add.

The dependency order is **0 → 1 → 2A and 2B in parallel → 3 → 5 → 6**. Batch 4 can start after batch 1 and run alongside storage, model, and agent work. Both batches 3 and 4 must pass before batch 5 exposes the pilot. Batch 5 is the first usable opt-in gateway. Batch 6 is the default-runtime decision.

## Batch 0 · Establish the behavioral baseline

- Capture representative config, HTTP, WebSocket, and runtime-event inputs and outputs using synthetic data. Reuse [shared client event fixtures](../packages/client-events/fixtures.json) where they cover the case. Add deterministic model responses, tool results and usable database samples for the later batches.
- Make contract fixtures usable from Python and TypeScript. Normalize generated identifiers and timestamps only where the value is incidental. Preserve identity relationships, ordering, presence or omission of fields, error outcomes and durable state.
- **Completion**. The Python runtime passes the shared scenarios. Each scenario states the public observable behavior and identifies its Python reference. Proposed test in `packages/runtime-ts/test/` is `wire-contract.test.ts`.
- **Reference tests**. [Client contract](../tests/webui/test_client_contract.py) · [Notification contract](../tests/webui/test_notification_contract.py) · [Import boundaries](../tests/architecture/test_import_boundaries.py)

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
- **Completion**. Run a complete model → tool → model turn and recover it through persisted history. Verify that stopping a turn preserves the supported follow-up behavior, accepted writes settle under cancellation, and a reset rejects late activity from the previous session generation. Proposed tests are `agent-runner.test.ts` and `agent-loop.test.ts`.
- **Reference tests**. [Runner core](../tests/agent/test_runner_core.py) · [Tool execution](../tests/agent/test_runner_tool_execution.py) · [Loop integration](../tests/agent/test_loop_runner_integration.py) · [Cancellation](../tests/agent/test_task_cancel.py) · [Turn delivery](../tests/agent/test_turn_delivery.py) · [Pending input on stop](../tests/command/test_stop_pending_queue.py)

## Batch 4 · Port execution policy and tools

- Port scoped filesystem operations, outbound HTTP policy, and subprocess lifetime and sandbox behavior. Validate these boundaries before enabling real file operations, Shell, HTTP or MCP in the pilot.
- Bring the tools online in that order as their supporting operations pass. Preserve tool schema validation, cancellation, resource cleanup, and the existing platform behavior.
- **Completion**. Supported operations and permission denials match Python within the same workspace policy. Run real process and sandbox checks on the applicable platforms before the pilot enables those capabilities. Proposed test is `execution-policy.test.ts`.
- **Reference tests**. [Workspace policy](../tests/security/test_workspace_policy.py) · [Network policy](../tests/security/test_security_network.py) · [Sandbox and shell](../tests/tools/test_sandbox_shell_boundary.py) · [Process cleanup](../tests/tools/test_shell_reap.py) · [MCP schemas](../tests/tools/test_mcp_schema_integration.py)

## Batch 5 · Integrate the gateway and run an opt-in pilot

- Compose the TypeScript gateway, then implement the supported HTTP and WebSocket routes and events. Preserve startup identity, auth, history loading, attachment authorization, ordered delivery, stop and reconnect. Use the existing WebUI capability and terminal handshake contracts.
- Run the same black-box checks against separately launched Python and TypeScript gateways. Use a temporary instance and local model fixture, connect the shipped WebUI and TUI, and verify that two clients observing the same turn still produce one execution. Check restart recovery and event delivery after reconnection.
- **Completion**. Both clients pass the same-release end-to-end checks against a real TS gateway. The supported pilot capabilities are documented and the TS gateway can be explicitly selected for an isolated instance. Proposed test is `gateway-smoke.test.ts`.
- **Reference tests**. [Real gateway smoke](../tests/webui/test_gateway_webui_smoke.py) · [WebSocket integration](../nanobot/channels/websocket/tests/test_websocket_integration.py) · [WebUI client](../webui/src/tests/nanobot-client.test.ts) · [TUI client](../tui/src/client/client.test.ts)

## Batch 6 · Complete supported features and decide the default switch

- Port the remaining supported model adapters and OAuth paths, Dream, schedules, local triggers, subagents, and external channels used by the default distribution. Verify the supported feature matrix on TS and document the compatibility path for Python SDK hooks and plugins.
- Exercise the existing install, service, update, asset and shutdown paths on release targets. Record startup, streaming and storage contention results from the pilot. Use the documented handoff to rehearse cutover and rollback, including data created after TS takes ownership.
- **Completion**. The supported feature and distribution checks pass, the Python SDK compatibility path is verified, and the instance handoff has a tested rollback for all persisted formats used by the release. Extend `legacy-cutover.test.ts` to cover the complete handoff before switching the default entry point.
- **Reference tests**. [Codex WebSocket](../tests/providers/test_openai_codex_websocket.py) · [Dream](../tests/agent/test_dream_run.py) · [Subagents](../tests/agent/test_subagent_lifecycle.py) · [Cron](../tests/cron/test_cron_service.py) · [Triggers](../tests/triggers/test_local_triggers.py) · [Channel contracts](../tests/channels/test_channel_contracts.py) · [SDK facade](../tests/test_nanobot_facade.py) · [Gateway service](../tests/gateway/test_gateway_service.py) · [Windows shutdown](../tests/gateway/test_windows_shutdown.py) · [Release packaging](../tests/cli/test_tui_release_packaging.py) · [Update restart](../tests/test_update_restart.py)

## Baseline verification

The planning checks at `37c2af8ff` passed 404 Python cases across the configuration, event, storage, provider, runner, cancellation and client contract suites. A separate run passed two real Python gateway smoke scenarios covering bootstrap, history hydration and restart recovery. These runs establish reference behavior. TypeScript verification begins when the corresponding batch adds its implementation and tests.

From the repository root, run the reference tests for a batch with `uv run --no-sync python -m pytest -q` followed by their paths. The two real gateway scenarios can be selected with the following command.

```bash
uv run --no-sync python -m pytest -q tests/webui/test_gateway_webui_smoke.py \
  -k 'bootstrap_message_and_thread_hydration or restart_restores_a_completed_answer'
```
