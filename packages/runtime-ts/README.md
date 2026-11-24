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
