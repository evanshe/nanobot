"""Exercise the public Python Chat provider against a caller-owned loopback stub."""
import asyncio
import json
import os
import sys
from dataclasses import asdict

from nanobot.providers.openai_compat_provider import OpenAICompatProvider, _is_local_endpoint

request = json.load(sys.stdin)
if 'timeout_s' in request:
    os.environ['NANOBOT_STREAM_IDLE_TIMEOUT_S'] = str(request['timeout_s'])
    os.environ['NANOBOT_OPENAI_COMPAT_TIMEOUT_S'] = str(request['timeout_s'])


async def main():
    provider = OpenAICompatProvider(
        api_base=request['base'], default_model='test-model',
        extra_headers=request.get('headers'), extra_body=request.get('extra_body'),
        extra_query=request.get('extra_query'),
    )
    content, thinking, tools = [], [], []

    async def on_content(value):
        content.append(value)
        if request.get('fail_callback'):
            raise RuntimeError('callback failed')

    async def on_thinking(value):
        thinking.append(value)

    async def on_tool(value):
        tools.append(value)

    try:
        kwargs = request['request']
        if request.get('stream'):
            result = await provider.chat_stream(
                **kwargs, on_content_delta=on_content, on_thinking_delta=on_thinking,
                on_tool_call_delta=on_tool,
            )
        else:
            result = await provider.chat(**kwargs)
        output = {'response': {
            'content': result.content, 'reasoning_content': result.reasoning_content,
            'finish_reason': result.finish_reason,
            'tool_calls': [asdict(call) for call in result.tool_calls],
            'usage': result.usage.to_dict() if result.usage else None,
        }, 'content': content, 'thinking': thinking, 'tools': tools}
        if request.get('endpoint_cases'):
            output['local_endpoints'] = [_is_local_endpoint(None, base)
                                         for base in request['endpoint_cases']]
        if request.get('exact_arguments'):
            output['argument_json'] = [json.dumps(call.arguments, ensure_ascii=False)
                                       for call in result.tool_calls]
        if result.finish_reason == 'error':
            for name in ('error_status_code', 'error_kind', 'error_type', 'error_code',
                         'error_retry_after_s', 'error_should_retry', 'retry_after'):
                output['response'][name] = getattr(result, name)
            output['transient'] = provider.is_transient_response(result)
        print(json.dumps(output))
    finally:
        await provider.aclose()


asyncio.run(main())
