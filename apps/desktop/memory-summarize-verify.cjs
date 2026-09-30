/**
 * memory-summarize 依赖已删除的 dsh 插件。
 * 不再装载 memory/brain。断言服务不可取、插件目录不存在。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const rt = require(path.join(__dirname, 'dist', 'dsh-runtime.js'));
assert.equal(rt.getService('memory'), null);
assert.equal(rt.getService('brain'), null);
assert.equal(fs.existsSync(path.join(__dirname, '..', '..', 'packages', 'plugin', 'memory')), false);
assert.equal(fs.existsSync(path.join(__dirname, '..', '..', 'packages', 'plugin', 'brain')), false);
console.log('  PASS  memory-summarize 已随插件删除，不再装载');
