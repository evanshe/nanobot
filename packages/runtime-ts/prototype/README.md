# Managed Node wheel prototype

This is an isolated distribution experiment for migration batch 0, not an opt-in nanobot gateway or a release wheel. It leaves the production package, entry point and profile data unchanged. Download the fixed official archive, then run from the repository root:

```bash
curl --fail --location --output /tmp/node-v24.22.3-linux-x64.tar.xz \
  https://nodejs.org/dist/v24.22.3/node-v24.22.3-linux-x64.tar.xz
uv run --no-sync python -m scripts.probe_ts_runtime_wheel \
  --node-archive /tmp/node-v24.22.3-linux-x64.tar.xz
uv run --no-sync python -O -m scripts.probe_ts_runtime_wheel \
  --node-archive /tmp/node-v24.22.3-linux-x64.tar.xz
```

The probe enforces archive SHA-256 `4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb`, recorded in the official [SHASUMS256.txt](https://nodejs.org/dist/v24.22.3/SHASUMS256.txt), before copying `bin/node` and `LICENSE` from that same archive into temporary resources. The archive URL and checksum are pinned in the script; supplying an arbitrary executable or separate license is no longer supported. Delete the downloaded archive after use; extracted resources, wheels and venvs are automatically removed.

The probe builds a temporary `nanobot_ts_distribution_probe-0.0.0-py3-none-linux_x86_64.whl`, installs it into a temporary venv without an index or dependencies, and invokes the installed `nanobot-ts-probe` console entry from a private home and working directory. `PATH` contains only an empty directory; no system Node, Bun or Git is discoverable. The Python launcher resolves the bundled executable and `gateway.ts` relative to its installed module and replaces itself with Node using `execv`, so the process retains the entry-point PID and receives shutdown signals directly. Node 24's native type stripping executes the TS resource without Bun, a compiler or an npm installation.

The wheel supplies the Node executable, its license, the TS probe and a small Python resource launcher. The probe uses only Node built-ins (`node:http`); it supplies no npm or native addon dependencies. Python remains an installation/launcher prerequisite. The Node binary still depends on the host Linux dynamic loader, glibc, libstdc++, libgcc, libm, libpthread and libdl; this wheel does not supply them or establish a manylinux baseline. Node provenance, license provenance and release build reproducibility require the release pipeline's verification before distribution.

On this Linux x86_64 workspace, both normal Python and `python -O` runs using the official archive passed HTTP readiness and exact installed wheel-resource identity, then graceful SIGTERM and SIGINT shutdown with observed exit 0 and an unchanged private home. The measured official Node executable SHA-256 was `a7ec1b37e6ff9d187e4198c5b6df9a4eb1c74dd31804fb3bac55cc4ceca1ac01`; its archive-supplied LICENSE SHA-256 was `5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace`. This supersedes the initial environment-provided executable experiment, whose binary provenance was not pinned. Only sources are tracked.

Critical validation uses explicit exceptions and always executes process waiting, including under `-O`. A private faulted wheel that acknowledged shutdown and exited 7 was correctly rejected under `-O`. A child emitting only a partial log line was also rejected at the read deadline; log reading uses bounded byte reads rather than potentially blocking `readline()` or draining a still-open stderr pipe.

This result demonstrates the candidate's packaged startup/shutdown mechanism on Linux x86_64. It does not validate Windows or macOS, Linux arm64, older glibc hosts, production gateway behavior, descendants of real tools, SQLite interruption or responsiveness under locks. Driver and runtime finalization remain gated by batch 2A and the release matrix. The prototype deliberately uses a separate package name and loopback ephemeral port and never opens nanobot stores.
