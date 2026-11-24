"""Compare scoped directory/search results using private filesystem fixtures."""
import base64
import json
import sys
from pathlib import Path

from nanobot.config.home import set_home_path
from nanobot.execution.files import WorkspaceFiles, exclude_file_paths

request = json.load(sys.stdin)
set_home_path(Path(request['instance']))
results = []
for case in request['cases']:
    files = WorkspaceFiles(workspace=Path(request['workspace']), allowed_dir=Path(request['workspace']),
                           extra_read_allowed_dirs=case.get('extra', ()), builtin_skills=Path(request['builtin']),
                           plugin_skill_roots=lambda *_: ())
    with exclude_file_paths(*(Path(value) for value in case.get('excluded', ()))):
        if case['operation'] == 'list':
            value = files.list_directory('.', recursive=case['recursive'], ignored=set(case.get('ignored', ())), limit=case['limit'])
            results.append({'entries': [{'path': str(path), 'isDirectory': directory} for path, directory in value.entries], 'total': value.total})
        else:
            tree = files.search_tree('.')
            if case['operation'] == 'entries':
                results.append(sorted([{'name': entry.name, 'isDirectory': entry.is_directory, 'isDirectoryLink': entry.is_directory_link}
                                       for entry in tree.entries(Path(request['workspace']))], key=lambda item: item['name']))
            elif case['operation'] == 'modified':
                results.append(tree.modified_children(Path(request['workspace']), case['names'], checkpoint=lambda: None))
            else:
                with tree.search_bytes_reader() as read:
                    values = [read(Path(request['workspace']) / path, case['limit']) for path in case['paths']]
                    results.append([None if value is None else {'data': None if value.data is None else base64.b64encode(value.data).decode('ascii'), 'modified': value.modified}
                                    for value in values])
print(json.dumps(results, ensure_ascii=False))
