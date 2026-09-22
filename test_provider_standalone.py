"""Standalone Rust regression tests; all mutations use disposable local fixtures.

Build the separate test-harness binary first. The shipped binary has no bypass
for Codex process checks and no crash-injection environment hooks.
"""
from contextlib import closing, contextmanager
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import shutil
import tempfile
import time

import test_codex_provider_groups as t
import codex_provider_migration as m
import codex_provider_groups as g

ROOT=Path(__file__).parent
EXE='.exe' if os.name=='nt' else ''
BINARY=Path(os.environ.get('PROVIDER_TEST_BINARY',ROOT/f'provider_migrate_rs/target-test/release/provider-migrate{EXE}')).resolve()
PRODUCTION=Path(os.environ.get('PROVIDER_PRODUCTION_BINARY',ROOT/f'provider_migrate_rs/target/release/provider-migrate{EXE}')).resolve()


@contextmanager
def running_codex(folder,name='codex'):
    # An owned native helper makes the guard test independent of the user's apps.
    source=folder/'process_guard.rs'
    source.write_text('fn main(){println!("ready");loop{std::thread::sleep(std::time::Duration::from_secs(60));}}')
    binary=folder/f'{name}{EXE}'
    subprocess.run(['rustc',str(source),'-o',str(binary)],check=True,capture_output=True)
    process=subprocess.Popen([str(binary)],stdout=subprocess.PIPE,text=True)
    try:
        assert process.stdout.readline().strip()=='ready'
        yield
    finally:
        process.terminate();process.wait(timeout=10);process.stdout.close()



def invoke(home,*args,fault=None,crash=False,ok=True,binary=BINARY):
    (home/'.isolated-provider-test').write_text('isolated local fixture',encoding='utf-8')
    env=dict(os.environ,PROVIDER_MIGRATE_TEST_HOME=str(home))
    if fault: env['PROVIDER_MIGRATE_FAULT']=fault
    else: env.pop('PROVIDER_MIGRATE_FAULT',None)
    env['PROVIDER_MIGRATE_CRASH']='1' if crash else '0'
    result=subprocess.run([str(binary),'--home',str(home),*args],env=env,capture_output=True,text=True,encoding='utf-8')
    if ok: assert result.returncode==0,(args,result.returncode,result.stderr)
    return result


def apply(home,target,**kwargs):
    return invoke(home,'--apply','--select',t.IDS[1],'--provider',target,'--yes',**kwargs)


def run():
    started=time.perf_counter()
    for target in ('factory','second','x'*128):
        with tempfile.TemporaryDirectory(prefix='standalone-migrate-') as folder:
            home=Path(folder);t.fixture(home,compact=True);before=t.snapshot(home)
            catalog=json.loads(invoke(home,'--list-json').stdout)
            assert len(catalog['groups'])==2
            group=next(g for g in catalog['groups'] if t.IDS[0] in g['ids'])
            assert group['root']==t.IDS[0] and len(group['rows'])==4 and group['files']==5
            py=g.catalog(home,home);infos=next(x for x in py['groups'] if t.IDS[0] in x['ids'])['files']
            expected=m.plan_files(infos,target,'python',8)
            native=json.loads(invoke(home,'--plan-json','--select',t.IDS[1],'--provider',target).stdout)
            assert {f['physical']:f['patches'] for f in native['files']}=={f['physical']:f['patches'] for f in expected}
            ix=lambda rows:sorted([(r['table'],r['rowid'],r['old'],r['new']) for r in rows])
            assert ix(native['indices'])==ix(m.index_updates(home,expected))
            result=json.loads(apply(home,target).stdout);assert result['tasks']==4
            after=t.verify_migration(home,before,target)
            assert json.loads(apply(home,target).stdout)['changed']==0
            assert t.snapshot(home)==after
            apply(home,'openai');assert t.snapshot(home)==before,'Exact round trip failed'
    scenarios=0
    for crash in (False,True):
        for target in ('factory','second'):
            stages=['journal','prepared','file','database','config','history_commit','commit','committed']+(['rename'] if target=='factory' else ['patch'])
            for stage in stages:
                with tempfile.TemporaryDirectory(prefix='standalone-recovery-') as folder:
                    home=Path(folder);t.fixture(home);before=t.snapshot(home)
                    result=apply(home,target,fault=stage,crash=crash,ok=False)
                    assert result.returncode==(73 if crash else 1),(stage,result.stderr)
                    if crash: invoke(home,'--recover','--yes')
                    if stage=='committed':t.verify_migration(home,before,target)
                    else:assert t.snapshot(home)==before,(crash,target,stage,result.stderr)
                    assert not (home/g.JOURNAL).exists(),result.stderr
                    assert not list(home.rglob('*.provider-original'))
                    assert not list(home.rglob('*.provider-new'))
                    scenarios+=1
    # The standalone executable also recovers journals created by the Python tool.
    for stage in ('journal','rename','file','history_commit','commit','committed'):
        with tempfile.TemporaryDirectory(prefix='standalone-old-journal-') as folder:
            home=Path(folder);t.fixture(home);before=t.snapshot(home)
            result=subprocess.run([os.sys.executable,str(ROOT/'test_codex_provider_groups.py'),'--crash',str(home),stage,'python'],capture_output=True)
            assert result.returncode==73
            invoke(home,'--recover','--yes')
            if stage=='committed':t.verify_migration(home,before,'factory')
            else:assert t.snapshot(home)==before
    for problem in ('missing','legacy','duplicate','provider','config','offset','lock','outside'):
        with tempfile.TemporaryDirectory(prefix='standalone-guard-') as folder:
            home=Path(folder);paths=t.fixture(home)
            if problem=='missing':paths[t.IDS[1]].unlink()
            if problem=='legacy':
                with closing(sqlite3.connect(home/'state_5.sqlite')) as db,db:db.execute('UPDATE threads SET history_mode="legacy" WHERE id=?',(t.IDS[2],))
            if problem=='duplicate':(home/'archived_sessions'/paths[t.IDS[0]].name).write_bytes(paths[t.IDS[0]].read_bytes())
            if problem=='config':(home/'config.toml').write_text('invalid toml [')
            if problem=='offset':
                with closing(sqlite3.connect(home/'thread_history_1.sqlite')) as db,db:db.execute('UPDATE thread_turns SET rollout_byte_offset=11')
            if problem=='outside':
                with closing(sqlite3.connect(home/'state_5.sqlite')) as db,db:db.execute('UPDATE threads SET rollout_path=? WHERE id=?',(str(home/'elsewhere.jsonl'),t.IDS[1]))
            before=t.snapshot(home)
            if problem=='lock':
                with g.exclusive(home):result=apply(home,'factory',ok=False)
            else:result=apply(home,'unknown' if problem=='provider' else 'factory',ok=False)
            assert result.returncode!=0,(problem,result.stdout)
            assert t.snapshot(home)==before,problem
    # The production process guard must reject a running Codex on either OS.
    with tempfile.TemporaryDirectory(prefix='standalone-production-guard-') as folder:
        home=Path(folder);t.fixture(home);before=t.snapshot(home)
        for name in ('codex','codex-app-server'):
            with running_codex(home,name):
                result=apply(home,'factory',binary=PRODUCTION,ok=False)
                assert result.returncode==1 and 'Close Codex' in result.stderr,result.stderr
        assert t.snapshot(home)==before
        solo=home/'solo';solo.mkdir();binary=solo/f'Codex Provider Switcher{EXE}';shutil.copy2(PRODUCTION,binary)
        raw=binary.read_bytes()
        assert b'PROVIDER_MIGRATE_TEST_HOME' not in raw and b'PROVIDER_MIGRATE_FAULT' not in raw
        result=subprocess.run([str(binary),'--home',str(home),'--list-json'],cwd=solo,env=dict(os.environ,PATH=''),capture_output=True,text=True,encoding='utf-8')
        assert result.returncode==0,result.stderr
        assert len(json.loads(result.stdout)['groups'])==2
        wrapper=solo/('Codex Provider Switcher.cmd' if os.name=='nt' else 'Codex Provider Switcher.command')
        wrapper.write_bytes((ROOT/wrapper.name).read_bytes());wrapper.chmod(0o755)
        command=(f'{os.environ["COMSPEC"]} /d /s /c ""{wrapper}" --home "{home}" --list-json"'
                 if os.name=='nt' else ['/bin/sh',str(wrapper),'--home',str(home),'--list-json'])
        result=subprocess.run(command,cwd=solo,capture_output=True,text=True,encoding='utf-8')
        assert result.returncode==0,result.stderr
        assert len(json.loads(result.stdout)['groups'])==2
    if os.name!='nt':
        with tempfile.TemporaryDirectory(prefix='standalone-modes-') as folder:
            home=Path(folder).resolve();paths=t.fixture(home)
            files=[home/'config.toml',*paths.values()]
            for i,path in enumerate(files):path.chmod(0o600 if i%2 else 0o640)
            modes={p:p.stat().st_mode&0o7777 for p in files}
            original=paths[t.IDS[0]].read_bytes()
            link=home/'hardlink';os.link(paths[t.IDS[0]],link)
            for provider in ('second','factory','openai'):
                apply(home,provider)
                assert all(p.stat().st_mode&0o7777==mode for p,mode in modes.items())
                assert link.read_bytes()==original
            apply(home,'factory',fault='prepared',crash=True,ok=False)
            assert (home/g.JOURNAL).stat().st_mode&0o777==0o600
            invoke(home,'--recover','--yes')
    if os.name!='nt':
        import test_provider_ui
        with tempfile.TemporaryDirectory(prefix='standalone-ui-') as folder:
            ui_home=Path(folder).resolve();t.fixture(ui_home,compact=True)
            test_provider_ui.terminal_flow(ui_home,BINARY)
    print(f'PASS standalone: exact plans/round trips, {scenarios} error/crash scenarios, legacy journal recovery, guards ({time.perf_counter()-started:.2f}s)',flush=True)


if __name__=='__main__':run()
