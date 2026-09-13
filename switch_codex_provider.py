"""Change saved Codex task providers and the default provider in config.toml.

Windows, Python 3.11+. No model requests, no CLI chat, no backup files.
Run --self-test for isolated tests or --list for a read-only task listing.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import closing
import datetime as dt
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import tempfile
import tomllib
import time

PROVIDER_VALUE = re.compile(rb'("model_provider"\s*:\s*)(?:"(?:\\.|[^"\\])*"|null)')
OFFSET_COLUMNS = {
    'thread_turns': ('rollout_byte_offset', 'rollout_end_byte_offset'),
    'thread_history_projection_state': ('next_rollout_byte_offset',),
}


class CodexRunningError(RuntimeError):
    pass


def read_only(path):
    return sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=5)


def read_settings(home):
    with (home / 'config.toml').open('rb') as file:
        config = tomllib.load(file)
    database_dir = Path(config.get('sqlite_home', home)).expanduser()
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


def list_tasks(database, archived=False, search=''):
    with closing(read_only(database)) as connection:
        connection.row_factory = sqlite3.Row
        rows = connection.execute('''
            SELECT id, COALESCE(NULLIF(name, ''), NULLIF(title, ''), '(без названия)') AS label,
                   cwd, model_provider, model, updated_at, rollout_path, archived, history_mode
            FROM threads WHERE archived = ?
            ORDER BY updated_at DESC, id
        ''', (int(archived),)).fetchall()
    query = search.casefold()
    return [dict(row) for row in rows if not query or query in
            ' '.join(str(row[key] or '') for key in ('label', 'cwd', 'id')).casefold()]


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


def plan_rollout(path, thread_id, provider):
    """The first record owns this task; later session_meta records belong to copied history."""
    with path.open('rb') as file:
        raw = file.readline(16 * 1024 * 1024)
    if not raw.endswith(b'\n'):
        raise RuntimeError('Заголовок истории отсутствует, повреждён или превышает 16 МиБ.')
    record = json.loads(raw)
    payload = record.get('payload', {})
    if record.get('type') != 'session_meta' or payload.get('id') != thread_id:
        raise RuntimeError('ID в первом заголовке истории не совпадает с выбранной задачей.')
    if payload.get('model_provider') == provider:
        return {}, [], []
    if len(PROVIDER_VALUE.findall(raw)) != 1:
        raise RuntimeError('Неоднозначная структура model_provider; запись отменена.')
    replacement = PROVIDER_VALUE.sub(
        lambda match: match[1] + json.dumps(provider).encode('ascii'), raw)
    expected = {**record, 'payload': {**payload, 'model_provider': provider}}
    if json.loads(replacement) != expected:
        raise RuntimeError('Изменение затрагивает другие метаданные; запись отменена.')
    return {0: (raw, replacement)}, [len(raw)], [len(replacement) - len(raw)]


def rewrite(path, replacements, original_stat, replace=True):
    """Atomic file replacement. The temporary file is the NEW history, not a backup."""
    descriptor, temporary = tempfile.mkstemp(prefix='.codex-provider-', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as target, path.open('rb') as source:
            target.write(replacements.get(0, source.readline()))
            shutil.copyfileobj(source, target, length=8 * 1024 * 1024)
            target.flush()
            os.fsync(target.fileno())
        os.utime(temporary, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
        if replace:
            os.replace(temporary, path)
        else:
            staged, temporary = temporary, None
            return staged
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def normalized_path(path):
    text = str(path.resolve(strict=True))
    if text.startswith('\\\\?\\UNC\\'):
        text = '\\\\' + text[8:]
    elif text.startswith('\\\\?\\'):
        text = text[4:]
    return Path(text)


def prepare(home, selected, provider):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', provider):
        raise RuntimeError('Некорректный ID провайдера.')
    path = Path(selected['rollout_path']).resolve(strict=True)
    canonical = normalized_path(path)
    allowed = [normalized_path(home / folder) for folder in ('sessions', 'archived_sessions')
               if (home / folder).exists()]
    if not any(canonical.is_relative_to(folder) for folder in allowed):
        raise RuntimeError('Файл истории находится вне sessions/archived_sessions; запись отменена.')
    original_stat = path.stat()
    changes, boundaries, deltas = plan_rollout(path, selected['id'], provider)
    staged = rewrite(path, {0: changes[0][1]}, original_stat, replace=False) if changes else None
    suffix = re.search(r'_([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})\.jsonl$', path.name)
    rollout_id = suffix.group(1) if suffix else selected['id']
    return {'row': selected, 'path': path, 'stat': original_stat, 'changes': changes,
            'boundary': boundaries[0] if boundaries else 0, 'delta': deltas[0] if deltas else 0,
            'staged': staged, 'rollout_id': rollout_id}


def writer_connection(database_dir):
    database = database_dir / 'state_5.sqlite'
    history = database_dir / 'thread_history_1.sqlite'
    connection = sqlite3.connect(database.resolve().as_uri() + '?mode=rw', uri=True, timeout=5)
    try:
        if history.exists():
            connection.execute('ATTACH DATABASE ? AS history', (str(history),))
        return connection
    except BaseException:
        connection.close()
        raise


def apply_prepared(connection, prepared, provider, check_closed):
    selected, path = prepared['row'], prepared['path']
    original_stat, changes = prepared['stat'], prepared['changes']
    delta, boundary = prepared['delta'], prepared['boundary']
    changed_file = False
    try:
        connection.execute('BEGIN IMMEDIATE')
        current = connection.execute(
            'SELECT model_provider, rollout_path, archived FROM threads WHERE id = ?', (selected['id'],)).fetchone()
        if current != (selected['model_provider'], selected['rollout_path'], selected['archived']):
            raise RuntimeError('Задача изменилась после выбора. Обнови список и выбери её заново.')

        history_attached = any(row[1] == 'history' for row in connection.execute('PRAGMA database_list'))
        if not history_attached and selected['history_mode'] == 'paginated':
            raise RuntimeError('Отсутствует thread_history_1.sqlite для постраничной истории.')
        if history_attached and delta:
            for table, columns in OFFSET_COLUMNS.items():
                schema = {row[1] for row in connection.execute(f'PRAGMA history.table_info({table})')}
                if not schema:
                    if selected['history_mode'] == 'paginated':
                        raise RuntimeError(f'Не найдена таблица индексов {table}.')
                    continue
                if not set(columns).issubset(schema) or 'thread_id' not in schema:
                    raise RuntimeError(f'Неожиданная схема {table}; запись отменена.')
                # Existing cursors may be stale/beyond EOF. Shift their coordinates without
                # interpreting them as file reads or trying to repair pre-existing projections.
                assignments = ', '.join(f'{column} = CASE WHEN {column} >= ? THEN {column} + ? ELSE {column} END'
                                        for column in columns)
                connection.execute(f'UPDATE history.{table} SET {assignments} WHERE thread_id = ?',
                                   (*([boundary, delta] * len(columns)), prepared['rollout_id']))
        if selected['model_provider'] != provider:
            connection.execute('UPDATE threads SET model_provider = ? WHERE id = ?',
                               (provider, selected['id']))
        check_closed()
        now = path.stat()
        if (now.st_size, now.st_mtime_ns) != (original_stat.st_size, original_stat.st_mtime_ns):
            raise RuntimeError('Файл истории изменился во время подготовки; запись отменена.')
        if changes:
            os.replace(prepared['staged'], path)
            prepared['staged'] = None
            changed_file = True
        connection.commit()
    except BaseException:
        connection.rollback()
        if changed_file:
            # Recover from an ordinary write/commit failure using only original metadata in RAM.
            rewrite(path, {number: pair[0] for number, pair in changes.items()}, original_stat)
        raise
    finally:
        discard(prepared)
    return bool(changes) or selected['model_provider'] != provider


def discard(prepared):
    if prepared['staged'] and os.path.exists(prepared['staged']):
        os.unlink(prepared['staged'])
        prepared['staged'] = None


def migrate(home, database_dir, selected, provider, check_closed=ensure_codex_closed):
    check_closed()
    prepared = prepare(home, selected, provider)
    try:
        with closing(writer_connection(database_dir)) as connection:
            return apply_prepared(connection, prepared, provider, check_closed)
    finally:
        discard(prepared)


def migrate_many(home, database_dir, rows, provider, check_closed=ensure_codex_closed, report=print):
    counts = {'changed': 0, 'unchanged': 0, 'failed': 0, 'remaining': len(rows)}
    started = time.perf_counter()
    workers = min(len(rows), os.cpu_count() or 1) or 1
    try:
        check_closed()
        report(f'Параллельное копирование: {workers} потоков. SQLite: один писатель. Разбираются только заголовки.')
        with closing(writer_connection(database_dir)) as connection, ThreadPoolExecutor(max_workers=workers) as executor:
            # Bound staged disk usage to one window instead of submitting every large history.
            for start in range(0, len(rows), workers):
                futures = {executor.submit(prepare, home, row, provider): row for row in rows[start:start+workers]}
                try:
                    for future in as_completed(futures):
                        row = futures[future]
                        number = len(rows) - counts['remaining'] + 1
                        try:
                            changed = apply_prepared(connection, future.result(), provider, check_closed)
                            counts['changed' if changed else 'unchanged'] += 1
                            status = 'изменён' if changed else 'уже установлен'
                            report(f"[{number}/{len(rows)}] {status}: {short(row['label'])} [{row['id']}]")
                        except CodexRunningError:
                            raise
                        except (RuntimeError, OSError, sqlite3.Error, ValueError) as error:
                            counts['failed'] += 1
                            report(f"[{number}/{len(rows)}] ОШИБКА: {short(row['label'])} [{row['id']}]: {error}")
                        counts['remaining'] -= 1
                finally:
                    for future in futures:
                        if not future.cancel():
                            try:
                                prepared = future.result()
                            except BaseException:
                                continue
                            discard(prepared)
    except CodexRunningError as error:
        report(f'Массовая смена остановлена: {error}')
    report(f'Время: {time.perf_counter() - started:.2f} с.')
    return counts


def short(text, limit=96):
    text = ' '.join(str(text or '').split())
    return text if len(text) <= limit else text[:limit-1] + '…'


def display(rows, start=0, count=15):
    for index, row in enumerate(rows[start:start+count], start+1):
        date = dt.datetime.fromtimestamp(row['updated_at']).strftime('%d.%m.%Y %H:%M')
        print(f"\n{index:3}. {short(row['label'])}")
        print(f"     {date} | {row['model_provider']} | {short(row['cwd'], 90)}")


def interactive(home, list_only=False):
    config, database_dir = read_settings(home)
    database = database_dir / 'state_5.sqlite'
    providers = ['factory', 'openai'] + sorted(set(config.get('model_providers', {})) - {'factory', 'openai'})
    providers = [name for name in providers if name == 'openai' or name in config.get('model_providers', {})]
    archived, query, page = False, '', 0
    print('Смена провайдера сохранённых задач Codex Desktop')
    print('Названия на русском поддерживаются. Выбор по номеру, запись строго по ID.')
    print('Без резервных копий. Сообщения, название и модель не меняются.')
    print('После успешной смены задач выбранный провайдер также устанавливается в config.toml.')
    while True:
        rows = list_tasks(database, archived, query)
        if list_only:
            display(rows, count=len(rows))
            return
        pages = max(1, (len(rows)+14)//15)
        page = min(page, pages-1)
        print(f"\n{'Архив' if archived else 'Активные задачи'}: {len(rows)} | страница {page+1}/{pages} | поиск: {query or 'нет'}")
        display(rows, page*15)
        choice = input('\nНомер | all ВСЕ неархивированные | n далее | p назад | /текст поиск | / сброс | a архив | q выход: ').strip()
        if choice.lower() == 'q':
            return
        if choice.lower() in ('n', 'p'):
            page = max(0, min(pages-1, page + (1 if choice.lower() == 'n' else -1)))
            continue
        if choice.lower() == 'a':
            archived, page = not archived, 0
            continue
        if choice.startswith('/'):
            query, page = choice[1:].strip(), 0
            continue
        batch = choice.lower() == 'all'
        if batch:
            targets = list_tasks(database, archived=False)
            if not targets:
                print('Нет неархивированных задач.')
                continue
            print(f'\nВыбраны ВСЕ неархивированные задачи: {len(targets)}.')
            print('Поиск, текущая страница и просмотр архива НЕ ограничивают этот набор.')
            print('Архивные задачи не будут изменены.')
            for name in sorted({row['model_provider'] for row in targets}):
                print(f"  {name}: {sum(row['model_provider'] == name for row in targets)}")
        elif not choice.isdecimal() or not 1 <= int(choice) <= len(rows):
            print('Введи номер из списка.')
            continue
        else:
            row = rows[int(choice)-1]
            print(f"\nНазвание: {row['label']}\nID: {row['id']}\nПроект: {row['cwd']}\nМодель: {row['model'] or '(не указана)'}\nПровайдер: {row['model_provider']}")
        for index, name in enumerate(providers, 1):
            print(f'{index}. {name}')
        answer = input('Новый провайдер — номер (Enter: отмена): ').strip()
        if not answer:
            continue
        if not answer.isdecimal() or not 1 <= int(answer) <= len(providers):
            print('Некорректный номер провайдера.')
            continue
        provider = providers[int(answer)-1]
        if batch:
            print(f'\nВсе {len(targets)} неархивированных задач → {provider}')
        else:
            print(f"\n{row['label']}\n{row['id']}\n{row['model_provider']} → {provider}")
        print(f'config.toml: провайдер по умолчанию → {provider}')
        if input('Полностью закрой Codex. Выполнить запись без резервной копии? [y/n]: ').strip().casefold() != 'y':
            print('Отменено.')
            continue
        try:
            config_plan = plan_config_provider(home, provider)
            if batch:
                result = migrate_many(home, database_dir, targets, provider)
                print(f"\nИтог: изменено {result['changed']}; уже установлено {result['unchanged']}; "
                      f"ошибок {result['failed']}; не обработано {result['remaining']}.")
                print('Архивные задачи не затронуты. Успешные изменения уже сохранены.')
                if result['failed'] or result['remaining']:
                    print('config.toml не изменён: не все выбранные задачи обработаны успешно.')
                    continue
            else:
                changed = migrate(home, database_dir, row, provider)
                print('Провайдер задачи изменён.' if changed else 'У задачи этот провайдер уже установлен.')
            write_config_provider(config_plan)
            print(f'Готово. config.toml: model_provider = "{provider}". Можно открыть Desktop.')
        except (RuntimeError, OSError, sqlite3.Error, ValueError) as error:
            print(f'Ошибка: {error}. Уже выполненные изменения задач сохранены.')


def self_test():
    """Isolated fixtures: duplicate Russian titles, multiple metadata rows, offsets, rollback."""
    with tempfile.TemporaryDirectory(prefix='codex-provider-test-') as directory:
        home = Path(directory)
        config_path = home / 'config.toml'
        config_text = '# Настройки\r\nmodel_provider = \'openai\' # keep comment\r\nmodel = "gpt-6-astra"\r\n[profiles.other]\r\nmodel_provider = "openai"\r\n[model_providers.factory]\r\nname = "Factory"\r\n'
        config_path.write_bytes(config_text.encode('utf-8'))
        plan = plan_config_provider(home, 'factory')
        assert write_config_provider(plan, lambda: None)
        assert config_path.read_bytes() == config_text.replace("'openai'", '"factory"', 1).encode('utf-8')
        assert not write_config_provider(plan_config_provider(home, 'factory'), lambda: None)
        assert write_config_provider(plan_config_provider(home, 'openai'), lambda: None)
        # An absent root key must be inserted before tables, not into a profile.
        config_path.write_bytes(b'[profiles.other]\nmodel_provider = "factory"\n')
        assert write_config_provider(plan_config_provider(home, 'openai'), lambda: None)
        assert tomllib.loads(config_path.read_text()) == {'model_provider':'openai', 'profiles':{'other':{'model_provider':'factory'}}}
        config_path.write_bytes(config_text.encode('utf-8'))
        plan = plan_config_provider(home, 'factory')
        config_path.write_bytes(config_path.read_bytes() + b'# concurrent edit\r\n')
        changed_config = config_path.read_bytes()
        try:
            write_config_provider(plan, lambda: None)
        except RuntimeError:
            pass
        else:
            raise AssertionError('Concurrent config edit must abort')
        assert config_path.read_bytes() == changed_config
        def app_running():
            raise CodexRunningError('Simulated open Desktop')
        try:
            write_config_provider(plan_config_provider(home, 'factory'), app_running)
        except CodexRunningError:
            pass
        else:
            raise AssertionError('Open Desktop must block config changes')
        assert config_path.read_bytes() == changed_config
        path = home / 'sessions' / 'fixture.jsonl'
        path.parent.mkdir()
        meta = lambda provider: json.dumps({'type':'session_meta','payload':{'id':'test-id','model_provider':provider,'base_instructions':'Preserve me'}},separators=(',',':')).encode()+b'\n'
        user = json.dumps({'type':'response_item','payload':{'role':'user','content':'Не менять "model_provider": "openai"'}},ensure_ascii=False).encode()+b'\n'
        lines = [meta('openai'), user, meta('codex-lb').replace(b'test-id', b'parent-id'),
                 b'{"type":"event_msg","payload":{"text":"unchanged"}}\n']
        original = b''.join(lines)
        path.write_bytes(original)
        database = home / 'state_5.sqlite'
        with closing(sqlite3.connect(database)) as c, c:
            c.execute('CREATE TABLE threads(id TEXT PRIMARY KEY,name TEXT,title TEXT,cwd TEXT,model_provider TEXT,model TEXT,updated_at INTEGER,rollout_path TEXT,archived INTEGER,history_mode TEXT)')
            for tid in ['test-id','other-id']:
                stored_path = '\\\\?\\' + str(path) if os.name == 'nt' and tid == 'test-id' else str(path)
                c.execute('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)',(tid,'Одинаковое название','fallback',str(home),'openai','gpt-6-astra',123,stored_path,0,'paginated'))
        history = home / 'thread_history_1.sqlite'
        with closing(sqlite3.connect(history)) as c, c:
            c.execute('CREATE TABLE thread_turns(thread_id TEXT,rollout_byte_offset INTEGER,rollout_end_byte_offset INTEGER)')
            c.execute('CREATE TABLE thread_history_projection_state(thread_id TEXT,next_rollout_byte_offset INTEGER)')
            c.executemany('INSERT INTO thread_turns VALUES(?,?,?)',[('test-id',len(lines[0]),len(original)),('other-id',7,9)])
            c.execute('INSERT INTO thread_turns VALUES(?,?,?)',('test-id',len(original)+10000,None))
            c.execute('INSERT INTO thread_history_projection_state VALUES(?,?)',('test-id',len(original)))
        rows = list_tasks(database,search='ОДИНАКОВОЕ')
        assert len(rows) == 2
        row = next(row for row in rows if row['id']=='test-id')
        assert migrate(home,home,row,'factory',lambda:None)
        updated = path.read_bytes().splitlines(keepends=True)
        assert updated[1] == lines[1] and updated[3] == lines[3]
        assert json.loads(updated[0])['payload']['model_provider']=='factory'
        assert updated[2]==lines[2]  # Copied parent history is not this task's identity.
        with closing(read_only(history)) as c:
            assert c.execute("SELECT rollout_byte_offset,rollout_end_byte_offset FROM thread_turns WHERE thread_id='test-id'").fetchone() == (len(updated[0]),len(b''.join(updated)))
            assert c.execute("SELECT rollout_byte_offset,rollout_end_byte_offset FROM thread_turns WHERE thread_id='other-id'").fetchone() == (7,9)
            assert c.execute("SELECT rollout_byte_offset FROM thread_turns WHERE thread_id='test-id' AND rollout_end_byte_offset IS NULL").fetchone()[0] == len(original)+10001
        with closing(read_only(database)) as c:
            assert c.execute("SELECT model_provider FROM threads WHERE id='other-id'").fetchone()[0]=='openai'
        row = next(row for row in list_tasks(database) if row['id']=='test-id')
        before_failure = path.read_bytes()
        calls = [0]
        def interrupted():
            calls[0] += 1
            if calls[0] == 2:
                raise RuntimeError('Simulated application startup before write')
        try:
            migrate(home,home,row,'openai',interrupted)
        except RuntimeError:
            pass
        else:
            raise AssertionError('Expected abort')
        assert path.read_bytes()==before_failure
        assert next(r for r in list_tasks(database) if r['id']=='test-id')['model_provider']=='factory'
        assert migrate(home,home,row,'openai',lambda:None)
        # Simulate failure after replacing the file but before committing SQLite.
        row = next(row for row in list_tasks(database) if row['id']=='test-id')
        before_failure = path.read_bytes()
        class FailCommit(sqlite3.Connection):
            def commit(self):
                raise sqlite3.OperationalError('Simulated commit failure')
        prepared = prepare(home,row,'factory')
        with closing(sqlite3.connect(database,factory=FailCommit)) as c:
            c.execute('ATTACH DATABASE ? AS history',(str(history),))
            try:
                apply_prepared(c,prepared,'factory',lambda:None)
            except sqlite3.OperationalError:
                pass
            else:
                raise AssertionError('Expected commit failure')
        assert path.read_bytes()==before_failure
        assert next(r for r in list_tasks(database) if r['id']=='test-id')['model_provider']=='openai'
        # Bulk selection spans multiple pages and excludes archived tasks.
        with closing(sqlite3.connect(database)) as c, c:
            for tid in ['other-id', 'archived-id'] + [f'batch-{i}' for i in range(16)]:
                provider = 'factory' if tid == 'other-id' else 'openai'
                fixture = path.parent / (tid + '.jsonl')
                fixture.write_bytes(meta(provider).replace(b'test-id',tid.encode()) + user)
                c.execute('INSERT OR REPLACE INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)',
                          (tid,'Архив' if tid=='archived-id' else 'Другой диалог','',str(home),provider,
                           'gpt-6-astra',124,str(fixture),int(tid=='archived-id'),'paginated'))
            c.execute('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)',
                      ('missing-id','Отсутствующая история','',str(home),'openai','gpt-6-astra',999,
                       str(path.parent/'missing.jsonl'),0,'paginated'))
        archive = path.parent/'archived-id.jsonl'
        archived_bytes = archive.read_bytes()
        targets = list_tasks(database,archived=False)
        assert len(targets)>15 and all(not r['archived'] for r in targets)
        assert len(list_tasks(database,search='Одинаковое')) < len(targets)
        counts = migrate_many(home,home,targets,'factory',lambda:None,lambda message:None)
        assert counts == {'changed':17,'unchanged':1,'failed':1,'remaining':0},counts
        assert archive.read_bytes()==archived_bytes
        assert list_tasks(database,archived=True)[0]['model_provider']=='openai'
        assert all(r['model_provider']=='factory' for r in list_tasks(database) if r['id']!='missing-id')
        # A task archived after selection must not be changed by the pending batch.
        stale = next(r for r in list_tasks(database) if r['id']=='batch-0')
        stale_bytes = Path(stale['rollout_path']).read_bytes()
        with closing(sqlite3.connect(database)) as c, c:
            c.execute('UPDATE threads SET archived=1 WHERE id=?',(stale['id'],))
        counts = migrate_many(home,home,[stale],'openai',lambda:None,lambda message:None)
        assert counts['failed']==1 and Path(stale['rollout_path']).read_bytes()==stale_bytes
        def running():
            raise CodexRunningError('Simulated open Desktop')
        counts = migrate_many(home,home,targets,'openai',running,lambda message:None)
        assert counts == {'changed':0,'unchanged':0,'failed':0,'remaining':len(targets)}
        # Fork/revert rollouts use their filename suffix as the cache key.
        suffix_id = '11111111-2222-3333-4444-555555555555'
        suffix_path = path.parent / f'rollout-2026-09-06T00-00-00-test-id_{suffix_id}.jsonl'
        suffix_path.write_bytes(original)
        with closing(sqlite3.connect(database)) as c, c:
            c.execute('UPDATE threads SET rollout_path=?,model_provider=? WHERE id=?', (str(suffix_path), 'openai', 'test-id'))
        with closing(sqlite3.connect(history)) as c, c:
            stable_before = c.execute('SELECT rollout_byte_offset,rollout_end_byte_offset FROM thread_turns WHERE thread_id=?', ('test-id',)).fetchall()
            c.execute('INSERT INTO thread_turns VALUES(?,?,?)', (suffix_id, len(lines[0]), len(original)))
            c.execute('INSERT INTO thread_history_projection_state VALUES(?,?)', (suffix_id, len(original)))
        selected = next(r for r in list_tasks(database) if r['id'] == 'test-id')
        assert migrate(home,home,selected,'factory',lambda:None)
        with closing(read_only(history)) as c:
            assert c.execute('SELECT rollout_byte_offset,rollout_end_byte_offset FROM thread_turns WHERE thread_id=?', ('test-id',)).fetchall() == stable_before
            assert c.execute('SELECT rollout_byte_offset,rollout_end_byte_offset FROM thread_turns WHERE thread_id=?', (suffix_id,)).fetchone() == (len(lines[0])+1, len(original)+1)
        assert not list(path.parent.glob('*.tmp'))
        assert not list(home.rglob('*.bak'))
    print('PASS: config default provider, preserved profiles/comments/newlines, concurrent-edit guard; extended Windows paths, copied parent metadata, stale offsets, unchanged messages, file/DB rollback, parallel bulk, archive exclusion and open Desktop guard; no backups.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, default=Path(os.environ.get('CODEX_HOME', Path.home()/'.codex')))
    parser.add_argument('--list', action='store_true', help='Только показать задачи, без записи')
    parser.add_argument('--self-test', action='store_true', help='Изолированные тесты, без пользовательских данных')
    args = parser.parse_args()
    if args.self_test:
        self_test()
    else:
        interactive(args.home.resolve(), args.list)


if __name__ == '__main__':
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print('\nОтменено.')
    except Exception as error:
        print(f'Ошибка: {error}', file=sys.stderr)
        sys.exit(1)
