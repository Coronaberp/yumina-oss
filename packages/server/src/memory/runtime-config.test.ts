import assert from 'node:assert/strict';
import test from 'node:test';
import { samePostgresDatabase } from './runtime.js';

test('the independent database guard recognizes default ports, database escaping and loopback aliases',()=>{
  assert.equal(samePostgresDatabase('postgres://u:p@localhost/app','postgresql://other:p@127.0.0.1:5432/app'),true);
  assert.equal(samePostgresDatabase('postgres://u:p@db/%61pp','postgres://other:p@db:5432/app'),true);
  assert.equal(samePostgresDatabase('postgres://u:p@db/','postgres://other:p@db/u'),true);
  assert.equal(samePostgresDatabase('postgres://u:p@db/app','postgres://u:p@db/app_memory'),false);
  assert.equal(samePostgresDatabase('postgres://u:p@db:5433/app','postgres://u:p@db:5432/app'),false);
});
