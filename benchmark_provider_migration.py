"""Reproducible benchmark on disposable synthetic histories, never user sessions.

Run: python benchmark_provider_migration.py --mib 1024 --trials 3
Includes file fsync, both SQLite commits, config and recovery-journal cleanup.
"""
import argparse
from contextlib import closing
import hashlib
import json
from pathlib import Path
import platform
import sqlite3
import statistics
import tempfile
import time

import codex_provider_groups as g
import codex_provider_migration as m
import test_codex_provider_groups as t


def dataset(home, mib, files=32):
    paths=t.fixture(home,compact=True)
    source=paths[t.IDS[4]]
    with closing(sqlite3.connect(home/'state_5.sqlite')) as db,db:
        template=list(db.execute('SELECT * FROM threads WHERE id=?',(t.IDS[4],)).fetchone())
        for i in range(len(paths),files):
            tid=f'10000000-0000-4000-8000-{i:012d}'
            path=home/'sessions'/('rollout_'+tid+'.jsonl')
            record=json.loads(source.read_bytes().splitlines()[0]); record['payload']['id']=tid
            record['payload']['parent_thread_id']=t.IDS[0]
            path.write_bytes(json.dumps(record,separators=(',',':')).encode()+b'\n')
            row=template.copy(); row[0]=tid; row[7]=str(path)
            db.execute('INSERT INTO threads VALUES('+','.join('?' for _ in row)+')',row)
            paths[tid]=path
        # Include the independent fixture family in the same benchmark selection.
    chunk=b'{"type":"response_item","payload":{"type":"message","content":[{"type":"input_text","text":"'+b'x'*(1024*1024)+b'"}]}}\n'
    setting=b'{"type":"event_msg","payload":{"type":"thread_settings_applied","thread_settings":{"model_provider_id":"openai","model":"test-model"}}}\n'
    for path in paths.values():
        with path.open('ab') as file:
            for i in range(max(1,mib//files)):
                file.write(chunk)
                if i%4==0: file.write(setting)
    return paths


def digest(paths):
    hashes={}
    for p in paths:
        with p.open('rb') as f: hashes[str(p)]=hashlib.file_digest(f,'sha256').hexdigest()
    return hashes


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mib',type=int,default=1024)
    parser.add_argument('--trials',type=int,default=3)
    parser.add_argument('--output',type=Path,default=Path('provider-benchmark.json'))
    parser.add_argument('--scan-only',action='store_true')
    parser.add_argument('--workers',type=int,nargs='+',default=[1,4,8,16])
    parser.add_argument('--audit-home',type=Path,help='Read-only planning comparison on existing history; never migrates it')
    args=parser.parse_args()
    if args.audit_home:
        home=args.audit_home.resolve(); _,db=g.core.read_settings(home); data=g.catalog(home,db)
        groups=[a for a in data['groups'] if not a['issues'] and all(f['stat'].st_mtime<time.time()-120 for f in a['files'])]
        infos=[f for a in groups for f in a['files']]
        audit=dict(read_only=True,groups=len(groups),files=len(infos),bytes=sum(f['stat'].st_size for f in infos),timings={})
        expected=None
        for engine in ('python','rust'):
            start=time.perf_counter(); items=m.plan_files(infos,'factory',engine,8)
            audit['timings'][engine]=time.perf_counter()-start
            plan=[item['patches'] for item in items]
            if expected is not None: assert plan==expected,'Live read-only patch plans differ'
            expected=plan
            print('Read-only plan',engine,audit['timings'][engine],flush=True)
        start=time.perf_counter(); indices=m.index_updates(db,items)
        audit['index_seconds']=time.perf_counter()-start
        audit['index_rows']=len(indices); audit['stale_index_rows']=sum(u.get('repaired',False) for u in indices)
        audit['provider_fields']=sum(len(p) for p in expected)
        args.output.write_text(json.dumps(audit,indent=2)+'\n',encoding='utf-8')
        print(json.dumps(audit)); return
    result=dict(platform=platform.platform(),python=platform.python_version(),cache='warm OS cache; no cache eviction',trials=args.trials,scans=[],migrations=[])
    with tempfile.TemporaryDirectory(prefix='.provider-benchmark-',dir=Path(__file__).parent) as directory:
        home=Path(directory); paths=list(dataset(home,args.mib).values())
        result['bytes']=sum(p.stat().st_size for p in paths); result['files']=len(paths)
        baseline=digest(paths)
        expected=m.scan_python_many(paths,'factory',1,'thread')
        for engine,parallel in [('python','thread'),('python','process'),('rust','native')]:
            for workers in args.workers:
                samples=[]
                for trial in range(args.trials):
                    start=time.perf_counter()
                    scanned=m.rust_call(dict(command='scan',paths=[str(p) for p in paths],provider='factory',workers=workers)) if engine=='rust' else m.scan_python_many(paths,'factory',workers,parallel)
                    samples.append(time.perf_counter()-start)
                    assert scanned==expected,'Engines produce different patch plans'
                row=dict(engine=engine,parallel=parallel,workers=workers,median=statistics.median(samples),samples=samples)
                result['scans'].append(row); print('scan',row,flush=True)
        if not args.scan_only:
            ids=[v['root']['id'] for v in g.catalog(home,home)['groups']]
            for engine in ('python','rust'):
                for workers in args.workers:
                    for target in ('factory','second'):
                        samples=[]
                        for trial in range(args.trials):
                            change=g.switch(home,home,ids,target,engine=engine,workers=workers,**t.QUIET)
                            samples.append(change['seconds'])
                            g.switch(home,home,ids,'openai',engine=engine,workers=workers,**t.QUIET)
                        assert digest(paths)==baseline,'Round trip changed payload bytes'
                        row=dict(engine=engine,workers=workers,mode='rewrite' if target=='factory' else 'inplace',median=statistics.median(samples),samples=samples)
                        result['migrations'].append(row); print('migration',row,flush=True)
        args.output.write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    print('Report:',args.output.resolve())


if __name__=='__main__': main()
