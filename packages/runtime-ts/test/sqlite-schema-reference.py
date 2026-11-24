"""Private database producer/consumer for TS SQLite interoperability checks."""
import json
import sqlite3
import sys
from contextlib import closing
from datetime import datetime
from pathlib import Path

from nanobot.providers.base import ProviderConversationState
from nanobot.session.manager import Session
from nanobot.session.sqlite_store import SqliteSessionStore

root = Path(__file__).resolve().parents[3]
request = json.load(sys.stdin)
store = SqliteSessionStore(Path(request['directory']))
if request['action'] == 'create_v1':
    fixture = json.loads((root / 'packages/runtime-ts/test/fixtures/stored-session.json').read_text())
    with closing(sqlite3.connect(store.path)) as db:
        db.executescript((root / 'tests/session/fixtures/sqlite_v1.sql').read_text())
    session = Session(**{key: value for key, value in fixture.items()
                        if key not in {'provider_state', 'created_at', 'updated_at'}},
                      created_at=datetime.fromisoformat(fixture['created_at']),
                      updated_at=datetime.fromisoformat(fixture['updated_at']),
                      provider_state=ProviderConversationState(**fixture['provider_state']))
    store.save(session)
else:
    store.initialize(Path(request['directory']) / 'workspace')
    session = store.load('chat:extensions')
    if request['action'] == 'read_write':
        session.messages.append({'role': 'user', 'content': 'Python after TS'})
        store.save(session)
print(json.dumps({'key': session.key, 'generation': session.generation, 'revision': session.revision,
                  'created_at': session.created_at.isoformat(), 'updated_at': session.updated_at.isoformat(),
                  'messages': session.messages, 'metadata': session.metadata,
                  'provider_state': session.provider_state.to_private_record()}))
