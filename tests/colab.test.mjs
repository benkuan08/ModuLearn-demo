import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { modelSettings } from '../model.mjs';

const bridge = await readFile(new URL('../notebooks/colab_preview.js', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

test('Colab browser relay preserves chunked Unicode answers and concurrent responses', async () => {
  const transfers = new Map(), calls = [];
  const kernel = { async invokeFunction(name, [operation, id, ...args]) {
    assert.equal(name, 'modulearn.workspace'); calls.push(operation);
    if (!transfers.has(id)) transfers.set(id, { body: [] });
    const slot = transfers.get(id);
    let value = {};
    if (operation === 'append') slot.body.push(Buffer.from(args[0], 'base64'));
    if (operation === 'request') {
      const [method, path, , hasBody] = args;
      slot.output = Buffer.from(JSON.stringify({ path, method, answer: hasBody ? JSON.parse(Buffer.concat(slot.body)).answer : 'source' }));
      value = { status: 200, type: 'application/json', length: slot.output.length, data: slot.output.subarray(0, 256).toString('base64') };
    }
    if (operation === 'read') value = { data: slot.output.subarray(args[0], args[0] + 256).toString('base64') };
    if (operation === 'release') transfers.delete(id);
    return { data: { 'application/json': value } };
  } };
  const fetchColab = await new AsyncFunction('window', 'colabChunkSize', bridge + '\nreturn fetch;')({ google: { colab: { kernel } } }, 256);
  const answer = '神經網絡 and reasoning '.repeat(200);
  const [one, two] = await Promise.all([fetchColab('api/assess', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer }) }), fetchColab('api/source?id=W08-P007')]);
  assert.equal((await one.json()).answer, answer);
  assert.equal((await two.json()).path, '/api/source?id=W08-P007');
  assert.ok(calls.filter(c => c === 'append').length > 1); assert.equal(transfers.size, 0);
  await assert.rejects(fetchColab('https://example.com/api/course'), /Only the ModuLearn workspace/);
});

test('Colab timeout configuration accommodates GPU generation while preserving hosted defaults', () => {
  assert.equal(modelSettings({}).timeoutMs, 90000);
  assert.equal(modelSettings({ LLM_TIMEOUT_SECONDS: '1200' }).timeoutMs, 1200000);
  assert.equal(modelSettings({ LLM_TIMEOUT_SECONDS: '9000' }).timeoutMs, 1800000);
});
