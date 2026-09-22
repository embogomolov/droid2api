"""Measure large-file scanning and parallel catalog lookups on disposable histories."""
import argparse
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import statistics
import tempfile

import benchmark_provider_migration as old
from benchmark_provider_optimization import run, canonical
import test_codex_provider_groups as t


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--audit-home',type=Path,help='Read-only comparison on stable existing families; no cache or marker files are written')
    p.add_argument('--before',type=Path,required=True)
    p.add_argument('--after',type=Path,required=True)
    p.add_argument('--mib',type=int,default=1024)
    p.add_argument('--trials',type=int,default=5)
    p.add_argument('--output',type=Path,default=Path('benchmarks/provider-migration/parallel.json'))
    a=p.parse_args();builds={'before':a.before.resolve(),'after':a.after.resolve()}
    if a.audit_home:
        import subprocess,time
        import codex_provider_groups as groups
        home=a.audit_home.resolve();_,database=groups.core.read_settings(home)
        data=groups.catalog(home,database)
        selected=[g for g in data['groups'] if not g['issues'] and all(f['stat'].st_mtime < time.time()-120 for f in g['files']) and all(r.get('history_mode')=='paginated' for r in g['rows'])]
        assert selected, 'No stable families available'
        args=['--home',str(home),'--provider','factory']
        for g in selected: args+=['--select',g['root']['id']]
        # Direct subprocess calls: fixture invoke() intentionally writes a test
        # marker, so it must never be used with real Codex data.
        def call(binary, mode):
            start=time.perf_counter()
            r=subprocess.run([str(binary),mode,*args],capture_output=True,text=True,encoding='utf-8')
            assert r.returncode==0,r.stderr
            return time.perf_counter()-start,json.loads(r.stdout)
        expected=None
        for binary in builds.values():
            _,plan=call(binary,'--plan-json')
            actual=canonical(plan)
            if expected is not None: assert actual==expected, 'Read-only plans differ'
            expected=actual
        timings={k:[] for k in builds}
        for i in range(a.trials):
            for name in list(builds)[::1 if i%2==0 else -1]:timings[name].append(call(builds[name],'--audit')[0])
        report={'read_only':True,'families':len(selected),'files':sum(len(g['files']) for g in selected),'bytes':sum(f['stat'].st_size for g in selected for f in g['files']),'identical_plans':True,'trials':a.trials,'samples':timings,'median_seconds':{k:statistics.median(v) for k,v in timings.items()}}
        a.output.write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8');print(json.dumps(report));return
    report={'cache':'warm OS cache; alternating execution order','trials':a.trials,'results':[],
            'sha256':{k:hashlib.sha256(v.read_bytes()).hexdigest() for k,v in builds.items()}}
    def measure(home,case,args,undo=None):
        samples={k:[] for k in builds};catalog={k:[] for k in builds};internal={k:[] for k in builds}
        for i in range(a.trials):
            for name in list(builds)[::1 if i%2==0 else -1]:
                elapsed,r=run(builds[name],home,*args)
                samples[name].append(elapsed);catalog[name].append(r.get('catalog_seconds',0));internal[name].append(r.get('plan_seconds',r.get('seconds',0)))
                if undo:run(builds[name],home,*undo)
        result={'case':case,'median_seconds':{k:statistics.median(v) for k,v in samples.items()},'samples':samples,
                'catalog_seconds':{k:statistics.median(v) for k,v in catalog.items()},'internal_seconds':{k:statistics.median(v) for k,v in internal.items()}}
        report['results'].append(result);print(json.dumps(result),flush=True)
    with tempfile.TemporaryDirectory(prefix='.provider-benchmark-',dir=Path(__file__).parent) as d:
        h=Path(d);paths=t.fixture(h)
        line=b'{"type":"response_item","payload":{"text":"'+b'x'*(1024*1024)+b'"}}\n'
        setting=b'{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model_provider_id":"openai"}}}\n'
        with paths[t.IDS[0]].open('ab') as f:
            for i in range(a.mib):
                f.write(line)
                if i%4==0:f.write(setting)
        args=('--select',t.IDS[0],'--provider','factory','--workers','16')
        report['large_file_bytes']=paths[t.IDS[0]].stat().st_size
        before=run(builds['before'],h,'--plan-json',*args)[1]
        assert canonical(before)==canonical(run(builds['after'],h,'--plan-json',*args)[1])
        tuning=[]
        for block in (4,8,16,32,64):
            os.environ['PROVIDER_SCAN_BLOCK_MIB']=str(block)
            samples=[run(builds['after'],h,'--audit',*args)[1]['plan_seconds'] for _ in range(7)]
            row={'block_mib':block,'median_plan_seconds':statistics.median(samples),'samples':samples};tuning.append(row);print(json.dumps(row),flush=True)
        os.environ.pop('PROVIDER_SCAN_BLOCK_MIB',None)
        report['block_tuning']=tuning
        measure(h,'one_large_file_plan',('--audit',*args))
        baseline=old.digest(paths.values())
        for target in ('factory','second'):
            measure(h,'one_large_file_'+('rewrite' if target=='factory' else 'inplace'),
                    ('--apply','--select',t.IDS[0],'--provider',target,'--yes'),
                    ('--apply','--select',t.IDS[0],'--provider','openai','--yes'))
            assert old.digest(paths.values())==baseline
    with tempfile.TemporaryDirectory(prefix='.provider-benchmark-',dir=Path(__file__).parent) as d:
        h=Path(d);paths=t.fixture(h);target=paths[t.IDS[4]]
        head=json.loads(target.read_bytes().split(b'\n',1)[0]);head['ordinal']=0
        with target.open('wb') as f:
            f.write(json.dumps(head).encode()+b'\n')
            for i in range(1,a.mib+1):
                f.write(b'{"ordinal":'+str(i).encode()+b',"type":"response_item","payload":{"text":"'+b'x'*(1024*1024)+b'"}}\n')
        with closing(sqlite3.connect(h/'thread_history_1.sqlite')) as db,db:
            db.execute('ALTER TABLE thread_turns ADD COLUMN rollout_ordinal INTEGER')
            db.execute('ALTER TABLE thread_turns ADD COLUMN rollout_end_ordinal INTEGER')
            db.execute('ALTER TABLE thread_history_projection_state ADD COLUMN next_rollout_ordinal INTEGER')
            db.execute('UPDATE thread_turns SET rollout_byte_offset=1,rollout_end_byte_offset=2,rollout_ordinal=?,rollout_end_ordinal=? WHERE thread_id=?',(a.mib//2,a.mib//2+1,t.IDS[4]))
            db.execute('UPDATE thread_history_projection_state SET next_rollout_byte_offset=1,next_rollout_ordinal=? WHERE thread_id=?',(a.mib+1,t.IDS[4]))
        args=('--select',t.IDS[4],'--provider','factory','--workers','16')
        assert canonical(run(builds['before'],h,'--plan-json',*args)[1])==canonical(run(builds['after'],h,'--plan-json',*args)[1])
        measure(h,'one_large_file_stale_index_plan',('--audit',*args))
    with tempfile.TemporaryDirectory(prefix='.provider-benchmark-',dir=Path(__file__).parent) as d:
        h=Path(d);t.fixture(h)
        with closing(sqlite3.connect(h/'state_5.sqlite')) as db,db:
            template=list(db.execute('SELECT * FROM threads WHERE id=?',(t.IDS[4],)).fetchone())
            for i in range(2048):
                tid=f'10000000-0000-4000-8000-{i:012x}';path=h/'sessions'/f'rollout_{tid}.jsonl'
                path.write_text(json.dumps({'type':'session_meta','payload':{'id':tid,'model_provider':'openai'}})+'\n',encoding='utf-8')
                row=template.copy();row[0]=tid;row[1]=f'Задача {i}';row[7]=str(path)
                db.execute('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',row)
        args=('--select',t.IDS[0],'--provider','factory','--workers','16')
        measure(h,'catalog_2054_files_selected_plan',('--audit',*args))
        assert canonical(run(builds['before'],h,'--plan-json',*args)[1])==canonical(run(builds['after'],h,'--plan-json',*args)[1])
    with tempfile.TemporaryDirectory(prefix='.provider-benchmark-',dir=Path(__file__).parent) as d:
        h=Path(d);paths=list(old.dataset(h,a.mib).values());baseline=old.digest(paths)
        for target in ('factory','second'):
            measure(h,'balanced_32_files_'+('rewrite' if target=='factory' else 'inplace'),
                    ('--apply','--all','--provider',target,'--yes'),
                    ('--apply','--all','--provider','openai','--yes'))
            assert old.digest(paths)==baseline
    report['identical_plans_and_roundtrips']=True
    a.output.write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')

if __name__=='__main__':main()
