"""Run deterministic synthetic model/tool turns through the public Python runner."""
import asyncio
import json
import sys
from copy import deepcopy

import nanobot.utils.helpers as helpers
from nanobot.agent.runner import AgentRunner, AgentRunSpec
from nanobot.agent.tools.base import Tool
from nanobot.agent.tools.registry import ToolRegistry
from nanobot.providers.base import (
    GenerationSettings,
    LLMProvider,
    LLMResponse,
    LLMUsage,
    ToolCallRequest,
)
from nanobot.utils.llm_runtime import LLMRuntime

request = json.load(sys.stdin)
helpers._get_token_encoding = lambda: None  # Explicit offline UTF-8 fallback, no vocabulary download.
requests, checkpoints, executed = [], [], []


class SyntheticModel(LLMProvider):
    def __init__(self):
        super().__init__(None, None, provider_name='synthetic')
        self.index = 0

    def get_default_model(self):
        return 'synthetic-model'

    async def chat(self, messages, **kwargs):
        return await self.chat_stream_with_retry(messages=messages, **kwargs)

    async def chat_stream_with_retry(self, *, messages, tools=None, **kwargs):
        requests.append(deepcopy({'messages': messages, 'tools': tools, **{
            key: kwargs.get(key) for key in ('model', 'max_tokens', 'temperature', 'reasoning_effort')
        }}))
        frame = request['responses'][min(self.index, len(request['responses']) - 1)]
        self.index += 1
        return LLMResponse(
            content=frame.get('content'), reasoning_content=frame.get('reasoning_content'),
            finish_reason=frame.get('finish_reason', 'stop'),
            tool_calls=[ToolCallRequest(**call) for call in frame.get('tool_calls', [])],
            usage=LLMUsage.reported(**{key: value for key, value in
                                      (frame.get('usage') or {'input_tokens': 1, 'output_tokens': 1}).items()
                                      if key in {'input_tokens', 'output_tokens', 'total_tokens',
                                                 'cache_read_tokens', 'cache_write_tokens'}}),
        )


class SyntheticTool(Tool):
    @property
    def name(self):
        return 'echo'

    @property
    def description(self):
        return 'Return synthetic fixture output.'

    @property
    def parameters(self):
        return {'type': 'object', 'properties': {'value': {'type': 'string'}}, 'required': ['value']}

    async def execute(self, **kwargs):
        executed.append(deepcopy(kwargs))
        return request.get('tool_result', 'synthetic output')


async def main():
    tools = ToolRegistry()
    tools.register(SyntheticTool())

    async def checkpoint(value):
        checkpoints.append(deepcopy(value))

    async def consolidate(_messages, _summary):
        return request.get('summary_text')

    injections = iter(request.get('injections', []))

    async def inject():
        return next(injections, [])

    try:
        result = await AgentRunner().run(AgentRunSpec(
            initial_messages=request.get('messages', [{'role': 'user', 'content': 'synthetic input'}]),
            tools=tools, runtime=LLMRuntime(
                provider=SyntheticModel(), model='synthetic-model',
                generation=GenerationSettings(max_tokens=32, temperature=0.7),
                context_window_tokens=request.get('context_window_tokens', 100_000),
            ), max_iterations=request.get('max_iterations', 3), max_tool_result_chars=64,
            finalize_on_max_iterations=request.get('finalize', True),
            checkpoint_callback=checkpoint, consolidate_history=consolidate,
            injection_callback=inject if "injections" in request else None,
        ))
        print(json.dumps({'final_content': result.final_content, 'messages': result.messages,
                          'stop_reason': result.stop_reason, 'error': result.error,
                          'tools_used': result.tools_used, 'tool_events': result.tool_events,
                          'requests': requests, 'checkpoints': checkpoints, 'executed': executed,
                          'usage': None if result.usage is None else {
                              key: getattr(result.usage, key) for key in (
                                  'input_tokens', 'output_tokens', 'total_tokens', 'request_count',
                              )
                          }}))
    except Exception as error:
        print(json.dumps({'exception': type(error).__name__, 'requests': requests, 'executed': executed}))


asyncio.run(main())
