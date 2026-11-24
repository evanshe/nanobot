"""Offline public Python retry behavior with deterministic responses and waits."""
import asyncio
import json
import random
import sys

from nanobot.events import RetryStatusEvent
from nanobot.providers.base import LLMProvider, LLMResponse

request = json.load(sys.stdin)
random.uniform = lambda _low, high: high
content, thinking, sleeps, states, progress = [], [], [], [], []
attempts, recoveries = 0, 0


class SyntheticModel(LLMProvider):
    def __init__(self):
        super().__init__(None, None, provider_name='synthetic')

    def get_default_model(self):
        return 'synthetic'

    async def chat(self, messages, **kwargs):
        return await self.chat_stream(messages, **kwargs)

    async def chat_stream(self, messages, on_content_delta=None, on_thinking_delta=None, **kwargs):
        global attempts
        frame = request['frames'][min(attempts, len(request['frames']) - 1)]
        attempts += 1
        for value in frame.get('content', []):
            if on_content_delta:
                await on_content_delta(value)
        for value in frame.get('thinking', []):
            if on_thinking_delta:
                await on_thinking_delta(value)
        response = dict(frame['response'])
        response.pop('tool_calls', None)
        response.pop('usage', None)
        return LLMResponse(**response)


async def main():
    provider = SyntheticModel()

    async def collect_content(value):
        content.append(value)

    async def collect_thinking(value):
        thinking.append(value)

    async def collect_status(value):
        states.append({key: getattr(value, key) for key in
                       ('state', 'attempt', 'max_attempts', 'error_kind')})

    async def collect_wait(value):
        progress.append(value)

    async def recover():
        global recoveries
        recoveries += 1

    async def sleep(delay, **kwargs):
        sleeps.append(delay * 1000)
        if kwargs.get('on_retry_wait'):
            kind = 'persistent retry' if kwargs['persistent'] else 'retry'
            await kwargs['on_retry_wait'](
                f"Model request failed, {kind} in {max(1, int(round(delay)))}s "
                f"(attempt {kwargs['attempt']})."
            )
        if kwargs.get('on_retry_status'):
            await kwargs['on_retry_status'](RetryStatusEvent(
                state='waiting', attempt=kwargs['attempt'], max_attempts=kwargs['max_attempts'],
                error_kind=kwargs['error_kind'],
            ))

    provider._sleep_with_heartbeat = sleep
    result = await provider.chat_stream_with_retry(
        [{'role': 'user', 'content': 'synthetic'}], on_content_delta=collect_content,
        on_thinking_delta=collect_thinking, on_retry_status=collect_status,
        on_stream_recover=recover if request.get('recover') else None,
        retry_mode=request.get('mode', 'standard'), on_retry_wait=collect_wait,
    )
    print(json.dumps({'content': content, 'thinking': thinking, 'sleeps': sleeps,
                      'states': states, 'progress': progress, 'attempts': attempts, 'recoveries': recoveries,
                      'response': {key: getattr(result, key) for key in
                                   ('content', 'finish_reason', 'error_kind', 'error_should_retry')}}))


asyncio.run(main())
