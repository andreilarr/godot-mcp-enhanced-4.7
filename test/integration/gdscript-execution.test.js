// test/integration/gdscript-execution.test.js

import { expect } from 'vitest';
import { executeGdscript } from '../../build/gdscript-executor.js';
import { ensureGodot, getGodotPath, itIfGodot } from '../helpers/integration-setup.js';
import { createTempProject, registerCleanup } from '../helpers/tool-context.js';
import { MINIMAL_PROJECT } from '../helpers/fixtures.js';

describe('Level A: GDScript Execution Pipeline', async () => {
  await ensureGodot();

  const dirRef = { path: null };
  registerCleanup(dirRef);

  beforeEach(() => {
    dirRef.path = createTempProject(MINIMAL_PROJECT);
  });

  itIfGodot('1. simple expression output', async () => {
    const result = await executeGdscript({
      godotPath: getGodotPath(),
      projectPath: dirRef.path,
      code: '_mcp_output("result", "42")',
      timeout: 10,
    });

    expect(result.compile_success).toBeTruthy();
    expect(result.run_success).toBeTruthy();
    expect(result.outputs.length).toBe(1);
    expect(result.outputs[0].value).toBe('42');
  });

  itIfGodot('2. JSON structured output', async () => {
    const data = JSON.stringify({ a: 1, b: 'hello' });
    const result = await executeGdscript({
      godotPath: getGodotPath(),
      projectPath: dirRef.path,
      code: `_mcp_output("data", '${data}')`,
      timeout: 10,
    });

    expect(result.compile_success).toBeTruthy();
    expect(result.run_success).toBeTruthy();
    const parsed = JSON.parse(result.outputs[0].value);
    expect(parsed).toEqual({ a: 1, b: 'hello' });
  });

  itIfGodot('3. compile error detection', async () => {
    const result = await executeGdscript({
      godotPath: getGodotPath(),
      projectPath: dirRef.path,
      code: 'func foo(',
      timeout: 10,
    });

    expect(result.compile_success).toBe(false);
    expect(result.compile_error).toBeTruthy();
  });

  itIfGodot('4. runtime error capture', async () => {
    const result = await executeGdscript({
      godotPath: getGodotPath(),
      projectPath: dirRef.path,
      code: `var x: Variant = null
x.call("hello")`,
      timeout: 10,
    });

    expect(result.compile_success).toBeTruthy();
    expect(result.run_success).toBe(false);
    expect(result.run_error).toBeTruthy();
  });

  itIfGodot('5. timeout interrupts infinite loop', async () => {
    const start = Date.now();
    const result = await executeGdscript({
      godotPath: getGodotPath(),
      projectPath: dirRef.path,
      code: 'while true: pass',
      timeout: 3,
    });
    const elapsed = Date.now() - start;

    expect(elapsed < 10000).toBeTruthy();
    expect(result.run_success).toBe(false);
  });
});
