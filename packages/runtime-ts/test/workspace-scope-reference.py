"""Exercise Python workspace scope resolution with private input roots."""
import json
import os
import sys
from unittest.mock import patch

from nanobot.security.workspace_access import (
    WorkspaceScopeError,
    WorkspaceScopeResolver,
    build_workspace_scope,
    default_workspace_scope,
    resolve_effective_workspace_scope,
    validate_workspace_scope_payload,
    workspace_sandbox_status,
    workspace_scope_from_metadata,
)


def run(case, home):
    defaults = {'default_workspace': case['workspace'], 'default_restrict_to_workspace': case.get('restricted', True)}
    with patch.dict(os.environ, {'HOME': home, 'USERPROFILE': home, **case.get('environment', {})}, clear=True):
        try:
            operation = case['operation']
            if operation == 'status':
                return workspace_sandbox_status(restrict_to_workspace=case.get('restricted', True), workspace=case['workspace'], environ=case.get('environment', {})).as_dict()
            if operation == 'default':
                scope = default_workspace_scope(case['workspace'], case.get('restricted', True))
            elif operation == 'build':
                scope = build_workspace_scope(case['workspace'], case['mode'])
            elif operation == 'validate':
                scope = validate_workspace_scope_payload(case.get('raw'), **defaults)
            elif operation == 'metadata':
                scope = workspace_scope_from_metadata(case.get('metadata'), **defaults)
            elif operation == 'effective':
                scope = resolve_effective_workspace_scope(message_metadata=case.get('message'), session_metadata=case.get('session'), **defaults)
            else:
                resolver = WorkspaceScopeResolver(case['workspace'], case.get('restricted', True))
                scope = resolver.for_turn(channel=case.get('channel'), message_metadata=case.get('message'), session_metadata=case.get('session'))
            return {'payload': scope.payload(), 'metadata': scope.metadata(), 'source_channel': scope.source_channel}
        except WorkspaceScopeError as error:
            return {'error': str(error), 'status': error.status}


request = json.load(sys.stdin)
print(json.dumps([run(case, request['home']) for case in request['cases']], ensure_ascii=False))
