"""Exercise authorized file selections against independent temporary fixtures."""
import json
import sys
from contextlib import ExitStack
from pathlib import Path

from nanobot.config.home import set_home_path
from nanobot.execution.files import WorkspaceFiles, exclude_file_paths
from nanobot.security.workspace_access import (
    bind_workspace_scope,
    build_workspace_scope,
    reset_workspace_scope,
)

request = json.load(sys.stdin)
set_home_path(Path(request['instance']))
results = []
for case in request['cases']:
    options = {'workspace': Path(request['agent']), 'allowed_dir': Path(request['agent']),
               'builtin_skills': Path(request['builtin']), 'plugin_skill_roots': lambda *_: ()}
    names = {'extraReadAllowedDirectories': 'extra_read_allowed_dirs', 'extraAllowedDirectories': 'extra_read_allowed_dirs',
             'extraReadAllowedFiles': 'extra_read_allowed_files', 'extraWriteAllowedDirectories': 'extra_write_allowed_dirs',
             'extraWriteAllowedFiles': 'extra_write_allowed_files', 'allowedDirectory': 'allowed_dir'}
    options.update({names[key]: value for key, value in case.get('options', {}).items()})
    files = WorkspaceFiles(**options)
    token = bind_workspace_scope(build_workspace_scope(case.get('project', request['agent']), case.get('mode', 'restricted')))
    try:
        with ExitStack() as context:
            if case.get('excluded'):
                context.enter_context(exclude_file_paths(*(Path(value) for value in case['excluded']), writes_only=case.get('writesOnly', False)))
            operation, path = case['operation'], case['path']
            if operation == 'read':
                target = files.read_file(path)
                with target.open() as (stream, _):
                    results.append({'path': str(target.path), 'size': target.size, 'suffix': target.suffix, 'text': stream.read().decode('utf8')})
            elif operation == 'edit':
                target = files.edit_target(path)
                snapshot = target.snapshot(1024)
                results.append({'path': str(target.path), 'snapshot': {'exists': snapshot.exists, 'text': snapshot.text}})
            else:
                results.append({'siblings': sorted(files.sibling_files(files.edit_target(path)))})
    except Exception as error:
        results.append({'error': type(error).__name__, 'message': str(error)})
    finally:
        reset_workspace_scope(token)
print(json.dumps(results, ensure_ascii=False))
