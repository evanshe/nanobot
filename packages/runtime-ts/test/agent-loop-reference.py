"""Public Python direct turns with fixed model/tool substitutes and private stores."""
import asyncio
import json
import platform
import sys
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch

import nanobot.utils.helpers as helpers
from nanobot.agent.loop import AgentLoop
from nanobot.agent.tools.base import Tool
from nanobot.agent.tools.registry import ToolRegistry
from nanobot.bus.queue import MessageBus
from nanobot.providers.base import (
    GenerationSettings,
    LLMProvider,
    LLMResponse,
    LLMUsage,
    ToolCallRequest,
)
from nanobot.session.manager import SessionManager

request = json.load(sys.stdin)
helpers._get_token_encoding = lambda: None
requests = []


class Model(LLMProvider):
    def __init__(self):
        super().__init__(None, None, provider_name='synthetic')
        self.generation = GenerationSettings(max_tokens=32, temperature=0.7)
        self.index = 0

    def get_default_model(self):
        return 'synthetic-model'

    async def chat(self, messages, **kwargs):
        return await self.chat_stream_with_retry(messages=messages, **kwargs)

    async def chat_stream_with_retry(self, *, messages, tools=None, **kwargs):
        requests.append(deepcopy({'messages': messages, 'tools': tools, **{
            key: kwargs.get(key) for key in ('model', 'max_tokens', 'temperature', 'reasoning_effort')
        }}))
        frame = request['responses'][self.index]
        self.index += 1
        return LLMResponse(
            content=frame.get('content'), tool_calls=[ToolCallRequest(**call) for call in frame.get('tool_calls', [])],
            usage=LLMUsage.reported(input_tokens=1, output_tokens=1),
        )


class Echo(Tool):
    @property
    def name(self):
        return 'echo'

    @property
    def description(self):
        return 'Synthetic output.'

    @property
    def parameters(self):
        return {'type': 'object', 'properties': {'value': {'type': 'string'}}, 'required': ['value']}

    async def execute(self, **kwargs):
        return 'synthetic output'


async def main():
    model, outputs, saved = Model(), [], None
    for index, text in enumerate(request['inputs']):
        sessions = SessionManager(Path(request['agent']), sessions_root=Path(request['sessions']))
        tools = ToolRegistry()
        tools.register(Echo())
        # Composition supplies only the deterministic substitute registry.
        with patch.object(AgentLoop, '_register_default_tools', lambda *args, **kwargs: None):
            loop = AgentLoop(bus=MessageBus(), provider=model, workspace=Path(request['agent']),
                             session_manager=sessions, tool_registry=tools, model='synthetic-model',
                             max_iterations=3, max_tool_result_chars=64, context_window_tokens=100_000)
        loop.context.skills.builtin_skills = Path(request['builtin'])
        try:
            output = await loop.process_direct(text)
            outputs.append(output.content)
            saved = await sessions.state.get('cli:direct')
        finally:
            await loop.aclose()
            await sessions.state.aclose()
    def normalize_engine(value):
        if isinstance(value, str):
            return value.replace(f'Python {platform.python_version()}', request['node_identity'])
        if isinstance(value, list):
            return [normalize_engine(item) for item in value]
        if isinstance(value, dict):
            return {key: normalize_engine(item) for key, item in value.items()}
        return value
    print(json.dumps(normalize_engine({'requests': requests, 'outputs': outputs, 'messages': saved.messages})))


asyncio.run(main())
