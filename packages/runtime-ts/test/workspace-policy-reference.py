"""Compare path decisions against Python on caller-owned temporary fixtures."""
import json
import sys

from nanobot.security.workspace_policy import (
    WorkspaceBoundaryError,
    is_path_allowed,
    is_path_within,
    require_path_within,
    resolve_allowed_path,
    resolve_path,
)


def run(case):
    options = case.get('options', {})
    names = {'allowedRoot': 'allowed_root', 'extraAllowedRoots': 'extra_allowed_roots',
             'extraAllowedFiles': 'extra_allowed_files'}
    options = {names.get(key, key): value for key, value in options.items() if key != 'home'}
    try:
        operation = case['operation']
        if operation == 'resolve':
            value = resolve_path(case['path'], **options)
        elif operation == 'allowed':
            value = resolve_allowed_path(case['path'], **options)
        elif operation == 'within':
            value = is_path_within(case['path'], case['root'])
        elif operation == 'roots':
            value = is_path_allowed(case['path'], case['roots'])
        else:
            value = require_path_within(case['path'], case['root'], **options)
        return {'value': str(value) if not isinstance(value, bool) else value}
    except WorkspaceBoundaryError as error:
        return {'error': 'boundary', 'message': str(error)}
    except FileNotFoundError:
        return {'error': 'missing'}
    except NotADirectoryError:
        return {'error': 'not-directory'}
    except RuntimeError:
        return {'error': 'loop'}
    except ValueError:
        return {'error': 'invalid'}


print(json.dumps([run(case) for case in json.load(sys.stdin)], ensure_ascii=False))
