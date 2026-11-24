"""Copy text-only bundled context resources for the private Node package."""
import argparse
import json
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
target = root / 'packages/runtime-ts/resources'
expected = {}
defaults = {}
default_names = {'AGENTS.md', 'USER.md', 'SOUL.md', 'legacy/SOUL.md', 'memory/MEMORY.md'}
templates = {'AGENTS.md', 'USER.md', 'SOUL.md', 'legacy/SOUL.md', 'memory/MEMORY.md',
             'agent/identity.md', 'agent/platform_policy.md', 'agent/tool_contract.md',
             'agent/skills_section.md', 'agent/_snippets/untrusted_content.md'}
tracked_skills = {Path(value.decode()) for value in subprocess.check_output(
    ['git', 'ls-files', '-z', '--', 'nanobot/skills'], cwd=root,
).split(b'\0') if value}
for folder in ('templates', 'skills'):
    source = root / 'nanobot' / folder
    for path in source.rglob('*'):
        if (path.is_file() and path.suffix in {'.md', '.py', '.sh'}
                and (folder != 'templates' or path.relative_to(source).as_posix() in templates)
                and (folder != 'skills' or path.relative_to(root) in tracked_skills)):
            if folder == 'templates' and path.relative_to(source).as_posix() in default_names:
                defaults[path.relative_to(source).as_posix()] = path.read_text()
            else:
                expected[Path(folder) / path.relative_to(source)] = path.read_bytes()
expected[Path('templates/defaults.json')] = (
    json.dumps(defaults, ensure_ascii=False, indent=2) + '\n'
).encode()
parser = argparse.ArgumentParser()
parser.add_argument('--check', action='store_true')
args = parser.parse_args()
actual = {path.relative_to(target): path.read_bytes()
          for path in target.rglob('*') if path.is_file()} if target.exists() else {}
if args.check:
    if actual != expected:
        raise SystemExit('TypeScript agent text resources are stale')
else:
    if actual.keys() - expected.keys():
        raise SystemExit('Unexpected resource files; reconcile them explicitly before exporting')
    for relative, content in expected.items():
        path = target / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
