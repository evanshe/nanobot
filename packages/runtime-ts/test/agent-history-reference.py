"""Python model replay and image persistence on an explicitly private data root."""
import json
import sys
from pathlib import Path

import nanobot.session.image_attachments as images
import nanobot.utils.helpers as helpers
from nanobot.session.manager import Session

request = json.load(sys.stdin)
images.get_data_dir = lambda: Path(request['data'])
helpers._get_token_encoding = lambda: None
if request.get('action') == 'persist':
    print(json.dumps(images.persist_user_image_blocks(request['content'])))
else:
    session = Session(key='chat:synthetic', messages=request['messages'])
    session.last_archived = request.get('last_archived', 0)
    print(json.dumps(session.get_history(
        request.get('max_messages', 0), max_tokens=request.get('max_tokens', 0),
        extend_to_user=request.get('extend', False), include_runtime_context=request.get('context', True),
    )))
