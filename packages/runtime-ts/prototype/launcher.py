"""Locate wheel-owned resources without consulting PATH or the user's home."""
import os
from pathlib import Path


def main():
    resources = Path(__file__).resolve().parent
    os.execv(str(resources / "node"), [str(resources / "node"), str(resources / "gateway.ts")])
