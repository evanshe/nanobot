# Managed Node wheel prototype

This is an isolated distribution experiment for migration batch 0, not an opt-in nanobot gateway or a release wheel. It leaves the production package, entry point and profile data unchanged. Run from the repository root with the exact Node 24.22.3 executable and its matching upstream LICENSE file:

```bash
uv run --no-sync python -m scripts.probe_ts_runtime_wheel \
  --node /absolute/path/to/node \
  --node-license /absolute/path/to/node-v24.22.3/LICENSE
```

The probe builds a temporary `nanobot_ts_distribution_probe-0.0.0-py3-none-linux_x86_64.whl`, installs it into a temporary venv without an index or dependencies, and invokes the installed `nanobot-ts-probe` console entry from a private home and working directory. `PATH` contains only an empty directory; no system Node, Bun or Git is discoverable. The Python launcher resolves the bundled executable and `gateway.ts` relative to its installed module and replaces itself with Node using `execv`, so the process retains the entry-point PID and receives shutdown signals directly. Node 24's native type stripping executes the TS resource without Bun, a compiler or an npm installation.

The wheel supplies the Node executable, its license, the TS probe and a small Python resource launcher. The probe uses only Node built-ins (`node:http`); it supplies no npm or native addon dependencies. Python remains an installation/launcher prerequisite. The Node binary still depends on the host Linux dynamic loader, glibc, libstdc++, libgcc, libm, libpthread and libdl; this wheel does not supply them or establish a manylinux baseline. Node provenance, license provenance and release build reproducibility require the release pipeline's verification before distribution.

On this Linux x86_64 workspace, the probe passed HTTP readiness and wheel-resource identity, then graceful SIGTERM and SIGINT shutdown with exit 0 and an unchanged private home. The measured Node 24.22.3 executable SHA-256 was `acbe4b8d9153b841ed0697cbfc4f93e767386620edb745ab9358306c0a6f31aa`. The matching license was obtained from `https://raw.githubusercontent.com/nodejs/node/v24.22.3/LICENSE`. All wheel, venv and copied binary artifacts are deleted by the probe; only these sources are tracked.

This result demonstrates the candidate's packaged startup/shutdown mechanism on Linux x86_64. It does not validate Windows or macOS, Linux arm64, older glibc hosts, production gateway behavior, descendants of real tools, SQLite interruption or responsiveness under locks. Driver and runtime finalization remain gated by batch 2A and the release matrix. The prototype deliberately uses a separate package name and loopback ephemeral port and never opens nanobot stores.
