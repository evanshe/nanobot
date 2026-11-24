"""Private-file Python oracle for TS config parity tests; never imported by runtime."""
import json
import os
import sys
from pathlib import Path

from pydantic import BaseModel

from nanobot.config.errors import ConfigLoadError
from nanobot.config.home import set_home_path
from nanobot.config.loader import load_config, resolve_config_env_vars, save_config


def record(value):
    if isinstance(value, BaseModel):
        return {
            **{field.serialization_alias or field.alias or name: record(getattr(value, name))
               for name, field in type(value).model_fields.items()},
            **{key: record(item) for key, item in (value.model_extra or {}).items()},
        }
    if isinstance(value, dict):
        return {key: record(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [record(item) for item in value]
    return value


request = json.load(sys.stdin)
for name in list(os.environ):
    if (name.upper().startswith('NANOBOT_')
            or name.lower().split('__')[0] in {'modelpresets', 'model_presets'}):
        del os.environ[name]
os.environ.update(request.get('env', {}))
set_home_path(Path(request['home']) if request.get('home') else None)
path = Path(request['path'])
try:
    config = load_config(path)
    output = {'data': record(config), 'sourcePath': str(path.expanduser().resolve()), 'runtimeDataDir': str(config.runtime_data_dir),
              'workspacePath': str(config.workspace_path)}
    if request.get('resolve'):
        output['resolved'] = record(resolve_config_env_vars(config, config_path=path))
    target = path.expanduser().resolve() if request.get('saveAtSource') else path
    save_config(config, target)
    output['saved'] = json.loads(target.read_text(encoding='utf-8'))
    print(json.dumps(output))
except ConfigLoadError as error:
    print(json.dumps({'error': error.kind, 'paths': [list(issue.path) for issue in error.issues]}))
