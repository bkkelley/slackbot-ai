import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-'));
  const fakeBin = path.join(root, 'mnemosyne');
  fs.writeFileSync(fakeBin, `#!/bin/sh
if [ "$1" = "stats" ]; then
  echo "Mnemosyne Stats"
  echo "  Total memories: 2"
  echo "  Working memory: 1"
  echo "  Episodic memory: 1"
  echo "  Knowledge triples: 0"
  echo "  Banks: default"
  echo "  DB path: /tmp/mnemosyne.db"
elif [ "$1" = "recall" ]; then
  echo "Results for: $2"
  echo ""
  echo "  ID: mem-1"
  echo "  Content: The user prefers concise run inspector notes."
  echo "  Score: 0.91"
else
  exit 2
fi
`, 'utf8');
  fs.chmodSync(fakeBin, 0o755);
  process.env.MNEMOSYNE_BIN = fakeBin;

  const { inspectMnemosyneMemory } = await import('./memory.js');
  const memory = inspectMnemosyneMemory({
    id: 'job-1',
    agent: 'Ask the System',
    action: 'Diagnose system',
    mode: 'preview',
    toolset: 'default',
    status: 'pending',
    trigger: 'manual',
    createdAt: new Date().toISOString(),
  });

  assert.equal(memory.available, true);
  assert.equal(memory.stats?.totalMemories, 2);
  assert.equal(memory.recall.resultCount, 1);
  assert.equal(memory.recall.chars > 0, true);
  assert.equal(memory.sources[0]?.included, true);
  assert.match(memory.recall.raw, /The user prefers concise/);

  const override = inspectMnemosyneMemory({
    id: 'job-2',
    agent: 'Ask the System',
    mode: 'preview',
    toolset: 'default',
    status: 'pending',
    trigger: 'manual',
    createdAt: new Date().toISOString(),
  }, { query: 'custom recall query', topK: 3 });
  assert.equal(override.query, 'custom recall query');
  assert.equal(override.topK, 3);

  console.log('memory tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
