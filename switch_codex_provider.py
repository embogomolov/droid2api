"""Change saved Codex task providers and the default provider in config.toml.

Windows, Python 3.11+. No model requests, no CLI chat, no backup files.
Run --self-test for isolated tests or --list for a read-only task listing.
"""
import argparse
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import tempfile
import tomllib

class CodexRunningError(RuntimeError):
    pass


def read_only(path):
    return sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=5)


def read_settings(home):
    with (home / 'config.toml').open('rb') as file:
        config = tomllib.load(file)
    database_dir = Path(config.get('sqlite_home', os.environ.get('CODEX_SQLITE_HOME') or home)).expanduser()
    if not database_dir.is_absolute():
        raise RuntimeError('sqlite_home должен быть абсолютным путём.')
    return config, database_dir


def plan_config_provider(home, provider):
    path = home / 'config.toml'
    original = path.read_bytes()
    text = original.decode('utf-8')
    config = tomllib.loads(text)
    if provider != 'openai' and provider not in config.get('model_providers', {}):
        raise RuntimeError(f'Провайдер {provider} не зарегистрирован в config.toml.')
    if config.get('model_provider') == provider:
        return path, original, original
    expected = {**config, 'model_provider': provider}
    value = json.dumps(provider)
    if 'model_provider' not in config:
        newline = '\r\n' if '\r\n' in text else '\n'
        candidates = [f'model_provider = {value}{newline}' + text]
    else:
        # Validate the full TOML result: profile keys and multiline text must stay intact.
        pattern = re.compile(r'''(?m)^([ \t]*(?:model_provider|"model_provider"|'model_provider')[ \t]*=[ \t]*)(?:"(?:\\.|[^"\\\r\n])*"|'[^'\r\n]*')''')
        candidates = [text[:m.start()] + m[1] + value + text[m.end():]
                      for m in pattern.finditer(text)]
    valid = []
    for candidate in candidates:
        try:
            if tomllib.loads(candidate) == expected:
                valid.append(candidate.encode('utf-8'))
        except tomllib.TOMLDecodeError:
            pass
    if len(valid) != 1:
        raise RuntimeError('Не удалось однозначно изменить верхнеуровневый model_provider в config.toml.')
    return path, original, valid[0]


def write_config_provider(plan, check_closed=None):
    check_closed = check_closed or ensure_codex_closed
    check_closed()
    path, original, updated = plan
    if path.read_bytes() != original:
        raise RuntimeError('config.toml изменился во время операции; его запись отменена.')
    if updated == original:
        return False
    descriptor, temporary = tempfile.mkstemp(prefix='.codex-config-', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as file:
            file.write(updated)
            file.flush()
            os.fsync(file.fileno())
        check_closed()
        if path.read_bytes() != original:
            raise RuntimeError('config.toml изменился во время операции; его запись отменена.')
        os.replace(temporary, path)
        return True
    finally:
        Path(temporary).unlink(missing_ok=True)


def ensure_codex_closed():
    if os.name != 'nt':
        raise RuntimeError('Этот инструмент предназначен для Windows.')
    # Native process snapshot: no PowerShell startup for each of hundreds of tasks.
    import ctypes
    from ctypes import wintypes
    class Entry(ctypes.Structure):
        _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD),
                    ('pid', wintypes.DWORD), ('heap', ctypes.c_size_t),
                    ('module', wintypes.DWORD), ('threads', wintypes.DWORD),
                    ('parent', wintypes.DWORD), ('priority', wintypes.LONG),
                    ('flags', wintypes.DWORD), ('exe', wintypes.WCHAR * 260)]
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Process32FirstW.argtypes = kernel.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(Entry)]
    kernel.Process32FirstW.restype = kernel.Process32NextW.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    snapshot = kernel.CreateToolhelp32Snapshot(2, 0)
    if snapshot == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    pids = []
    try:
        entry = Entry()
        entry.dwSize = ctypes.sizeof(entry)
        more = kernel.Process32FirstW(snapshot, ctypes.byref(entry))
        while more:
            if entry.exe.casefold() == 'codex.exe':
                pids.append(str(entry.pid))
            more = kernel.Process32NextW(snapshot, ctypes.byref(entry))
        if ctypes.get_last_error() != 18:  # ERROR_NO_MORE_FILES
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        kernel.CloseHandle(snapshot)
    if pids:
        raise CodexRunningError('Codex ещё работает (PID: ' + ', '.join(pids) +
                           '). Полностью закрой Desktop и другие экземпляры Codex, затем повтори.')


def normalized_path(path):
    text = str(path.resolve(strict=True))
    if text.startswith('\\\\?\\UNC\\'):
        text = '\\\\' + text[8:]
    elif text.startswith('\\\\?\\'):
        text = text[4:]
    return Path(text)


def interactive(home, list_only=False, engine='python', workers=4):
    from codex_provider_groups import interactive as group_ui
    group_ui(home, list_only, engine, workers)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, default=Path(os.environ.get('CODEX_HOME', Path.home()/'.codex')))
    parser.add_argument('--list', action='store_true', help='Только показать задачи, без записи')
    parser.add_argument('--self-test', action='store_true', help='Изолированные тесты, без пользовательских данных')
    parser.add_argument('--engine', choices=['auto','python','rust'], default='auto', help='auto: Rust, если собран; иначе Python')
    parser.add_argument('--workers', type=int, default=min(8,os.cpu_count() or 1), help='Параллельных файлов (1–32)')
    args = parser.parse_args()
    if args.self_test:
        from test_codex_provider_groups import run
        run()
    else:
        from codex_provider_migration import RUST
        engine=('rust' if RUST.exists() else 'python') if args.engine=='auto' else args.engine
        interactive(args.home.resolve(), args.list, engine, args.workers)


if __name__ == '__main__':
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print('\nОтменено.')
    except Exception as error:
        print(f'Ошибка: {error}', file=sys.stderr)
        sys.exit(1)
