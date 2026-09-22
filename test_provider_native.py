"""Native Codex acceptance test, isolated CODEX_HOME and local mock Responses server.

No Factory/OpenAI model requests or user history. Run --exe PATH if autodetection fails.
"""
import argparse
from contextlib import contextmanager, closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import queue
import sqlite3
import shutil
import subprocess
import tempfile
import threading
import time
import uuid

import codex_provider_groups as g


class Mock(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self):
        body=b'{"data":[],"models":[]}'
        self.send_response(200); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        body=self.rfile.read(int(self.headers.get('Content-Length','0')))
        if not self.path.endswith('/responses'):
            self.send_response(200); self.end_headers(); self.wfile.write(b'{}'); return
        request=json.loads(body)
        with self.server.guard:
            self.server.requests.append(request)
            spawn=self.server.spawn_next
            self.server.spawn_next=False
        rid='resp_'+uuid.uuid4().hex
        if spawn:
            item=dict(type='function_call',call_id='call_'+uuid.uuid4().hex,namespace='collaboration',
                      name='spawn_agent',arguments=json.dumps(dict(task_name='fixture_child',message='Reply fixture OK',fork_turns='all')))
        else:
            item=dict(type='message',role='assistant',id='msg_'+uuid.uuid4().hex,
                      content=[dict(type='output_text',text='Fixture OK')])
        events=[dict(type='response.created',response=dict(id=rid)),
                dict(type='response.output_item.done',item=item),
                dict(type='response.completed',response=dict(id=rid,usage=dict(input_tokens=0,output_tokens=0,total_tokens=0)))]
        data=''.join('data: '+json.dumps(e)+'\n\n' for e in events).encode()
        self.send_response(200); self.send_header('Content-Type','text/event-stream')
        self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)


class Client:
    def __init__(self,exe,home):
        self.err=open(home/'native-stderr.log','a',encoding='utf-8')
        self.p=subprocess.Popen([str(exe),'app-server','--stdio'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,
            stderr=self.err,text=True,encoding='utf-8',env=dict(os.environ,CODEX_HOME=str(home)),cwd=home,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        self.q=queue.Queue(); self.seq=0; self.events=[]
        def read():
            for line in self.p.stdout:
                try: self.q.put(json.loads(line))
                except ValueError: pass
            self.q.put(None)
        threading.Thread(target=read,daemon=True).start()
        self.call('initialize',dict(clientInfo=dict(name='migration_fixture',version='1.0'),capabilities=dict(experimentalApi=True)))
        self.send(dict(method='initialized'))
    def send(self,v): self.p.stdin.write(json.dumps(v)+'\n'); self.p.stdin.flush()
    def call(self,method,params):
        self.seq+=1; ident=self.seq; self.send(dict(id=ident,method=method,params=params))
        end=time.monotonic()+30
        while True:
            v=self.q.get(timeout=max(.01,end-time.monotonic()))
            if v is None: raise RuntimeError('App Server exited')
            if v.get('id')==ident and 'method' not in v:
                if 'error' in v: raise RuntimeError(str(v['error']))
                return v['result']
            if 'method' in v and 'id' in v: self.send(dict(id=v['id'],error=dict(code=-32601,message='Fixture does not run interactive tools')))
            elif 'method' in v: self.events.append(v)
    def turn(self,tid,text):
        result=self.call('turn/start',dict(threadId=tid,input=[dict(type='text',text=text)]))
        turn_id=result['turn']['id']; end=time.monotonic()+30
        while time.monotonic()<end:
            match=next((e['params']['turn'] for e in self.events if e.get('method')=='turn/completed' and e['params']['turn']['id']==turn_id),None)
            if match:
                assert match['status']=='completed',match
                return turn_id
            v=self.q.get(timeout=max(.01,end-time.monotonic()))
            if v is None: raise RuntimeError('App Server exited')
            if 'method' in v and 'id' in v: self.send(dict(id=v['id'],error=dict(code=-32601,message='No fixture interactive tools')))
            else: self.events.append(v)
        raise RuntimeError('Mock turn did not complete')
    def close(self):
        self.p.stdin.close()
        try: self.p.wait(timeout=8)
        except subprocess.TimeoutExpired: self.p.terminate(); self.p.wait()
        self.err.close()


@contextmanager
def client(exe,home):
    c=Client(exe,home)
    try: yield c
    finally: c.close()


def acceptance(exe,engine):
    with tempfile.TemporaryDirectory(prefix='codex-native-migrate-',ignore_cleanup_errors=True) as directory:
        home=Path(directory)
        server=ThreadingHTTPServer(('127.0.0.1',0),Mock)
        server.requests=[]; server.spawn_next=False; server.guard=threading.Lock()
        threading.Thread(target=server.serve_forever,daemon=True).start()
        base=f'http://127.0.0.1:{server.server_port}'
        config='sqlite_home='+json.dumps(str(home))+'\nmodel="gpt-6-astra"\nmodel_provider="first"\napproval_policy="never"\nsandbox_mode="read-only"\n'
        config+='chatgpt_base_url="'+base+'"\n[features]\nmulti_agent_v2=true\n'
        for provider in ('first','factory','second'):
            config+=f'[model_providers.{provider}]\nname="Fixture {provider}"\nbase_url="{base}/v1"\nwire_api="responses"\nexperimental_bearer_token="fixture"\n'
        (home/'config.toml').write_text(config,encoding='utf-8')
        try:
            with client(exe,home) as c:
                root=c.call('thread/start',dict(historyMode='paginated',ephemeral=False))['thread']['id']
                first_turn=c.turn(root,'First fixture message')
                second_turn=c.turn(root,'Second fixture message')
                fork=c.call('thread/fork',dict(threadId=root,excludeTurns=True))['thread']['id']
                c.turn(fork,'Fork fixture message')
                c.call('thread/archive',dict(threadId=fork))
                # Exercise a superseded physical file before migration.
                c.call('thread/revert',dict(threadId=root,beforeTurnId=second_turn))
                c.turn(root,'Edited second fixture message')
                server.spawn_next=True
                c.turn(root,'Create a native V2 child fixture')
                end=time.monotonic()+15
                while True:
                    listed=c.call('thread/list',dict(limit=100,parentThreadId=root))['data']
                    children=[t for t in listed if t.get('canAcceptDirectInput') is False]
                    if children: break
                    if time.monotonic()>end: raise RuntimeError('Native V2 child was not created')
                    time.sleep(.1)
                child=children[0]['id']
                time.sleep(.5)
            _,database_dir=g.core.read_settings(home)
            before=g.catalog(home,database_dir)
            family=next(v for v in before['groups'] if root in v['ids'])
            assert {root,fork,child}.issubset(family['ids'])
            assert len(family['files'])>len(family['rows']), 'Expected superseded physical rollout'
            # Reproduce stale byte positions, including a wrong but aligned offset.
            # Ordinals remain authoritative; no fixed +/-1 correction can pass this.
            with closing(sqlite3.connect(database_dir/'thread_history_1.sqlite')) as db,db:
                db.execute('UPDATE thread_turns SET rollout_byte_offset=rollout_byte_offset+1,rollout_end_byte_offset=CASE WHEN rollout_end_byte_offset IS NULL THEN NULL ELSE 0 END')
                db.execute('UPDATE thread_history_projection_state SET next_rollout_byte_offset=next_rollout_byte_offset+1')
            for info in family['files']:
                path=info['path']; raw=path.read_bytes(); header,tail=raw.split(b'\n',1)
                record=json.loads(header)
                if record['payload'].get('history_base'):
                    record['payload']['history_base']['end_byte_offset']+=7
                    path.write_bytes(json.dumps(record,separators=(',',':')).encode()+b'\n'+tail)
            if engine=='standalone':
                from test_provider_standalone import invoke
                invoke(home,'--apply','--select',root,'--provider','factory','--yes')
            else:
                g.switch(home,database_dir,[root],'factory',engine=engine,check_closed=lambda:None)
            # Different global default proves resumed metadata is authoritative.
            plan=g.core.plan_config_provider(home,'first'); g.core.write_config_provider(plan,lambda:None)
            for repeat in range(2):
                with client(exe,home) as c:
                    if repeat==0: c.call('thread/unarchive',dict(threadId=fork))
                    for tid in (root,fork,child):
                        resumed=c.call('thread/resume',dict(threadId=tid,excludeTurns=True))
                        assert resumed['modelProvider']=='factory',(tid,resumed['modelProvider'])
                        c.call('thread/turns/list',dict(threadId=tid,limit=100))
                        c.call('thread/items/list',dict(threadId=tid,limit=100))
                    if repeat==0:
                        later=c.turn(root,'Continue after migration')
                        c.call('thread/revert',dict(threadId=root,beforeTurnId=later))
                        c.turn(root,'Edit after migration')
                        latefork=c.call('thread/fork',dict(threadId=root,lastTurnId=first_turn,excludeTurns=True,modelProvider='factory'))['thread']['id']
                        assert c.call('thread/resume',dict(threadId=latefork,excludeTurns=True))['modelProvider']=='factory'
                        c.turn(fork,'Continue previously archived fork')
            with closing(sqlite3.connect(database_dir/'state_5.sqlite')) as db:
                assert all(db.execute('SELECT model_provider FROM threads WHERE id=?',(tid,)).fetchone()[0]=='factory' for tid in (root,fork,child))
            print('PASS native',engine,'root + archived fork + V2 child + stale-index repair + pre/post migration edits + cold resumes;',len(server.requests),'local mock requests',flush=True)
        except Exception:
            print((home/'native-stderr.log').read_text(encoding='utf-8')[-5000:])
            raise
        finally: server.shutdown(); server.server_close()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe',type=Path)
    parser.add_argument('--engine',choices=['python','rust','standalone','both'],default='both')
    args=parser.parse_args()
    exe=args.exe
    if exe is None:
        if os.name=='nt':
            exe=max((Path(os.environ['LOCALAPPDATA'])/'OpenAI'/'Codex'/'bin').glob('*/codex.exe'),key=lambda p:p.stat().st_mtime)
        else:
            exe=shutil.which('codex')
            if exe is None:parser.error('Pass --exe PATH to the native Codex backend')
    exe=Path(exe).resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix='codex-version-') as folder:
        print(subprocess.check_output([str(exe),'--version'],text=True,env=dict(os.environ,CODEX_HOME=folder)).strip(),flush=True)
    for engine in (['python','rust'] if args.engine=='both' else [args.engine]): acceptance(exe,engine)


if __name__=='__main__': main()
