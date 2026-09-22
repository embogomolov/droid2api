"""Isolated regression checks. Never opens the user's Codex database."""
from contextlib import closing, redirect_stdout
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

import codex_provider_groups as g

IDS = [f'00000000-0000-4000-8000-{i:012d}' for i in range(1,7)]
QUIET = dict(check_closed=lambda: None, report=lambda text: None)


def fixture(home, compact=False, body_size=0):
    (home/'sessions').mkdir()
    (home/'archived_sessions').mkdir()
    (home/'config.toml').write_text('model_provider = "openai" # keep\n[model_providers.factory]\nname="Factory"\n[model_providers.second]\nname="Second"\n[model_providers.'+'x'*128+']\nname="Long"\n',encoding='utf-8')
    (home/'config.toml').write_text('sqlite_home='+json.dumps(str(home))+'\n'+(home/'config.toml').read_text(encoding='utf-8'),encoding='utf-8')
    bodies = b'{"type":"event_msg","payload":{"text":"keep model_provider unchanged"}}\n'
    bodies += b'{"type":"session_meta","payload":{"id":"copied-parent","model_provider":"openai"}}\n'
    bodies += b'{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model_provider_id":"openai","model":"test-model","cwd":"keep"}}}\n'
    if body_size: bodies += b'{"type":"event_msg","payload":{"text":"'+b'x'*body_size+b'"}}\n'
    paths = {}
    def file(physical,owner,extra=None,archived=False):
        record = {'type':'session_meta','payload':{'id':owner,'model_provider':'openai','base_instructions':'Сохранить без изменений',**(extra or {})}}
        raw = json.dumps(record,ensure_ascii=False,**({'separators':(',',':')} if compact else {})).encode()+b'\r\n'
        path=home/('archived_sessions' if archived else 'sessions')/('rollout_'+physical+'.jsonl')
        path.write_bytes(raw+bodies); paths[physical]=path
        return len(raw+bodies)
    root_end=file(IDS[0],IDS[0])
    edited_end=file(IDS[5],IDS[0],{'history_base':{'thread_id':IDS[0],'end_byte_offset':root_end,'end_ordinal_exclusive':3}})
    file(IDS[1],IDS[1],{'history_base':{'thread_id':IDS[5],'end_byte_offset':edited_end,'end_ordinal_exclusive':3}})
    file(IDS[2],IDS[2],{'forked_from_id':IDS[0]},True)
    file(IDS[3],IDS[3],{'source':{'subagent':{'thread_spawn':{'parent_thread_id':IDS[1]}}}},True)
    file(IDS[4],IDS[4])
    with closing(sqlite3.connect(home/'state_5.sqlite')) as db,db:
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('CREATE TABLE threads(id TEXT PRIMARY KEY,name TEXT,title TEXT,cwd TEXT,model_provider TEXT,model TEXT,updated_at INTEGER,rollout_path TEXT,archived INTEGER,history_mode TEXT,source TEXT,thread_source TEXT)')
        db.execute('CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT PRIMARY KEY,status TEXT)')
        db.execute('INSERT INTO thread_spawn_edges VALUES(?,?,?)',(IDS[0],IDS[1],'completed'))
        for i,tid in enumerate(IDS[:5]):
            db.execute('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',(tid,'Одинаковое русское название' if i in (0,4) else 'Потомок '+str(i),'','D:/Example','openai','test-model',100+i,str(paths[IDS[5] if i==0 else tid]),int(i in (2,3)),'paginated','cli','subagent' if i in (1,3) else 'user'))
    with closing(sqlite3.connect(home/'thread_history_1.sqlite')) as db,db:
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('CREATE TABLE thread_turns(thread_id TEXT,rollout_byte_offset INTEGER,rollout_end_byte_offset INTEGER)')
        db.execute('CREATE TABLE thread_history_projection_state(thread_id TEXT PRIMARY KEY,next_rollout_byte_offset INTEGER)')
        for tid,path in paths.items():
            header=len(path.read_bytes().splitlines(keepends=True)[0]); size=path.stat().st_size
            db.executemany('INSERT INTO thread_turns VALUES(?,?,?)',[(tid,header,size),(tid,header,None),(tid,0,0)])
            db.execute('INSERT INTO thread_history_projection_state VALUES(?,?)',(tid,size))
    return paths


def snapshot(home):
    result={'files':{str(p):p.read_bytes() for p in home.rglob('*.jsonl')},'config':(home/'config.toml').read_bytes()}
    with closing(sqlite3.connect(home/'state_5.sqlite')) as db:
        result['rows']=db.execute('SELECT * FROM threads ORDER BY id').fetchall()
    with closing(sqlite3.connect(home/'thread_history_1.sqlite')) as db:
        result['indices']=[db.execute('SELECT rowid,* FROM '+table+' ORDER BY rowid').fetchall() for table in ('thread_turns','thread_history_projection_state')]
    return result


def expect_error(callback):
    try: callback()
    except (RuntimeError,OSError,ValueError,sqlite3.Error): return
    raise AssertionError('Expected rejected operation')


def verify_migration(home, before, target):
    after=snapshot(home)
    for original,row in zip(before['rows'],after['rows']):
        expected=list(original)
        if row[0]!=IDS[4]: expected[4]=target
        assert list(row)==expected
    for name,raw in after['files'].items():
        if name.endswith(IDS[4]+'.jsonl'):
            assert raw==before['files'][name]; continue
        for record in map(json.loads,raw.splitlines()):
            if record['type']=='session_meta': assert record['payload']['model_provider']==target
            if record.get('payload',{}).get('type')=='thread_settings_applied':
                assert record['payload']['thread_settings']['model_provider_id']==target
        assert b'keep model_provider unchanged' in raw
    # Every physical-file cursor still points to a complete record boundary.
    for row in after['indices'][0]:
        physical=row[1]; path=next(Path(p) for p in after['files'] if p.endswith(physical+'.jsonl'))
        for offset in row[2:]:
            if offset is not None:
                raw=path.read_bytes(); assert 0<=offset<=len(raw)
                assert offset==0 or raw[offset-1:offset]==b'\n'
    return after


def run():
    import codex_provider_migration as m
    started=time.perf_counter()
    engines=['python']+(['rust'] if m.RUST.exists() else [])
    with tempfile.TemporaryDirectory(prefix='codex-parser-') as directory:
        path=Path(directory)/'record.jsonl'
        for meta in ({}, {'id':'test','model_provider':None}, {'description':'payload model_provider 日本語','id':'test'}, {'model_provider':'old','id':'test'}):
            path.write_bytes(json.dumps({'payload':meta,'type':'session_meta'},ensure_ascii=False).encode()+b'\r\n')
            expected=m.scan_python(path,'factory')
            if 'rust' in engines: assert m.rust_call(dict(command='scan',paths=[str(path)],provider='factory'))[0]==expected
        path.write_bytes(b'{"type":"session_meta","payload":{"id":"test","model_provider":"first","model_provider":"old"}}\n')
        expect_error(lambda:m.scan_python(path,'factory'))
        if 'rust' in engines: expect_error(lambda:m.rust_call(dict(command='scan',paths=[str(path)],provider='factory')))
    for engine in engines:
        for target in ('factory','second','x'*128):
            with tempfile.TemporaryDirectory(prefix='codex-migration-') as directory:
                home=Path(directory); paths=fixture(home,compact=True); before=snapshot(home)
                data=g.catalog(home,home)
                assert len(data['groups'])==2, 'Identical titles must not merge'
                family=next(v for v in data['groups'] if IDS[0] in v['ids'])
                assert len(family['rows'])==4 and len(family['files'])==5 and family['root']['id']==IDS[0]
                result=g.switch(home,home,[IDS[1]],target,engine=engine,**QUIET)
                assert result['tasks']==4 and result['changed']==4
                after=verify_migration(home,before,target)
                assert g.switch(home,home,[IDS[0]],target,engine=engine,**QUIET)['changed']==0
                assert snapshot(home)==after
                g.switch(home,home,[IDS[0]],'openai',engine=engine,**QUIET)
                assert snapshot(home)==before, 'Round trip changed unrelated bytes/indices'
        for crash in (False,True):
            for stage in ('journal','prepared','rename','file','database','config','history_commit','commit','committed'):
                with tempfile.TemporaryDirectory(prefix='codex-recovery-') as directory:
                    home=Path(directory); fixture(home); before=snapshot(home)
                    if crash:
                        result=subprocess.run([sys.executable,__file__,'--crash',str(home),stage,engine],capture_output=True,text=True)
                        assert result.returncode==73,(stage,result.returncode,result.stderr)
                        assert g.restore(home,home,lambda:None)
                    else:
                        def fault(point):
                            if point==stage: raise RuntimeError('Injected failure')
                        expect_error(lambda:g.switch(home,home,[IDS[0]],'factory',engine=engine,fault=fault,**QUIET))
                    if stage=='committed': verify_migration(home,before,'factory')
                    else: assert snapshot(home)==before,(engine,crash,stage)
                    assert not (home/g.JOURNAL).exists()
                    assert not list(home.rglob('*.jsonl.provider-*'))
        # Recovery of direct, equal-length writes must also preserve all bytes.
        with tempfile.TemporaryDirectory(prefix='codex-inplace-crash-') as directory:
            home=Path(directory); fixture(home); before=snapshot(home)
            result=subprocess.run([sys.executable,__file__,'--crash',str(home),'file',engine,'second'],capture_output=True,text=True)
            assert result.returncode==73,result.stderr
            g.restore(home,home,lambda:None); assert snapshot(home)==before
    for problem in ('missing','legacy','duplicate','running','lock','provider','config','offset'):
        with tempfile.TemporaryDirectory(prefix='codex-guards-') as directory:
            home=Path(directory); paths=fixture(home)
            if problem=='missing': paths[IDS[1]].unlink()
            if problem=='legacy':
                with closing(sqlite3.connect(home/'state_5.sqlite')) as db,db:
                    db.execute('UPDATE threads SET history_mode=? WHERE id=?',('legacy',IDS[2]))
            if problem=='duplicate': (home/'archived_sessions'/paths[IDS[0]].name).write_bytes(paths[IDS[0]].read_bytes())
            if problem=='config': (home/'config.toml').write_text('invalid toml [',encoding='utf-8')
            if problem=='offset':
                with closing(sqlite3.connect(home/'thread_history_1.sqlite')) as db,db:
                    db.execute('UPDATE thread_turns SET rollout_byte_offset=11')
            before=snapshot(home)
            if problem=='running':
                def running(): raise g.core.CodexRunningError('Codex running')
                expect_error(lambda:g.switch(home,home,[IDS[0]],'factory',check_closed=running))
            elif problem=='lock':
                with g.exclusive(home): expect_error(lambda:g.switch(home,home,[IDS[0]],'factory',**QUIET))
            else: expect_error(lambda:g.switch(home,home,[IDS[0]],'unknown' if problem=='provider' else 'factory',**QUIET))
            assert snapshot(home)==before,problem
    print(f'PASS: {engines}; exact round trips, family closure, settings, physical offsets, 38 fault/crash cases, input guards ({time.perf_counter()-started:.2f}s).')


if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--crash':
        home=Path(sys.argv[2]); stage=sys.argv[3]
        g.switch(home,home,[IDS[0]],sys.argv[5] if len(sys.argv)>5 else 'factory',engine=sys.argv[4],fault=lambda point:os._exit(73) if point==stage else None,**QUIET)
    else: run()
