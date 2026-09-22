"""Compare complete standalone Rust vs Python/Rust hybrid on disposable files."""
import argparse
import json
from pathlib import Path
import statistics
import tempfile
import time
import subprocess

import benchmark_provider_migration as old
import codex_provider_groups as g
import test_codex_provider_groups as t
from test_provider_standalone import invoke
import codex_provider_migration as m


def audit(home):
    _,db=g.core.read_settings(home);catalog=g.catalog(home,db)
    groups=[x for x in catalog['groups'] if not x['issues'] and all(f['stat'].st_mtime<time.time()-120 for f in x['files'])]
    args=[str(m.RUST),'--home',str(home),'--plan-json','--provider','factory']
    for x in groups:args+=['--select',x['root']['id']]
    start=time.perf_counter();result=subprocess.run(args,capture_output=True,text=True,encoding='utf-8');elapsed=time.perf_counter()-start
    assert result.returncode==0,result.stderr
    native=json.loads(result.stdout)
    infos=[f for x in groups for f in x['files']];start=time.perf_counter();old_plan=m.plan_files(infos,'factory','python',8);indices=m.index_updates(db,old_plan);python_elapsed=time.perf_counter()-start
    assert {f['physical']:f['patches'] for f in native['files']}=={f['physical']:f['patches'] for f in old_plan}
    key=lambda rows:sorted((r['table'],r['rowid'],r['old'],r['new']) for r in rows)
    assert key(native['indices'])==key(indices)
    return dict(read_only=True,groups=len(groups),files=len(old_plan),bytes=sum(f['size'] for f in old_plan),standalone_process_seconds=elapsed,python_plan_seconds=python_elapsed,equal_plans=True,repaired_indices=sum(r.get('repaired',False) for r in indices))


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--mib',type=int,default=1024)
    p.add_argument('--trials',type=int,default=5)
    p.add_argument('--workers',type=int,nargs='+',default=[4,8,16])
    p.add_argument('--output',type=Path,default=Path('benchmarks/provider-migration/standalone.json'))
    p.add_argument('--audit-home',type=Path)
    args=p.parse_args()
    if args.audit_home:
        report=audit(args.audit_home)
        args.output.write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8');print(json.dumps(report));return
    report=dict(cache='warm OS cache; no cache eviction',trials=args.trials,migrations=[])
    with tempfile.TemporaryDirectory(prefix='.standalone-benchmark-',dir=Path(__file__).parent) as d:
        home=Path(d);paths=list(old.dataset(home,args.mib).values());baseline=old.digest(paths)
        report.update(files=len(paths),bytes=sum(f.stat().st_size for f in paths))
        ids=[f['root']['id'] for f in g.catalog(home,home)['groups']]
        for workers in args.workers:
            for engine in ('hybrid','standalone'):
                for target in ('factory','second'):
                    samples=[];internal=[]
                    for trial in range(args.trials):
                        started=time.perf_counter()
                        if engine=='standalone':
                            result=invoke(home,'--apply','--all','--provider',target,'--yes','--workers',str(workers))
                            elapsed=time.perf_counter()-started;internal.append(json.loads(result.stdout)['seconds'])
                            invoke(home,'--apply','--all','--provider','openai','--yes','--workers',str(workers))
                        else:
                            result=g.switch(home,home,ids,target,engine='rust',workers=workers,**t.QUIET)
                            elapsed=time.perf_counter()-started;internal.append(result['seconds'])
                            g.switch(home,home,ids,'openai',engine='rust',workers=workers,**t.QUIET)
                        samples.append(elapsed)
                    assert old.digest(paths)==baseline
                    row=dict(engine=engine,workers=workers,mode='rewrite' if target=='factory' else 'inplace',median=statistics.median(samples),samples=samples,internal_median=statistics.median(internal))
                    report['migrations'].append(row);print(row,flush=True)
    args.output.write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')


if __name__=='__main__':main()
