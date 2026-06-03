import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LogReader } from '../../src/dashboard/log-reader.js';
import { writeFileSync, mkdirSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), 'godot-mcp-test-log-reader');

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});
afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function writeJsonlLine(filePath: string, obj: Record<string, unknown>): void {
  appendFileSync(filePath, JSON.stringify(obj) + '\n');
}

function todayFile(): string {
  const today = new Date().toISOString().slice(0, 10);
  return join(TEST_DIR, `${today}.jsonl`);
}

function makeEntry(msg: string): Record<string, unknown> {
  return { v: 1, level: 'info', module: 'test', msg, ts: new Date().toISOString() };
}

describe('LogReader', () => {
  it('should read existing entries on start', async () => {
    const file = todayFile();
    writeJsonlLine(file, makeEntry('hello'));
    writeJsonlLine(file, makeEntry('world'));

    const reader = new LogReader(TEST_DIR, { pollIntervalMs: 50 });
    const entries: unknown[] = [];
    reader.on('entries', (e: unknown[]) => entries.push(...e));
    await reader.start();

    expect(entries.length).toBeGreaterThanOrEqual(2);
    reader.stop();
  });

  it('should detect new entries after start', async () => {
    const file = todayFile();
    writeJsonlLine(file, makeEntry('initial'));

    const reader = new LogReader(TEST_DIR, { pollIntervalMs: 50 });
    const entries: unknown[] = [];
    reader.on('entries', (e: unknown[]) => entries.push(...e));
    await reader.start();

    const initialCount = entries.length;

    writeJsonlLine(file, makeEntry('new'));

    await new Promise(resolve => setTimeout(resolve, 200));

    expect(entries.length).toBeGreaterThan(initialCount);
    reader.stop();
  });

  it('should skip malformed lines and count them', async () => {
    const file = todayFile();
    writeJsonlLine(file, makeEntry('good'));
    appendFileSync(file, 'not json\n');
    writeJsonlLine(file, makeEntry('also good'));

    const reader = new LogReader(TEST_DIR, { pollIntervalMs: 50 });
    const entries: unknown[] = [];
    reader.on('entries', (e: unknown[]) => entries.push(...e));
    await reader.start();

    expect(entries.length).toBe(2);
    expect(reader.getSkippedCount()).toBe(1);
    reader.stop();
  });

  it('should emit empty array when no log file exists', async () => {
    const reader = new LogReader(TEST_DIR, { pollIntervalMs: 50 });
    const entries: unknown[] = [];
    reader.on('entries', (e: unknown[]) => entries.push(...e));
    await reader.start();

    expect(entries.length).toBe(0);
    reader.stop();
  });

  it('should emit error event when file read fails', async () => {
    const reader = new LogReader('/nonexistent/path/that/does/not/exist', { pollIntervalMs: 50 });
    const errors: Error[] = [];
    reader.on('error', (err: Error) => errors.push(err));

    await reader.start();
    await new Promise(resolve => setTimeout(resolve, 150));

    reader.stop();
  });

  it('should track skipped count across multiple reads', async () => {
    const file = todayFile();
    writeJsonlLine(file, makeEntry('ok1'));
    appendFileSync(file, '{bad\n');
    writeJsonlLine(file, makeEntry('ok2'));

    const reader = new LogReader(TEST_DIR, { pollIntervalMs: 50 });
    const entries: unknown[] = [];
    reader.on('entries', (e: unknown[]) => entries.push(...e));
    await reader.start();
    const initialSkipped = reader.getSkippedCount();

    appendFileSync(file, '{also bad\n');
    writeJsonlLine(file, makeEntry('ok3'));

    await new Promise(resolve => setTimeout(resolve, 200));

    expect(reader.getSkippedCount()).toBeGreaterThan(initialSkipped);
    reader.stop();
  });
});
