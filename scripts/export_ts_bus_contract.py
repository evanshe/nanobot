"""Export the localized outbound fallback owned by the Python command catalog."""
import argparse
import json
from pathlib import Path

from nanobot.command_copy import catalog

OUTPUT = Path(__file__).resolve().parents[1] / 'packages/runtime-ts/src/bus/compaction-text.json'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    entries = catalog()
    content = json.dumps({phase: entries[f'compact.{phase}']
                          for phase in ('started', 'succeeded', 'failed', 'cancelled')},
                         ensure_ascii=False, indent=2) + '\n'
    if args.check:
        if OUTPUT.read_text(encoding='utf-8') != content:
            raise SystemExit('TS bus fallback catalog is stale')
    else:
        OUTPUT.write_text(content, encoding='utf-8')


if __name__ == '__main__':
    main()
