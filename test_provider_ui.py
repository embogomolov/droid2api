"""One isolated interactive UX check on macOS; no model calls or user histories."""
import codecs
import os
from pathlib import Path
import re
import select
import signal
import struct
import subprocess
import tempfile
import time
import tomllib
import test_codex_provider_groups as fixture


def terminal_flow(home, binary):
    import fcntl, pty, termios
    master,slave=pty.openpty()
    fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
    (home/'.isolated-provider-test').write_text('isolated local fixture')
    process=subprocess.Popen([str(binary),'--home',str(home)],stdin=slave,stdout=slave,stderr=slave,start_new_session=True,
        env=dict(os.environ,TERM='xterm-256color',PROVIDER_MIGRATE_TEST_HOME=str(home)))
    os.close(slave);os.set_blocking(master,False)
    transcript='';decoder=codecs.getincrementaldecoder('utf-8')()
    def screen():
        rows=['']*24;row=col=0;start=0
        for match in re.finditer(r'\x1b\[([0-9;?]*)([A-Za-z~])',transcript):
            text=transcript[start:match.start()];start=match.end()
            if text and 0<=row<24:
                rows[row]=rows[row].ljust(col)[:col]+text+rows[row][col+len(text):];col+=len(text)
            args,op=match.groups()
            if op=='H':
                nums=[int(v or 1) for v in args.split(';')];row=nums[0]-1;col=(nums[1] if len(nums)>1 else 1)-1
            elif op=='K' and 0<=row<24:rows[row]=''
            elif op=='J' and args=='2':rows=['']*24
        return rows
    def wait(text):
        nonlocal transcript
        end=time.monotonic()+10
        while time.monotonic()<end:
            if select.select([master],[],[],.05)[0]:
                try:chunk=os.read(master,65536)
                except BlockingIOError:continue
                assert chunk,'TUI exited unexpectedly'
                transcript+=decoder.decode(chunk)
            rows=screen()
            if text in '\n'.join(rows):return rows
        raise AssertionError((text,'\n'.join(screen())))
    def send(raw):os.write(master,raw if isinstance(raw,bytes) else raw.encode())
    def click(text):
        rows=wait(text)
        exact=[y for y,row in enumerate(rows) if row.strip(' >›')==text]
        if exact:
            y=exact[0];x=rows[y].find(text)
            send(f'\x1b[<0;{x+2};{y+1}M\x1b[<0;{x+2};{y+1}m');return
        for y,row in enumerate(rows):
            x=row.find(text)
            if x>=0:
                send(f'\x1b[<0;{x+2};{y+1}M\x1b[<0;{x+2};{y+1}m');return
        raise AssertionError(text)
    def paste(text):send('\x1b[200~'+text+'\x1b[201~')
    def config():return tomllib.loads((home/'config.toml').read_text())
    before=fixture.snapshot(home)
    try:
        rows=wait('of 2')
        send(b'\x1b[B\r');wait('Choose provider')
        rows=wait('Apply')
        assert not any('default' in row for row in rows), 'Global default leaked into conversation picker'
        tab_color=re.findall(r'(\x1b\[[0-9;]+m)Conversations',transcript)[-1]
        assert '› '+tab_color+'openai' in transcript, 'Provider must use the actual tab color after the neutral pointer'
        send(b'\x1b[B');wait('› factory')
        assert '› '+tab_color+'factory' not in transcript, 'Moving the cursor must not select a provider'
        assert ' '+tab_color+' openai' in transcript, 'Current provider must remain colored after cursor movement'
        send(b'\r');wait('› Apply')
        assert ' '+tab_color+' factory' in transcript, 'Provider color must remain when focusing Apply'
        send(b'\x1b');wait('› factory')
        mark=len(transcript)
        send(b'\x1b[B');wait('› second')
        assert tab_color+'second' not in transcript[mark:], 'Hover must remain separate from the explicit choice'
        assert ' '+tab_color+' factory' in transcript[mark:], 'Explicit choice must remain highlighted'
        send(b'\x1b');rows=wait('of 2')
        send(b' ');wait('Change provider (1)')
        send(b'\x1b[B\r');wait('Choose provider')
        assert not any('selected' in row for row in screen()[:5]), 'One marked conversation must open the single picker'
        send(b'\x1b');wait('of 2')
        send(b' ');wait('Change provider (2)')
        mark=len(transcript);send(b'\r');wait('Change provider (2)')
        assert 'Choose provider' not in transcript[mark:], 'Enter must not open a conversation with multiple marks'
        send(b' \x1b[A ');rows=wait('Change provider (0)')
        assert all(row.rstrip().endswith('openai') for row in rows if '[ ]' in row)
        fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',24,40,0,0))
        os.kill(process.pid,signal.SIGWINCH)
        wait('\n       openai')
        fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',24,80,0,0))
        os.kill(process.pid,signal.SIGWINCH)
        send(b'\t');wait('Providers')
        click('Add provider');wait('New provider')
        wait('Authentication: API key')
        paste('myproxy');send(b'\t');paste('bad-url');send(b'\t\t')
        paste('test-api-key-not-real')
        wait('********************')
        assert 'test-api-key-not-real' not in transcript, 'Secret was rendered in terminal'
        click('Save');wait('complete URL')
        click('Base URL:');send(b'\x15');paste('http://127.0.0.1:3000/v1')
        click('Save');wait('Saved myproxy.')
        assert config()['model_provider']=='openai'
        assert config()['model_providers']['myproxy']['base_url']=='http://127.0.0.1:3000/v1'
        assert 'env_key' not in config()['model_providers']['myproxy']
        assert config()['model_providers']['myproxy']['experimental_bearer_token']=='test-api-key-not-real'
        unchanged=fixture.snapshot(home)
        assert all(unchanged[k]==before[k] for k in ('files','rows','indices'))
        click('Use as default');wait('Default: myproxy')
        assert config()['model_provider']=='myproxy'
        unchanged=fixture.snapshot(home)
        assert all(unchanged[k]==before[k] for k in ('files','rows','indices'))
        send(b'\t');wait('Conversations')
        paste('ПО-ТОМОК');wait('of 1');wait('[ ] Потомок ')
        assert not any('linked conversations' in r or 'Details' in r for r in screen())
        click('Select all');wait('1 selected');click('Clear selection');wait('Select all')
        click('Search:')
        send(b'\x1b[B');send(b' ');wait('1 selected');send(b'\x1b[C');wait('› Change provider (1)')
        send(b'\r');wait('Choose provider')
        send('factory');wait('Search: factory');send(b'\r')
        assert not any('Also use as default' in r for r in screen())
        # A held writer lock must report failure without losing the selected provider.
        with (home/'.provider-switch.lock').open('a+b') as held:
            fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
            click('Apply');wait('Another switcher is writing')
            fcntl.flock(held,fcntl.LOCK_UN)
        click('Apply');wait('Switched to factory')
        assert config()['model_provider']=='myproxy','Conversation switch changed global default'
        after=fixture.snapshot(home)
        assert sum(row[4]=='factory' for row in after['rows'])==4
        send(b' ');wait('1 selected')
        click('Change provider (1)');wait('Choose provider')
        send(b'\r')
        click('Apply');wait('Switched to openai')
        assert config()['model_provider']=='myproxy'
        final=fixture.snapshot(home)
        assert all(final[k]==before[k] for k in ('files','rows','indices'))
        send(b'\x1b');wait('of 1');send(b'\x1b');wait('of 1')
        send(b'\t');wait('Add provider')
        assert process.poll() is None, 'Escape exited the root screen'
        send(b'\x03')
        end=time.monotonic()+5
        while process.poll() is None and time.monotonic()<end:
            if select.select([master],[],[],.02)[0]:
                try:os.read(master,65536)
                except OSError:pass
        assert process.poll()==0
    finally:
        os.close(master)
        if process.poll() is None:process.kill()
        process.wait(timeout=5)


def run():
    binary=Path(os.environ.get('PROVIDER_TEST_BINARY','provider_migrate_rs/target-test/release/provider-migrate')).resolve()
    with tempfile.TemporaryDirectory(prefix='provider-ui-') as folder:
        home=Path(folder).resolve();fixture.fixture(home,compact=True);terminal_flow(home,binary)
    print('PASS focused UX: Tab sections, mouse controls, validation/edit/paste, add-only, default-only, conversation-only, keyboard actions, Escape navigation, lock retry, exact history round trip')

if __name__=='__main__':run()
