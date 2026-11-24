# Runtime parity fixtures

These synthetic records preserve IDs, ordering, optional fields and durable values; they contain no live profile data. Python tests consume the JSON directly so later TypeScript tests can use the same inputs and expected outputs.

| Fixture | Observable contract | Python reference |
| --- | --- | --- |
| `config.json` | Config aliases, environment expansion and saved values | `tests/config/test_config_migration.py`, `tests/config/test_env_interpolation.py`, `tests/config/test_config_atomic_save.py` |
| `gateway-chat.json` | A real gateway creates a session and emits the model-information command reply followed by completion | `tests/webui/test_gateway_webui_smoke.py` |
| `openai-chat-tools.json` | Ordered partial tool arguments produce one identified call, decoded newline, normalized usage and terminal reason | `tests/providers/test_openai_compat_spec.py::test_openai_compat_stream_forwards_tool_call_argument_deltas` |
| `stored-session.json` | Metadata extensions, model messages, provider state, checkpoint and follow-up survive v1 migration and reopen | `tests/session/test_sqlite_schema.py::test_ordered_upgrades_preserve_records_and_do_not_repeat_import` |

For an old database, execute `tests/session/fixtures/sqlite_v1.sql` into a fresh SQLite database and save `stored-session.json` through the Python reference as that test does. The SQL is shared by path rather than copied. Its `jsonl_import=complete` marker prevents legacy import from running again. Session datetimes are fixed; generation identifiers are created by the storage owner and must retain their identity across subsequent writes. `tool_result` in the provider fixture supplies the deterministic tool reply for the later runner batch; actual tool execution is not covered by this fixture extraction.
