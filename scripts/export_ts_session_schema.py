"""Export released SQLite migrations by observing their actual Python SQL."""
import argparse
import json
import sqlite3
from pathlib import Path

from nanobot.session.sqlite_store import _SCHEMA_MIGRATIONS

OUTPUT = Path(__file__).resolve().parents[1] / 'packages/runtime-ts/src/session/schema.json'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    migrations = []
    with sqlite3.connect(':memory:', isolation_level=None) as database:
        for version, migrate in enumerate(_SCHEMA_MIGRATIONS, 1):
            statements = []
            database.set_trace_callback(statements.append)
            migrate(database)
            database.set_trace_callback(None)
            migrations.append({'version': version, 'statements': statements})
    content = json.dumps(migrations, ensure_ascii=False, indent=2) + '\n'
    if args.check:
        if OUTPUT.read_text(encoding='utf-8') != content:
            raise SystemExit('TS session schema is stale')
    else:
        OUTPUT.write_text(content, encoding='utf-8')


if __name__ == '__main__':
    main()
