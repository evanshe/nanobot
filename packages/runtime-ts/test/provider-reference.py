"""Exercise the public Python Chat provider against a caller-owned loopback stub."""
import asyncio
import json
import sys

from nanobot.providers.openai_compat_provider import OpenAICompatProvider

request = json.load(sys.stdin)


async def main():
    provider = OpenAICompatProvider(
        api_base=request['base'], default_model='test-model',
        extra_headers=request.get('headers'), extra_body=request.get('extra_body'),
        extra_query=request.get('extra_query'),
    )
    content, thinking = [], []

    async def on_content(value):
        content.append(value)

    async def on_thinking(value):
        thinking.append(value)

    try:
        kwargs = request['request']
        if request.get('stream'):
            result = await provider.chat_stream(
                **kwargs, on_content_delta=on_content, on_thinking_delta=on_thinking,
            )
        else:
            result = await provider.chat(**kwargs)
        print(json.dumps({'response': {
            'content': result.content, 'reasoning_content': result.reasoning_content,
            'finish_reason': result.finish_reason,
        }, 'content': content, 'thinking': thinking}))
    finally:
        await provider.aclose()


asyncio.run(main())
