"""Focused native family closure and image preservation check; disposable data only."""
import json
from pathlib import Path
import sqlite3
import tempfile

import test_codex_provider_groups as fixture
from test_provider_standalone import invoke


def run():
    with tempfile.TemporaryDirectory(prefix='provider-family-') as folder:
        home = Path(folder).resolve()
        paths = fixture.fixture(home, compact=True)
        attachment = home / 'attachments' / 'example.png'
        attachment.parent.mkdir()
        attachment.write_bytes(bytes.fromhex('89504e470d0a1a0a') + b'opaque-image-content')
        with sqlite3.connect(home / 'state_5.sqlite') as db:
            db.execute('CREATE TABLE thread_attachments(thread_id TEXT, payload TEXT)')
            db.execute('INSERT INTO thread_attachments VALUES(?,?)',
                       (fixture.IDS[3], json.dumps({'path': str(attachment)})))
            ownership = db.execute('SELECT * FROM thread_attachments').fetchall()
        db.close()
        image = json.dumps({'type': 'response_item', 'payload': {
            'type': 'message', 'role': 'user', 'content': [
                {'type': 'input_image', 'image_url': 'data:image/png;base64,iVBORw0KGgo='},
                {'type': 'input_text', 'text': str(attachment)}]}}).encode() + b'\n'
        for path in paths.values():
            with path.open('ab') as stream:
                stream.write(image)
        before = fixture.snapshot(home)
        attachment_before = attachment.read_bytes()
        catalog = json.loads(invoke(home, '--list-json').stdout)
        family = next(g for g in catalog['groups'] if fixture.IDS[3] in g['ids'])
        assert set(family['ids']) == set(fixture.IDS[:4])
        assert len(family['rows']) == 4 and family['files'] == 5
        assert not family['issues']
        # Select the archived grandchild: include ancestors, sibling fork,
        # archived relatives and both physical versions of the root history.
        for target in ['factory', 'openai']:
            result = json.loads(invoke(home, '--apply', '--select', fixture.IDS[3],
                                       '--provider', target, '--yes').stdout)
            assert result['tasks'] == 4
            after = fixture.verify_migration(home, before, target)
            assert all(raw.endswith(image) for raw in after['files'].values())
            assert attachment.read_bytes() == attachment_before
            with sqlite3.connect(home / 'state_5.sqlite') as db:
                assert db.execute('SELECT * FROM thread_attachments').fetchall() == ownership
            db.close()
        assert fixture.snapshot(home) == before, 'Round trip changed histories or indices'
        # Missing related histories must block the whole migration.
        paths[fixture.IDS[1]].unlink()
        damaged = fixture.snapshot(home)
        failure = invoke(home, '--apply', '--select', fixture.IDS[3],
                         '--provider', 'factory', '--yes', ok=False)
        assert failure.returncode != 0
        assert fixture.snapshot(home) == damaged
    print('PASS: leaf-to-root and sibling closure, archived descendants, edited histories, image bytes, indices, unrelated family and missing-history guard')


if __name__ == '__main__':
    run()
