"""Build/install/stop an isolated Linux x64 prototype wheel, never a release artifact.

Run with --node /absolute/node --node-license /absolute/LICENSE.
All generated artifacts (including the copied Node binary) are temporary.
"""
from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import json
import platform
import selectors
import signal
import subprocess
import tempfile
import urllib.request
import venv
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "nanobot_ts_distribution_probe"
INFO = f"{PACKAGE}-0.0.0.dist-info"


def build_wheel(node: Path, license_file: Path, output: Path) -> Path:
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise RuntimeError("This prototype is verified only on Linux x86_64")
    version = subprocess.check_output([node, "--version"], text=True).strip()
    if version != "v24.22.3":
        raise ValueError(f"Expected Node v24.22.3, got {version}")
    prototype = ROOT / "packages/runtime-ts/prototype"
    files = {
        f"{PACKAGE}/__init__.py": b"",
        f"{PACKAGE}/launcher.py": (prototype / "launcher.py").read_bytes(),
        f"{PACKAGE}/gateway.ts": (prototype / "gateway.ts").read_bytes(),
        f"{PACKAGE}/node": node.read_bytes(),
        f"{INFO}/licenses/NODE-LICENSE": license_file.read_bytes(),
        f"{INFO}/METADATA": b"Metadata-Version: 2.4\nName: nanobot-ts-distribution-probe\nVersion: 0.0.0\nLicense-File: licenses/NODE-LICENSE\n\nPrivate distribution experiment.\n",
        f"{INFO}/WHEEL": b"Wheel-Version: 1.0\nGenerator: nanobot-probe\nRoot-Is-Purelib: false\nTag: py3-none-linux_x86_64\n",
        f"{INFO}/entry_points.txt": f"[console_scripts]\nnanobot-ts-probe = {PACKAGE}.launcher:main\n".encode(),
    }
    record = io.StringIO(newline="")
    writer = csv.writer(record)
    for name, data in files.items():
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
        writer.writerow([name, f"sha256={digest}", len(data)])
    writer.writerow([f"{INFO}/RECORD", "", ""])
    files[f"{INFO}/RECORD"] = record.getvalue().encode()
    wheel = output / f"{PACKAGE}-0.0.0-py3-none-linux_x86_64.whl"
    with zipfile.ZipFile(wheel, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items():
            member = zipfile.ZipInfo(name)
            member.external_attr = (0o100755 if name == f"{PACKAGE}/node" else 0o100644) << 16
            member.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(member, data)
    return wheel


def read_line(process: subprocess.Popen, timeout: float = 15) -> dict:
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ)
        if not selector.select(timeout):
            raise TimeoutError("Packaged gateway did not report readiness/shutdown")
    line = process.stdout.readline()
    if not line:
        raise RuntimeError(f"Gateway exited: {process.stderr.read()}")
    return json.loads(line)


def probe(node: Path, license_file: Path) -> dict:
    with tempfile.TemporaryDirectory(prefix="nanobot-ts-wheel-") as directory:
        root = Path(directory)
        wheel = build_wheel(node, license_file, root)
        environment = root / "venv"
        venv.EnvBuilder(with_pip=True).create(environment)
        python = environment / "bin/python"
        subprocess.run([python, "-m", "pip", "install", "--no-index", "--no-deps", str(wheel)], check=True, capture_output=True)
        private_home = root / "home"
        private_home.mkdir(mode=0o700)
        empty_path = root / "empty-path"
        empty_path.mkdir()
        env = {"HOME": str(private_home), "PATH": str(empty_path), "LANG": "C.UTF-8"}
        entry = environment / "bin/nanobot-ts-probe"
        evidence = []
        for stop_signal in (signal.SIGTERM, signal.SIGINT):
            process = subprocess.Popen([entry], cwd=private_home, env=env, text=True,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                ready = read_line(process)
                assert ready["pid"] == process.pid  # exec preserves entry-point process identity
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                with opener.open(f"http://127.0.0.1:{ready['port']}", timeout=5) as response:
                    identity = json.load(response)
                assert identity["runtime"] == "v24.22.3"
                assert str(environment) in identity["source"]
                assert identity["source"].endswith(f"/{PACKAGE}/gateway.ts")
                process.send_signal(stop_signal)
                stopped = read_line(process)
                assert stopped == {"stopped": stop_signal.name}
                assert process.wait(timeout=10) == 0
                evidence.append({"signal": stop_signal.name, "exit": 0, "wheel_resource": True})
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
        assert list(private_home.iterdir()) == []
        return {"platform": "linux_x86_64", "node": "v24.22.3",
                "node_sha256": hashlib.sha256(node.read_bytes()).hexdigest(),
                "path": "empty directory", "home": "private and unchanged", "checks": evidence}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--node-license", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(probe(args.node.resolve(), args.node_license.resolve()), indent=2))


if __name__ == "__main__":
    main()
