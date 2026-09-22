"""Offline, recoverable provider migration. JSONL payload bytes are otherwise preserved.

Storage contract: openai/codex b5bffd3ec4db487e7e3dec59663875b0ef7b72ca.
The journal is temporary transaction state, removed after success/recovery.
"""
import base64
from bisect import bisect_right
from concurrent.futures import ThreadPoolExecutor, ProcessPoolExecutor
from contextlib import closing
import json
import mmap
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess
import time
from functools import partial

import switch_codex_provider as core

MARKER = re.compile(rb'"(?:session_meta|thread_settings_applied)"')
TOKEN = re.compile(rb'"(?:[^"\\]|\\.)*"|[{}\[\]]')
ORDINAL = re.compile(rb'"ordinal"\s*:\s*(\d+)')
RUST = Path(__file__).parent/'provider_migrate_rs'/'target'/'release'/('provider-migrate.exe' if os.name=='nt' else 'provider-migrate')
BUFFER = 8 * 1024 * 1024


def candidate_positions(data):
    # One C regex pass beat two mmap.find passes in the checked-in benchmark.
    return (match.start() for match in MARKER.finditer(data))


def encode(raw): return base64.b64encode(raw).decode('ascii')
def decode(text): return base64.b64decode(text, validate=True)


def member_span(raw, keys):
    """Locate an exact JSON object path without reserializing unrelated values."""
    lo, hi = 0, len(raw)
    for key in keys:
        depth = 0
        found = None
        for match in TOKEN.finditer(raw, lo, hi):
            token = match[0]
            if token in (b'{', b'['): depth += 1
            elif token in (b'}', b']'): depth -= 1
            elif depth == 1 and json.loads(token) == key:
                colon = match.end()
                while raw[colon:colon+1] in (b' ', b'\r', b'\n', b'\t'): colon += 1
                if raw[colon:colon+1] != b':': continue
                start = colon + 1
                while raw[start:start+1] in (b' ', b'\r', b'\n', b'\t'): start += 1
                if raw[start:start+1] == b'"': end = TOKEN.match(raw, start).end()
                elif raw[start:start+1] in (b'{', b'['):
                    nested = 0
                    for part in TOKEN.finditer(raw, start, hi):
                        if part[0] in (b'{', b'['): nested += 1
                        elif part[0] in (b'}', b']'): nested -= 1
                        if nested == 0:
                            end = part.end(); break
                else:
                    end = start
                    while end < hi and raw[end:end+1] not in b',}] \t\r\n': end += 1
                if found is not None: raise ValueError('Duplicate migration field')
                found = (start, end)
        if found is None: raise ValueError('Missing migration field: '+'.'.join(keys))
        lo, hi = found
    return lo, hi


def patch(raw, keys, value, offset):
    start, end = member_span(raw, keys)
    new = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()
    return dict(start=offset+start, end=offset+end, old=encode(raw[start:end]), new=encode(new))


def scan_python(path, provider):
    """C-backed mmap search; parse only relevant records, never conversation bodies."""
    changes, bases = [], []
    with open(path, 'rb') as file, mmap.mmap(file.fileno(), 0, access=mmap.ACCESS_READ) as data:
        if data[-1:] != b'\n': raise ValueError('Incomplete rollout: '+str(path))
        previous_end = -1
        for at in candidate_positions(data):
            if at < previous_end: continue
            start = data.rfind(b'\n', 0, at)+1
            end = data.find(b'\n', at)+1
            previous_end = end
            raw = data[start:end]
            record = json.loads(raw)
            payload = record.get('payload')
            if not isinstance(payload, dict): continue
            if record.get('type') == 'session_meta':
                if payload.get('model_provider') != provider:
                    if 'model_provider' not in payload:
                        # Missing optional field: insert at the opening payload brace.
                        a, _ = member_span(raw, ['payload'])
                        content = b'"model_provider":'+json.dumps(provider).encode()+(b',' if payload else b'')
                        changes.append(dict(start=start+a+1,end=start+a+1,old='',new=encode(content)))
                    else: changes.append(patch(raw, ['payload','model_provider'], provider, start))
                if payload.get('history_base'):
                    base = payload['history_base']
                    changespan = patch(raw, ['payload','history_base','end_byte_offset'], base['end_byte_offset'], start)
                    bases.append(dict(physical=base['thread_id'], offset=base['end_byte_offset'], ordinal=base['end_ordinal_exclusive'], patch=changespan))
            elif record.get('type') == 'event_msg' and payload.get('type') == 'thread_settings_applied':
                settings = payload.get('thread_settings')
                if not isinstance(settings, dict) or 'model_provider_id' not in settings:
                    raise ValueError('Unknown thread settings schema: '+str(path))
                if settings['model_provider_id'] != provider:
                    changes.append(patch(raw, ['payload','thread_settings','model_provider_id'], provider, start))
    return dict(patches=changes, bases=bases)


def rust_call(request):
    result = subprocess.run([str(RUST)], input=json.dumps(request), text=True, encoding='utf-8', capture_output=True)
    if result.returncode: raise RuntimeError('Rust: '+result.stderr.strip())
    return json.loads(result.stdout)


def scan_python_many(paths, provider, workers, parallel='auto'):
    use_process = parallel == 'process' or (parallel == 'auto' and workers > 1 and sum(Path(p).stat().st_size for p in paths) >= 128*1024**2)
    executor = ProcessPoolExecutor if use_process else ThreadPoolExecutor
    with executor(max_workers=workers) as pool:
        return list(pool.map(partial(scan_python, provider=provider), paths))


def mapper(item):
    ends, shifts = [], []
    delta = 0
    for p in sorted(item['patches'], key=lambda p:p['start']):
        delta += len(decode(p['new']))-(p['end']-p['start'])
        ends.append(p['end']); shifts.append(delta)
    def translate(offset):
        if type(offset) != int or not 0 <= offset <= item['size']: raise ValueError('Invalid rollout offset')
        at = bisect_right(ends, offset)-1
        return offset + (shifts[at] if at >= 0 else 0)
    return translate


def check_boundary(path, offset):
    with open(path, 'rb') as f, mmap.mmap(f.fileno(),0,access=mmap.ACCESS_READ) as raw:
        if not valid_boundary(raw,offset): raise ValueError('Index is not at a complete JSONL boundary: '+str(path))


def valid_boundary(raw, offset):
    if type(offset)!=int or not 0<=offset<=len(raw): return False
    if offset==0 or raw[offset-1:offset]==b'\n': return True
    # Codex's bounded reverse reader also accepts a complete final JSON value
    # without its line terminator (rollout/reverse_jsonl_scanner.rs).
    if raw[offset:offset+1] in (b'\n',b'\r'):
        start=raw.rfind(b'\n',0,offset)+1
        try: json.loads(raw[start:offset]); return True
        except ValueError: pass
    return False


def position_matches(raw, offset, ordinal, edge):
    if not valid_boundary(raw,offset): return False
    if ordinal is None: return True
    if edge=='end' and ordinal==-1: return offset==0
    at=offset
    if edge=='end':
        while at and raw[at-1:at] in (b'\r',b'\n'): at-=1
        at=raw.rfind(b'\n',0,at)+1
    else:
        while raw[at:at+1] in (b'\r',b'\n'): at+=1
    match=ORDINAL.search(raw,at,min(len(raw),at+180))
    return match is not None and int(match[1])==ordinal


def ordinal_positions(raw, wanted):
    """Resolve only requested ordinals, validating each full candidate JSON record.

    Used for inconsistent old indices, not the common healthy migration path.
    Ambiguous or missing ordinals stop the transaction before any writes.
    """
    found={}
    for match in ORDINAL.finditer(raw):
        number=int(match[1])
        if number not in wanted: continue
        start=raw.rfind(b'\n',0,match.start())+1
        end=raw.find(b'\n',match.end())+1
        record=json.loads(raw[start:end])
        if record.get('ordinal')!=number: continue
        if number in found and found[number]!=(start,end): raise ValueError('Ambiguous rollout ordinal')
        found[number]=(start,end)
    if wanted-set(found): raise ValueError('Missing rollout ordinals; cannot safely repair index')
    return found


def plan_files(infos, provider, engine, workers):
    items = []
    paths = [str(f['path']) for f in infos]
    if engine == 'rust':
        scanned = rust_call(dict(command='scan', paths=paths, provider=provider, workers=workers))
    else:
        scanned = scan_python_many(paths, provider, workers)
    for info, scan in zip(infos, scanned):
        stat = info['path'].stat()
        if (stat.st_size,stat.st_mtime_ns) != (info['stat'].st_size,info['stat'].st_mtime_ns):
            raise RuntimeError('Rollout changed during scan')
        items.append(dict(path=str(info['path']), physical=info['physical'], size=stat.st_size,
                          mtime=stat.st_mtime_ns, atime=stat.st_atime_ns, links=stat.st_nlink,
                          has_ordinals='ordinal' in info['record'], **scan))
    by_id = {item['physical']:item for item in items}
    from collections import defaultdict, deque
    children=defaultdict(set); dependencies={}
    for item in items:
        deps={base['physical'] for base in item['bases']}
        if not deps.issubset(by_id): raise ValueError('Missing history_base in selected family')
        dependencies[item['physical']]=len(deps)
        for parent in deps: children[parent].add(item['physical'])
    ready=deque(physical for physical,count in dependencies.items() if count==0)
    complete=0
    while ready:
        physical=ready.popleft(); item=by_id[physical]
        for base in item['bases']:
            parent=by_id[base['physical']]
            offset=base['offset']
            with open(parent['path'],'rb') as f, mmap.mmap(f.fileno(),0,access=mmap.ACCESS_READ) as raw:
                # Legacy fixtures may lack ordinals; real paginated headers always have them.
                expected=base['ordinal']-1 if parent.get('has_ordinals') else None
                if not position_matches(raw,offset,expected,'end'):
                    if expected is None: raise ValueError('Invalid history_base without ordinal evidence')
                    offset=ordinal_positions(raw,{expected})[expected][1]
            new=mapper(parent)(offset)
            if new!=base['offset']:
                item['patches'].append({**base['patch'],'new':encode(str(new).encode())})
        item['patches'].sort(key=lambda p:p['start'])
        for a,b in zip(item['patches'],item['patches'][1:]):
            if a['end']>b['start']: raise ValueError('Overlapping migration fields')
        complete+=1
        for child in children[physical]:
            dependencies[child]-=1
            if dependencies[child]==0: ready.append(child)
    if complete!=len(items): raise ValueError('Cyclic history_base')
    return items


def index_updates(database_dir, items):
    path = database_dir/'thread_history_1.sqlite'
    if not path.exists(): raise ValueError('Missing paginated history database')
    specifications = {'thread_turns':['rollout_byte_offset','rollout_end_byte_offset'],
                      'thread_history_projection_state':['next_rollout_byte_offset']}
    updates = []
    with closing(core.read_only(path)) as db:
        tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        for table in tables:
            columns = {r[1] for r in db.execute('PRAGMA table_info("'+table.replace('"','""')+'")')}
            offsets = {col for col in columns if 'byte_offset' in col}
            if offsets - set(specifications.get(table, [])): raise ValueError('Unknown history offset schema: '+table)
        if not set(specifications).issubset(tables): raise ValueError('Missing history table')
        for item in items:
            translate=mapper(item)
            with open(item['path'],'rb') as f, mmap.mmap(f.fileno(),0,access=mmap.ACCESS_READ) as raw:
                pending=[]; needed=set()
                for table,columns in specifications.items():
                    available={r[1] for r in db.execute('PRAGMA table_info('+table+')')}
                    ordinal_columns=['rollout_ordinal','rollout_end_ordinal'] if table=='thread_turns' else ['next_rollout_ordinal']
                    have_ordinals=set(ordinal_columns).issubset(available) and item['has_ordinals']
                    select=columns+ordinal_columns if have_ordinals else columns
                    for row in db.execute('SELECT rowid,'+','.join(select)+' FROM '+table+' WHERE thread_id=?',(item['physical'],)):
                        old=list(row[1:1+len(columns)]); new=[]; repairs=[]
                        for i,offset in enumerate(old):
                            expected=row[1+len(columns)+i] if have_ordinals else None
                            edge='start' if columns[i]=='rollout_byte_offset' else 'end'
                            if expected is not None and columns[i]=='next_rollout_byte_offset': expected-=1
                            if offset is not None and not position_matches(raw,offset,expected,edge):
                                if expected is None: raise ValueError('Invalid history index without ordinal evidence: '+item['path'])
                                needed.add(expected); repairs.append((i,expected,edge))
                                new.append(None)
                            else: new.append(None if offset is None else translate(offset))
                        pending.append((dict(table=table,columns=columns,rowid=row[0],old=old,new=new),repairs))
                resolved=ordinal_positions(raw,needed) if needed else {}
                for update,repairs in pending:
                    for i,expected,edge in repairs: update['new'][i]=translate(resolved[expected][0 if edge=='start' else 1])
                    if update['new']!=update['old']:
                        update['repaired']=bool(repairs); updates.append(update)
    return updates


def copy_python(item):
    """Stream untouched ranges; only rewritten files allocate another file."""
    with open(item['path'],'rb',buffering=BUFFER) as src, open(item['temp'],'xb',buffering=BUFFER) as dst:
        for p in item['patches']:
            remaining = p['start']-src.tell()
            while remaining:
                chunk=src.read(min(remaining,BUFFER))
                if not chunk: raise IOError('Truncated rollout')
                dst.write(chunk); remaining-=len(chunk)
            if src.read(p['end']-p['start']) != decode(p['old']): raise RuntimeError('Rollout field changed')
            dst.write(decode(p['new']))
        shutil.copyfileobj(src,dst,BUFFER)
        dst.flush(); os.fsync(dst.fileno())


def apply_indices(db, updates, restore=False):
    for u in updates:
        current = db.execute('SELECT '+','.join(u['columns'])+' FROM '+u['table']+' WHERE rowid=?',(u['rowid'],)).fetchone()
        if current is None or list(current) not in (u['old'],u['new']): raise RuntimeError('History index changed outside migration')
        expected = u['old'] if restore else u['new']
        db.execute('UPDATE '+u['table']+' SET '+','.join(c+'=?' for c in u['columns'])+' WHERE rowid=?',(*expected,u['rowid']))


def recover(home, database_dir, check_closed):
    import codex_provider_groups as g
    journal = home/g.JOURNAL
    if not journal.exists(): return False
    data = json.loads(journal.read_text(encoding='utf-8'))
    if data.get('version') != 3: return g.restore_v2(home,database_dir,check_closed)
    check_closed()
    if Path(data['database_dir']).resolve() != database_dir.resolve(): raise RuntimeError('Recovery database mismatch')
    for item in data['files']:
        path=Path(item['path'])
        g.checked_path(path.parent,g.history_roots(home))
        if item.get('temp') != str(path)+'.provider-new' or item.get('original') != str(path)+'.provider-original':
            raise RuntimeError('Invalid recovery file path')
    if data.get('committed'):
        for item in data['files']:
            for key in ('temp','original'):
                if item.get(key): Path(item[key]).unlink(missing_ok=True)
        journal.unlink(); return True
    config = home/'config.toml'; old,new = decode(data['config_old']),decode(data['config_new'])
    if config.read_bytes() not in (old,new): raise RuntimeError('Configuration changed outside migration')
    # Check all database values before beginning recovery writes.
    with closing(sqlite3.connect(database_dir/'state_5.sqlite')) as state, closing(sqlite3.connect(database_dir/'thread_history_1.sqlite')) as history:
        state.execute('BEGIN IMMEDIATE'); history.execute('BEGIN IMMEDIATE')
        g.check_rows(state,data['rows'],data['provider'])
        apply_indices(history,data['indices'],restore=True)
        for item in data['files']:
            path=Path(item['path'])
            g.checked_path(path.parent,g.history_roots(home))
            if item['inplace']:
                with path.open('r+b') as f:
                    if os.fstat(f.fileno()).st_size != item['size']: raise RuntimeError('Recovery file size changed')
                    for p in item['patches']:
                        f.seek(p['start']); actual=f.read(p['end']-p['start'])
                        if actual not in (decode(p['old']),decode(p['new'])): raise RuntimeError('Recovery field changed outside migration')
                    for p in item['patches']:
                        f.seek(p['start']); f.write(decode(p['old']))
                    f.flush(); os.fsync(f.fileno())
            elif Path(item['original']).exists():
                stat=Path(item['original']).stat()
                if (stat.st_size,stat.st_mtime_ns)!=(item['size'],item['mtime']):
                    raise RuntimeError('Original rollout changed outside migration')
                if path.exists():
                    current=path.stat()
                    if current.st_size!=mapper(item)(item['size']) or current.st_mtime_ns not in (item['mtime'],item.get('prepared_mtime')):
                        raise RuntimeError('Replacement rollout changed outside migration')
                os.replace(item['original'],path)
            if item.get('temp'): Path(item['temp']).unlink(missing_ok=True)
            os.utime(path, ns=(item['atime'],item['mtime']))
        state.executemany('UPDATE threads SET model_provider=? WHERE id=?',[(r['model_provider'],r['id']) for r in data['rows']])
        core.write_config_provider((config,config.read_bytes(),old),check_closed)
        history.commit(); state.commit()
    journal.unlink(); return True


def migrate(home,database_dir,selected_ids,provider,check_closed=core.ensure_codex_closed,
            report=print,fault=lambda stage:None,engine='python',workers=4):
    import codex_provider_groups as g
    started=time.perf_counter()
    if engine not in ('python','rust'): raise ValueError('Unknown engine')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}',provider): raise ValueError('Invalid provider ID')
    workers=max(1,min(32,workers))
    with g.exclusive(home):
        check_closed(); recover(home,database_dir,check_closed)
        data=g.catalog(home,database_dir)
        selected=set(selected_ids)
        groups=[group for group in data['groups'] if selected & group['ids']]
        rows={r['id']:r for group in groups for r in group['rows']}
        if not selected or not selected.issubset(rows): raise ValueError('Selected tasks no longer exist')
        issues=sorted({issue for group in groups for issue in group['issues']})
        if issues: raise ValueError('; '.join(issues))
        if any(r['history_mode']!='paginated' for r in rows.values()): raise ValueError('Unsupported history mode; no writes made')
        config_plan=core.plan_config_provider(home,provider)
        report(f'Проверка: {len(groups)} групп, {len(rows)} задач. Движок: {engine}.')
        items=plan_files([f for group in groups for f in group['files']],provider,engine,workers)
        indices=index_updates(database_dir,items)
        changed=[r for r in rows.values() if r['model_provider']!=provider]
        files=[item for item in items if item['patches']]
        for item in files:
            item['inplace']=item['links']==1 and all(len(decode(p['new']))==p['end']-p['start'] for p in item['patches'])
            item['temp']=item['path']+'.provider-new'
            item['original']=item['path']+'.provider-original'
            if Path(item['temp']).exists() or Path(item['original']).exists(): raise RuntimeError('Unrecognized pending rollout file')
        journal=dict(version=3,database_dir=str(database_dir.resolve()),provider=provider,
                     rows=[{k:r[k] for k in ('id','model_provider','rollout_path','archived','history_mode')} for r in rows.values()],
                     files=files,indices=indices,config_old=encode(config_plan[1]),config_new=encode(config_plan[2]))
        if not files and not changed and not indices and config_plan[1]==config_plan[2]:
            return dict(tasks=len(rows),changed=0,files=0,seconds=time.perf_counter()-started)
        rewritten=sum(item['size'] for item in files if not item['inplace'])
        # Each temp resides beside its source; check aggregate space per volume.
        required={}
        for item in files:
            if not item['inplace']:
                anchor=Path(item['path']).anchor
                required[anchor]=required.get(anchor,0)+mapper(item)(item['size'])
        for anchor,size in required.items():
            if shutil.disk_usage(anchor).free < size+16*1024*1024: raise RuntimeError('Insufficient space for transaction')
        report(f'Изменяемых файлов: {len(files)}; перепись: {rewritten/1024**2:.1f} MiB; остальные — точечная запись.')
        repaired=sum(u.get('repaired',False) for u in indices)
        if repaired: report(f'Устаревших строк индекса, восстановленных по ordinal: {repaired}.')
        check_closed()
        g.atomic_json(home/g.JOURNAL,journal)
        try:
            fault('journal')
            rewriting=[item for item in files if not item['inplace']]
            if engine=='rust': rust_call(dict(command='copy',files=rewriting,workers=workers))
            else:
                with ThreadPoolExecutor(max_workers=workers) as pool: list(pool.map(copy_python,rewriting))
            for item in rewriting: item['prepared_mtime']=Path(item['temp']).stat().st_mtime_ns
            g.atomic_json(home/g.JOURNAL,journal)
            fault('prepared')
            with closing(sqlite3.connect(database_dir/'state_5.sqlite')) as state, closing(sqlite3.connect(database_dir/'thread_history_1.sqlite')) as history:
                state.execute('BEGIN IMMEDIATE'); history.execute('BEGIN IMMEDIATE')
                g.check_rows(state,rows.values()); check_closed()
                for item in items:
                    stat=Path(item['path']).stat()
                    if (stat.st_size,stat.st_mtime_ns)!=(item['size'],item['mtime']): raise RuntimeError('Rollout changed during preparation')
                for item in files:
                    path=Path(item['path'])
                    if item['inplace']:
                        with path.open('r+b') as f:
                            for p in item['patches']:
                                f.seek(p['start'])
                                if f.read(p['end']-p['start'])!=decode(p['old']): raise RuntimeError('Rollout field changed')
                                f.seek(p['start']); f.write(decode(p['new']))
                            f.flush(); os.fsync(f.fileno())
                    else:
                        os.replace(path,item['original']); fault('rename')
                        os.replace(item['temp'],path)
                    os.utime(path,ns=(item['atime'],item['mtime']))
                    fault('file')
                apply_indices(history,indices)
                state.executemany('UPDATE threads SET model_provider=? WHERE id=?',[(provider,r['id']) for r in changed])
                fault('database')
                core.write_config_provider(config_plan,check_closed); fault('config')
                history.commit(); fault('history_commit')
                state.commit(); fault('commit')
            journal['committed']=True
            g.atomic_json(home/g.JOURNAL,journal); fault('committed')
            recover(home,database_dir,check_closed)
        except BaseException:
            recover(home,database_dir,check_closed)
            raise
    result=dict(groups=len(groups),tasks=len(rows),changed=len(changed),files=len(files),rewritten_bytes=rewritten,seconds=time.perf_counter()-started)
    report(f'Готово за {result["seconds"]:.2f} с. Провайдер: {provider}.')
    return result
