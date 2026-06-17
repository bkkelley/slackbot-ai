const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-route-'));
process.env.VAULT_PATH = path.join(tempRoot, 'vault');
process.env.BASE_DIRECTORY = path.join(tempRoot, 'workspaces');

const workflowsRouter = require('./workflows');

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

async function request(server, method, pathname, body) {
  const url = `http://127.0.0.1:${server.address().port}${pathname}`;
  const response = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  return { status: response.status, data };
}

async function main() {
  const app = express();
  app.use(express.json());
  app.use('/', workflowsRouter);

  const server = await listen(app);
  try {
    const template = `---
name: TemplateSmoke
steps:
  - type: agent
    agent: Builder
    action: Draft Change
    successWhen: output_includes
    successText: READY_FOR_REVIEW
---

# TemplateSmoke

## Marker Contract

- Builder emits READY_FOR_REVIEW when the draft is reviewable.
`;

    const created = await request(server, 'POST', '/', { name: 'TemplateSmoke', content: template });
    assert.strictEqual(created.status, 201);
    assert.deepStrictEqual(created.data, { ok: true, name: 'TemplateSmoke', scope: null });

    const read = await request(server, 'GET', '/TemplateSmoke');
    assert.strictEqual(read.status, 200);
    assert.strictEqual(read.data.content, template);
    assert.ok(read.data.path.endsWith(path.join('vault', '_workflows', 'TemplateSmoke.md')));

    const duplicate = await request(server, 'POST', '/', { name: 'TemplateSmoke', content: template });
    assert.strictEqual(duplicate.status, 409);
    assert.strictEqual(duplicate.data.error, 'Workflow already exists');

    const invalidName = await request(server, 'POST', '/', { name: '../nope', content: template });
    assert.strictEqual(invalidName.status, 400);
    assert.match(invalidName.data.error, /workflow name/i);

    console.log('workflow route smoke tests passed');
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err);
  fs.rmSync(tempRoot, { recursive: true, force: true });
  process.exitCode = 1;
});
