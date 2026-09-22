"""Compare two standalone builds on identical disposable data; no real sessions."""
import argparse
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import statistics
import tempfile
import time

import benchmark_provider_migration as old
import test_codex_provider_groups as t
from test_provider_standalone import invoke


def run(binary, home, *args):
    start = time.perf_counter()
    result = invoke(home, *args, binary=binary)
    return time.perf_counter()-start, json.loads(result.stdout)


def canonical(plan):
    return ({f['physical']:f['patches'] for f in plan['files']},
            sorted((r['table'],r['rowid'],r['old'],r['new']) for r in plan['indices']))


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--before',type=Path,required=True)
    p.add_argument('--after',type=Path,required=True)
    p.add_argument('--trials',type=int,default=5)
    p.add_argument('--mib',type=int,default=1024)
    p.add_argument('--unrelated',type=int,default=250000)
    p.add_argument('--output',type=Path,default=Path('benchmarks/provider-migration/optimization.json'))
    a=p.parse_args(); builds={'before':a.before.resolve(),'after':a.after.resolve()}
    report={'cache':'warm OS cache; alternating build order', 'trials':a.trials,
            'sha256':{k:hashlib.sha256(v.read_bytes()).hexdigest() for k,v in builds.items()},'results':[]}
    def measure(home,case,args,undo=None):
        samples={k:[] for k in builds}; details={k:[] for k in builds}
        for i in range(a.trials):
            for name in list(builds)[::1 if i%2==0 else -1]:
                elapsed,detail=run(builds[name],home,*args)
                samples[name].append(elapsed);details[name].append(detail)
                if undo:run(builds[name],home,*undo)
        result={'case':case,'seconds':{k:statistics.median(v) for k,v in samples.items()},'samples':samples}
        result['internal_seconds']={k:statistics.median(x.get('plan_seconds',x.get('seconds',0)) for x in v) for k,v in details.items()}
        report['results'].append(result);print(json.dumps(result),flush=True)
    with tempfile.TemporaryDirectory(prefix='.provider-benchmark-',dir=Path(__file__).parent) as d:
        h=Path(d);t.fixture(h)
        selected=('--select',t.IDS[1],'--provider','factory')
        with closing(sqlite3.connect(h/'thread_history_1.sqlite')) as db,db:
            db.executemany('INSERT INTO thread_turns VALUES(?,?,?)',((f'unrelated-{i}',0,0) for i in range(a.unrelated)))
            db.executemany('INSERT INTO thread_history_projection_state VALUES(?,?)',((f'unrelated-{i}',0) for i in range(a.unrelated)))
            # Same leading key as native Codex indices; no schema changes in user data.
            db.execute('CREATE INDEX bench_turn_thread ON thread_turns(thread_id)')
        report['unrelated_rows_per_table']=a.unrelated
        before=run(builds['before'],h,'--plan-json',*selected)[1]
        after=run(builds['after'],h,'--plan-json',*selected)[1]
        assert canonical(before)==canonical(after)
        measure(h,'selected_family_large_index',('--audit',*selected))
        # Also verify databases lacking an index, without issuing one query per ID.
        with closing(sqlite3.connect(h/'thread_history_1.sqlite')) as db,db:
            db.execute('DROP INDEX bench_turn_thread')
        assert canonical(before)==canonical(run(builds['after'],h,'--plan-json',*selected)[1])
        measure(h,'selected_family_unindexed_turns',('--audit',*selected))
    with tempfile.TemporaryDirectory(prefix='.provider-benchmark-',dir=Path(__file__).parent) as d:
        h=Path(d);t.fixture(h)
        with closing(sqlite3.connect(h/'thread_history_1.sqlite')) as db,db:
            row=db.execute('SELECT * FROM thread_turns WHERE thread_id=? LIMIT 1',(t.IDS[0],)).fetchone()
            db.executemany('INSERT INTO thread_turns VALUES(?,?,?)',(row for _ in range(10000)))
            db.execute('CREATE INDEX bench_turn_thread ON thread_turns(thread_id)')
        baseline=t.snapshot(h)
        measure(h,'rewrite_10000_selected_index_rows',
                ('--apply','--select',t.IDS[1],'--provider','factory','--yes'),
                ('--apply','--select',t.IDS[1],'--provider','openai','--yes'))
        assert t.snapshot(h)==baseline
    with tempfile.TemporaryDirectory(prefix='.provider-benchmark-',dir=Path(__file__).parent) as d:
        h=Path(d);paths=list(old.dataset(h,a.mib).values());baseline=old.digest(paths)
        report.update(files=len(paths),bytes=sum(p.stat().st_size for p in paths))
        for target in ['factory','second']:
            measure(h,'rewrite' if target=='factory' else 'inplace',
                    ('--apply','--all','--provider',target,'--yes','--workers','16'),
                    ('--apply','--all','--provider','openai','--yes','--workers','16'))
            assert old.digest(paths)==baseline
    report['identical_plans_and_roundtrips']=True
    a.output.write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')

if __name__=='__main__':main()
