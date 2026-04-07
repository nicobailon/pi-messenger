/**
 * Worker script for multi-process registerSpawnedWorker test.
 * Called via child_process.fork() with args: [registryDir, name]
 */
import { registerSpawnedWorker } from "../../store.js";

const [registryDir, name] = process.argv.slice(2);
if (!registryDir || !name) {
  process.stderr.write("Usage: registry-worker.ts <registryDir> <name>\n");
  process.exit(1);
}

try {
  registerSpawnedWorker(registryDir, "/project", name, process.pid, "test-model", `sess-${process.pid}`);
  process.stdout.write("OK\n");
  process.exit(0);
} catch (err) {
  process.stderr.write(`FAIL: ${(err as Error).message}\n`);
  process.exit(1);
}
