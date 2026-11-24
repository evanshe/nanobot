"""Offline model-facing message normalization via Python's actual governor."""
import json
import sys
from types import SimpleNamespace

from nanobot.agent.context_governance import ContextGovernor

request = json.load(sys.stdin)
config = SimpleNamespace(workspace=None, session_key=None, max_tool_result_chars=request['limit'])
print(json.dumps(ContextGovernor().prepare_messages_for_model(config, request['messages'])))
