"""Public Python ContextBuilder baseline on caller-owned temporary roots."""
import json
import os
import platform
import sys
from pathlib import Path

from nanobot.agent.context import ContextBuilder, TranscriptInput
from nanobot.runtime_context import RuntimeContextBlock

request = json.load(sys.stdin)
builder = ContextBuilder(Path(request['agent']), disabled_skills=request.get('disabled'))
builder.skills.builtin_skills = Path(request['builtin'])
builder.skills._skill_aliases = lambda: request.get('aliases', {})
if 'environment' in request:
    os.environ.clear()
    os.environ.update(request['environment'])
transcript = TranscriptInput(
    history=request.get('history', []), current_message=request.get('current', 'synthetic'),
    current_role=request.get('role', 'user'), media=request.get('media'),
    session_summary=request.get('summary'), input_metadata=request.get('input_metadata'),
    runtime_context_blocks=[RuntimeContextBlock(**block) for block in request.get('blocks', [])],
)
messages = builder.build_transcript(
    transcript, channel=request.get('channel'), workspace=Path(request['project']),
    include_memory=request.get('include_memory', True), has_cron=request.get('has_cron', True),
)
# The runtime engine identity is intentionally different; normalize only that line.
messages[0]['content'] = messages[0]['content'].replace(
    f'Python {platform.python_version()}', request['node_identity'], 1,
)
print(json.dumps(messages))
