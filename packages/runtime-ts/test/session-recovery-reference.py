"""Pure checkpoint parity reference; generated restoration times are incidental."""
import json
import sys

from nanobot.providers.base import ProviderConversationState
from nanobot.session.manager import Session
from nanobot.session.recovery import restore_runtime_checkpoint, runtime_checkpoint_is_well_formed

checkpoint = json.load(sys.stdin)
provider = ProviderConversationState(kind='openai_responses', provider='openai', model='model', version=1, payload={'cursor': 'synthetic'})
session = Session(key='chat:parity', messages=[{'role': 'user', 'content': 'work', 'input_id': 'first', 'timestamp': '2026-01-01T00:00:00'}],
                  metadata={'pending_user_turn': True, 'runtime_checkpoint': checkpoint}, provider_state=provider)
valid = runtime_checkpoint_is_well_formed(checkpoint)
restored = restore_runtime_checkpoint(session)
for message in session.messages:
    if message.get('timestamp') not in {'2026-01-01T00:00:00', '2026-01-01T00:00:01', '2026-01-01T00:00:02'}:
        message['timestamp'] = '<generated>'
print(json.dumps({'valid': valid, 'restored': restored, 'second_restore': restore_runtime_checkpoint(session),
                  'messages': session.messages, 'metadata': session.metadata,
                  'provider_state': session.provider_state.to_private_record() if session.provider_state else None,
                  'consumed_ids': sorted(session.consumed_followup_ids)}))
