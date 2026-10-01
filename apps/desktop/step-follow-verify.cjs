/**
 * 官方快进只在工作树干净时发生。脏树不快进，失败要回到原提交。
 */
const assert = require('node:assert');
const { followCleanCheckout } = require('./dist/step-follow.js');

function gitFor(script) {
  return (args) => {
    const key = args[0];
    if (key === 'rev-parse' && args[1] === 'HEAD') return script.head;
    if (key === 'rev-parse' && args[1] === 'origin/main') return script.remote;
    if (key === 'fetch') {
      script.fetched = true;
      return '';
    }
    if (key === 'status') return script.dirty;
    if (key === 'merge') {
      script.merged = true;
      script.head = script.remote;
      if (script.mergeFails) throw new Error('ff failed');
      return '';
    }
    if (key === 'reset') {
      script.reset = args[2];
      script.head = args[2];
      return '';
    }
    throw new Error('unexpected git ' + args.join(' '));
  };
}

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log('  PASS  ' + name);
  } catch (err) {
    failed += 1;
    console.log('  FAIL  ' + name);
    console.log('        ' + err.message);
  }
}

check('已是 tip 时不快进', () => {
  const script = { head: 'abc', remote: 'abc', dirty: '', fetched: false, merged: false };
  const result = followCleanCheckout('D:\\unused', gitFor(script));
  assert.equal(result.updated, false);
  assert.equal(script.merged, false);
  assert.match(result.note, /已是官方 tip/);
});

check('有本地改动时不快进', () => {
  const script = { head: 'abc', remote: 'def', dirty: ' M file', fetched: false, merged: false };
  const result = followCleanCheckout('D:\\unused', gitFor(script));
  assert.equal(result.updated, false);
  assert.equal(script.merged, false);
  assert.match(result.note, /不快进/);
});

check('干净且落后时快进', () => {
  const script = { head: 'abc', remote: 'defdef00', dirty: '', fetched: false, merged: false };
  const result = followCleanCheckout('D:\\unused', gitFor(script), () => {});
  assert.equal(script.fetched, true);
  assert.equal(script.merged, true);
  assert.equal(result.updated, true);
  assert.equal(result.head, 'defdef00');
});

check('重建失败时回到快进前', () => {
  const script = { head: 'abc', remote: 'defdef00', dirty: '', fetched: false, merged: false, reset: '' };
  const result = followCleanCheckout('D:\\unused', gitFor(script), () => { throw new Error('tsc missing'); });
  assert.equal(result.updated, false);
  assert.equal(script.reset, 'abc');
  assert.match(result.note, /已回到/);
});

if (failed) {
  console.log('FAIL ' + failed);
  process.exit(1);
}
console.log('follow checks passed');
