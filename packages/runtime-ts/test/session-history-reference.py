"""Python owner baseline for synthetic model/display history parity."""
import json
import sys
from dataclasses import asdict
from datetime import datetime
from pathlib import Path

from nanobot.providers.base import ProviderConversationState
from nanobot.session.display_history import HistoryFact, HistoryKind
from nanobot.session.manager import Session
from nanobot.session.sqlite_store import SqliteSessionStore

root = Path(__file__).resolve().parents[3]
request = json.load(sys.stdin)
store = SqliteSessionStore(Path(request['directory']))
store.initialize(Path(request['directory']) / 'workspace')
if request['action'] == 'seed':
    fixture = json.loads((root / 'packages/runtime-ts/test/fixtures/stored-session.json').read_text())
    session = Session(**{key: value for key, value in fixture.items()
                        if key not in {'provider_state', 'created_at', 'updated_at'}},
                      created_at=datetime.fromisoformat(fixture['created_at']),
                      updated_at=datetime.fromisoformat(fixture['updated_at']),
                      generation='f' * 32, provider_state=ProviderConversationState(**fixture['provider_state']))
    store.save(session)
    facts = json.loads((root / 'packages/runtime-ts/test/fixtures/session-history.json').read_text())
    store.append_history(session.key, [HistoryFact(HistoryKind(fact['kind']), fact['content'],
                                                 fact['turn_id'], fact['phase'], fact['sequence'],
                                                 fact['created_at_ms']) for fact in facts],
                         expected_generation=session.generation)
session = store.load(request.get('key', 'chat:extensions'))


def display(reader):
    return {'revision': reader.revision, 'turns': [asdict(turn) for turn in reader.turns()],
            'facts': [json.loads(fact.encode()) for fact in reader.all_facts()],
            'page': {'entries': [[position, json.loads(fact.encode())] for position, fact in
                                 reader.read_entry_page(0, start=0, end=100, reverse=False,
                                                        max_records=3, max_bytes=500).entries],
                     'source_bytes': reader.read_entry_page(0, start=0, end=100, reverse=False,
                                                            max_records=3, max_bytes=500).source_bytes},
            'latest_usage': reader.latest_context_usage(session.generation),
            'open_tail': reader.open_tail_sequences(), 'has_input': reader.has_input('input-1'),
            'missing_references': reader.has_missing_input_references(0),
            'unique_position': reader.unique_user_position(0), 'prior_users': reader.user_count_before(1),
            'navigation': [[ordinal, position, fact.kind] for ordinal, position, fact in reader.navigation()]}


print(json.dumps({'session': None if session is None else {
    'key': session.key, 'messages': session.messages, 'metadata': session.metadata,
    'provider_state': session.provider_state.to_private_record() if session.provider_state else None,
    'created_at': session.created_at.isoformat(), 'updated_at': session.updated_at.isoformat(),
    'generation': session.generation, 'revision': session.revision, 'last_archived': session.last_archived,
}, 'display': store.project_history(session.key, display) if session else None}))
