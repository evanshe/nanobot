"""Export Python runner prompts used by the private TypeScript implementation."""
import argparse
import json
from pathlib import Path

from nanobot.utils import runtime

root = Path(__file__).resolve().parents[1]
target = root / 'packages/runtime-ts/src/agent/prompts.json'
payload = {name: getattr(runtime, name) for name in (
    'EMPTY_FINAL_RESPONSE_MESSAGE', 'FINALIZATION_RETRY_PROMPT',
    'BUDGET_EXHAUSTED_FINALIZATION_PROMPT', 'LENGTH_RECOVERY_PROMPT',
)}
payload['MAX_ITERATIONS'] = (root / 'nanobot/templates/agent/max_iterations_message.md').read_text().strip()
text = json.dumps(payload, ensure_ascii=False, indent=2) + '\n'
parser = argparse.ArgumentParser()
parser.add_argument('--check', action='store_true')
args = parser.parse_args()
if args.check:
    if not target.exists() or target.read_text() != text:
        raise SystemExit(f'{target.relative_to(root)} is stale')
else:
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text)
