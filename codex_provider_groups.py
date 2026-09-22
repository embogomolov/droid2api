"""Read Codex task families; switch them offline with recoverable metadata writes."""
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager
import base64
import json
import os
from pathlib import Path
import re
import sqlite3
import shutil
import textwrap
import time

import switch_codex_provider as core

JOURNAL = '.provider-switch.pending.json'
UUID = re.compile(r'([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})\.jsonl$')


def history_roots(home):
    return [core.normalized_path(home / name) for name in ('sessions', 'archived_sessions')
            if (home / name).exists()]


def checked_path(path, roots):
    path = core.normalized_path(Path(path))
    if not any(path.is_relative_to(root) for root in roots):
        raise RuntimeError('История за пределами каталогов Codex.')
    return path


def read_header(path):
    stat = path.stat()
    with path.open('rb') as file:
        raw = file.readline(16 * 1024 * 1024)
    if not raw.endswith(b'\n'):
        raise ValueError('Неполный или слишком большой заголовок истории.')
    record = json.loads(raw)
    if record.get('type') != 'session_meta' or not record.get('payload', {}).get('id'):
        raise ValueError('Нет идентификатора в session_meta.')
    after = path.stat()
    if (stat.st_size, stat.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError('История обновляется; обнови список после закрытия Codex.')
    meta = record['payload']
    match = UUID.search(path.name)
    return dict(path=path, raw=raw, record=record, owner=meta['id'],
                physical=match[1] if match else meta['id'], stat=stat)


def source_parent(source):
    try:
        source = json.loads(source) if isinstance(source, str) else source
        return source.get('subagent', {}).get('thread_spawn', {}).get('parent_thread_id')
    except (ValueError, AttributeError, TypeError):
        return None


def catalog(home, database_dir):
    """One database snapshot and one parallel header pass; no message-body reads."""
    started = time.perf_counter()
    with closing(core.read_only(database_dir / 'state_5.sqlite')) as db:
        db.execute('BEGIN')
        db.row_factory = sqlite3.Row
        available = {r['name'] for r in db.execute('PRAGMA table_info(threads)')}
        wanted = ['id', 'name', 'title', 'cwd', 'model_provider', 'model', 'updated_at',
                  'rollout_path', 'archived', 'history_mode', 'source', 'thread_source']
        rows = {r['id']: dict(r) for r in db.execute('SELECT '+','.join(k for k in wanted if k in available)+' FROM threads')}
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        edges = list(db.execute('SELECT parent_thread_id,child_thread_id FROM thread_spawn_edges')) if 'thread_spawn_edges' in tables else []
    roots = history_roots(home)
    graph = defaultdict(set)
    parents = defaultdict(set)
    errors = defaultdict(list)
    paths = set()
    for root in roots:
        paths.update(core.normalized_path(p) for p in root.rglob('*.jsonl'))
    for row in rows.values():
        row['label'] = row.get('name') or row.get('title') or '(без названия)'
        row.setdefault('history_mode', None)
        row['subagent'] = row.get('thread_source') == 'subagent' or bool(source_parent(row.get('source')))
        try:
            row['path'] = checked_path(row['rollout_path'], roots)
            paths.add(row['path'])
        except (OSError, RuntimeError) as error:
            # Native archive can leave a stale path until Codex's next read repair.
            # Resolve only the exact physical filename, never by title/logical ID.
            matches = [p for p in paths if p.name == Path(row['rollout_path']).name]
            if len(matches) == 1:
                row['path'] = checked_path(matches[0], roots)
            else:
                errors[row['id']].append(str(error))

    def read(path):
        try:
            return path, read_header(path), None
        except (OSError, ValueError) as error:
            return path, None, str(error)
    files, physical = {}, {}
    unknown_errors = []
    with ThreadPoolExecutor(max_workers=min(16, os.cpu_count() or 1)) as pool:
        for path, info, error in pool.map(read, sorted(paths)):
            if error:
                owners = [r['id'] for r in rows.values() if r.get('path') == path]
                if owners:
                    for owner in owners: errors[owner].append(error)
                else: unknown_errors.append('Не удалось определить владельца файла '+path.name)
                continue
            files[path] = info
            if info['physical'] in physical:
                unknown_errors.append('Повторяющийся идентификатор файла истории: '+info['physical'])
            physical[info['physical']] = info

    def link(parent, child):
        if isinstance(parent, str) and parent and parent != child:
            graph[parent].add(child); graph[child].add(parent); parents[child].add(parent)
    for parent, child in edges: link(parent, child)
    for row in rows.values(): link(source_parent(row.get('source')), row['id'])
    for info in files.values():
        meta, owner = info['record']['payload'], info['owner']
        link(source_parent(meta.get('source')), owner)
        link(meta.get('parent_thread_id'), owner)
        link(meta.get('forked_from_id'), owner)
        link(meta.get('session_id'), owner)
        base = meta.get('history_base')
        if base:
            dependency = physical.get(base.get('thread_id'))
            if dependency: link(dependency['owner'], owner)
            else: errors[owner].append('Не найден файл базовой истории.')
    for row in rows.values():
        info = files.get(row.get('path'))
        if info and info['owner'] != row['id']:
            errors[row['id']].append('ID записи не совпадает с владельцем файла истории.')
        if errors[row['id']] and row['subagent'] and not parents[row['id']]:
            unknown_errors.append('Не удалось определить родителя повреждённой дочерней задачи: '+row['id'])

    seen, groups = set(), []
    for tid in rows:
        if tid in seen: continue
        stack, family = [tid], set()
        while stack:
            node = stack.pop()
            if node in family: continue
            family.add(node); stack.extend(graph[node] - family)
        seen.update(family)
        members = [rows[k] for k in family if k in rows]
        candidates = [r for r in members if not r['subagent'] and not parents[r['id']]]
        candidates = candidates or [r for r in members if not r['subagent']] or members
        root = min(candidates, key=lambda r: (r.get('updated_at') or 0, r['id']))
        issues = list(unknown_errors)
        for node in family: issues.extend(errors[node])
        if all(r['subagent'] for r in members): issues.append('Основной диалог не найден; связь требует проверки.')
        family_files = [f for f in files.values() if f['owner'] in family]
        groups.append(dict(root=root, rows=members, ids=family, files=family_files,
                           archived=all(r['archived'] for r in members), issues=sorted(set(issues)),
                           updated=max(r.get('updated_at') or 0 for r in members)))
    groups.sort(key=lambda g: (-g['updated'], g['root']['id']))
    return dict(groups=groups, rows=rows, files=files, physical=physical,
                seconds=time.perf_counter()-started, unknown_errors=unknown_errors)


@contextmanager
def exclusive(home):
    with (home / '.provider-switch.lock').open('a+b') as file:
        file.seek(0, 2)
        if not file.tell(): file.write(b'0'); file.flush()
        file.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error: raise RuntimeError('Другой экземпляр утилиты выполняет запись.') from error
        try: yield
        finally:
            file.seek(0)
            if os.name == 'nt': msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)
            else: fcntl.flock(file, fcntl.LOCK_UN)


def atomic_json(path, data):
    temporary = path.with_suffix('.tmp')
    try:
        with temporary.open('w', encoding='utf-8') as file:
            json.dump(data, file, ensure_ascii=False, separators=(',', ':'))
            file.flush(); os.fsync(file.fileno())
        os.replace(temporary, path)
    finally: temporary.unlink(missing_ok=True)


# Verified against openai/codex b5bffd3ec4db487e7e3dec59663875b0ef7b72ca:
# app-server/.../thread_processor.rs merge_persisted_resume_metadata reads SQLite.
# thread-store/src/local/read_thread.rs uses SQLite display metadata for paginated history.
# Legacy display metadata can come from JSONL; do not silently apply this migration to it.

def check_rows(db, rows, provider=None):
    for row in rows:
        current = db.execute('SELECT model_provider,rollout_path,archived,history_mode FROM threads WHERE id=?',(row['id'],)).fetchone()
        expected = (row['model_provider'],row['rollout_path'],row['archived'],row['history_mode'])
        allowed = [expected] if provider is None else [expected,(provider,*expected[1:])]
        if current not in allowed: raise RuntimeError('Запись задачи изменилась вне утилиты; операция остановлена.')


def restore_v2(home, database_dir, check_closed=core.ensure_codex_closed):
    check_closed()
    journal = home/JOURNAL
    if not journal.exists(): return False
    data = json.loads(journal.read_text(encoding='utf-8'))
    if data.get('version') != 2 or Path(data['database_dir']).resolve() != database_dir.resolve():
        raise RuntimeError('Журнал относится к другой базе или версии утилиты; автоматическое восстановление остановлено.')
    old,new = (base64.b64decode(data[k]) for k in ('config_old','config_new'))
    path = home/'config.toml'
    if path.read_bytes() not in (old,new): raise RuntimeError('config.toml изменён вне утилиты; восстановление остановлено.')
    with closing(sqlite3.connect(database_dir/'state_5.sqlite',timeout=5)) as db:
        db.execute('BEGIN IMMEDIATE')
        try:
            check_rows(db,data['rows'],data['provider'])
            check_closed()
            db.executemany('UPDATE threads SET model_provider=? WHERE id=?',[(r['model_provider'],r['id']) for r in data['rows']])
            core.write_config_provider((path,path.read_bytes(),old),check_closed)
            db.commit()
        except BaseException:
            db.rollback(); raise
    journal.unlink()
    return True


def switch(*args, **kwargs):
    from codex_provider_migration import migrate
    return migrate(*args, **kwargs)


def restore(home, database_dir, check_closed=core.ensure_codex_closed):
    from codex_provider_migration import recover
    return recover(home, database_dir, check_closed)



def line(text='', indent=''):
    width = max(24, shutil.get_terminal_size((100, 30)).columns-2)
    print(textwrap.fill(str(text), width=width, initial_indent=indent,
                        subsequent_indent=indent, replace_whitespace=True) if text else '')


def display(groups, start=0, count=None):
    for number, group in enumerate(groups[start:start+count if count else None], start+1):
        root = group['root']
        providers = ', '.join(sorted({r['model_provider'] or '(не указан)' for r in group['rows']}))
        line(f'{number:>3}  {root["label"]}')
        line(f'{providers}  ·  связанных задач: {len(group["rows"])-1}  ·  архивных: {sum(r["archived"] for r in group["rows"])}', '     ')
        line(root.get('cwd') or '(проект не указан)', '     ')
        if group['issues']: line('ТРЕБУЕТ ПРОВЕРКИ: '+'; '.join(group['issues']), '     ')
        line()


def interactive(home, list_only=False, engine='python', workers=4):
    config, database_dir = core.read_settings(home)
    data = catalog(home, database_dir)
    if list_only:
        line(f'Основных диалогов: {len(data["groups"])} · записей задач: {len(data["rows"])} · чтение: {data["seconds"]:.2f} с')
        display([g for g in data['groups'] if not g['archived']])
        if (home/JOURNAL).exists(): line('Есть незавершённая операция. Запусти утилиту без --list для восстановления.')
        return
    line('CODEX  /  Смена провайдера')
    line('Выбирай основной диалог: его субагенты, ответвления и архивные потомки включаются автоматически.')
    line('Меняется также провайдер по умолчанию в config.toml. Для записи полностью закрой Codex.')
    if (home/JOURNAL).exists():
        line('Обнаружен журнал операции. Перед продолжением нужно восстановить прерванную запись или завершить очистку уже сохранённой.')
        if input('Codex закрыт. Восстановить? [y/n]: ').strip().lower() != 'y': return
        with exclusive(home): restore(home, database_dir)
        line('Журнал обработан. Можно продолжать.')
        data = catalog(home, database_dir)
    archived, query, page = False, '', 0
    while True:
        groups = [g for g in data['groups'] if g['archived'] == archived and
                  (not query or any(query in ' '.join(str(r.get(k) or '') for k in ('label','cwd','id')).casefold() for r in g['rows']))]
        per_page = max(3, min(10, (shutil.get_terminal_size((100,36)).lines-12)//4))
        pages = max(1, (len(groups)+per_page-1)//per_page)
        page = min(page,pages-1)
        line('\n'+'─'*min(70, max(24,shutil.get_terminal_size((100,30)).columns-2)))
        line(f'{"Архивные" if archived else "Неархивированные"} диалоги: {len(groups)}  ·  страница {page+1}/{pages}  ·  поиск: {query or "—"}')
        line()
        display(groups,page*per_page,per_page)
        line('Номер — выбрать  ·  d НОМЕР — состав группы  ·  all — все неархивированные')
        line('n / p — страницы  ·  /текст — поиск  ·  a — архив  ·  r — обновить  ·  q — выход')
        choice = input('› ').strip()
        command = choice.lower()
        if command == 'q': return
        if command in ('n','p'):
            page = max(0,min(pages-1,page+(1 if command=='n' else -1))); continue
        if command == 'a': archived,page = not archived,0; continue
        if command == 'r': data = catalog(home,database_dir); continue
        if choice.startswith('/'): query,page = choice[1:].strip().casefold(),0; continue
        detail = command.startswith('d ')
        number = choice[2:].strip() if detail else choice
        if command == 'all':
            targets = [g for g in data['groups'] if not g['archived']]
            line('Выбраны ВСЕ неархивированные группы, независимо от поиска и страницы, вместе с архивными потомками.')
        elif number.isdecimal() and 1 <= int(number) <= len(groups):
            targets = [groups[int(number)-1]]
        else:
            line('Введи номер или команду из списка.'); continue
        if detail:
            group = targets[0]
            line(group['root']['label'])
            for row in sorted(group['rows'],key=lambda r:(r['id']!=group['root']['id'],r['label'],r['id'])):
                kind = 'основной' if row['id']==group['root']['id'] else 'субагент' if row['subagent'] else 'ответвление'
                line(f'{kind}{", архив" if row["archived"] else ""} · {row["model_provider"]} · {row["label"]}', '  ')
                line(row['id'], '    ')
            line(f'Файлов истории: {len(group["files"])}')
            input('Enter — назад: '); continue
        if not targets: line('Нет выбранных диалогов.'); continue
        issues = sorted({i for g in targets for i in g['issues']})
        if issues:
            line('Запись заблокирована: '+'; '.join(issues)); continue
        config, database_dir = core.read_settings(home)
        providers = sorted({'openai', *config.get('model_providers', {})},key=lambda p:(p!='factory',p!='openai',p))
        line(f'Выбрано групп: {len(targets)} · всех задач: {sum(len(g["rows"]) for g in targets)} · файлов: {sum(len(g["files"]) for g in targets)}')
        for i, provider in enumerate(providers,1): line(f'{i}. {provider}')
        answer = input('Провайдер — номер (Enter: отмена): ').strip()
        if not answer: continue
        if not answer.isdecimal() or not 1 <= int(answer) <= len(providers): line('Некорректный номер.'); continue
        provider = providers[int(answer)-1]
        line(f'Выбранные группы и config.toml → {provider}')
        line('Меняются настройки провайдера и связанные индексы. Сообщения сохраняются. Временный журнал удаляется после завершения.')
        if input('Codex полностью закрыт. Выполнить? [y/n]: ').strip().lower() != 'y': continue
        try:
            switch(home,database_dir,[g['root']['id'] for g in targets],provider,engine=engine,workers=workers)
            line('Можно открыть Codex.')
        except (RuntimeError,OSError,ValueError,sqlite3.Error) as error:
            line('Ошибка: '+str(error))
            if (home/JOURNAL).exists():
                line('Операция не завершена. Не открывай Codex; повторно запусти утилиту для восстановления.')
                return
            line('Незавершённых изменений нет.')
        data = catalog(home,database_dir)
