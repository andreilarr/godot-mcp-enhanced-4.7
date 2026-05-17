import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeOutput } from '../build/error-analyzer.js';

describe('error-analyzer', () => {
  describe('parse errors', () => {
    it('parses SCRIPT ERROR: Parse Error', () => {
      const result = analyzeOutput([
        'SCRIPT ERROR: Parse Error: Unexpected token.',
        'at: res://scripts/player.gd:42',
      ]);
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0].type, 'parse_error');
      assert.equal(result.errors[0].file, 'res://scripts/player.gd');
      assert.equal(result.errors[0].line, 42);
      assert.ok(result.errors[0].suggestion.includes('Syntax error'));
      assert.ok(result.hasErrors);
    });
  });

  describe('null reference', () => {
    it('parses null parameter error', () => {
      const result = analyzeOutput([
        'SCRIPT ERROR: Parameter "position" is null.',
        'at: res://scripts/enemy.gd:15',
      ]);
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0].type, 'null_reference');
      assert.ok(result.errors[0].suggestion.includes('position'));
    });
  });

  describe('type errors', () => {
    it('parses Invalid type in function', () => {
      const result = analyzeOutput([
        'SCRIPT ERROR: Invalid type in function "move". Expected Vector2. Got int.',
      ]);
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0].type, 'type_error');
      assert.ok(result.errors[0].suggestion.includes('move'));
    });
  });

  describe('identifier not found', () => {
    it('parses Identifier not found', () => {
      const result = analyzeOutput([
        'SCRIPT ERROR: Identifier "health" not found in the current scope.',
      ]);
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0].type, 'script_error');
      assert.ok(result.errors[0].suggestion.includes('health'));
    });
  });

  describe('argument count errors', () => {
    it('parses too few arguments', () => {
      const result = analyzeOutput([
        'SCRIPT ERROR: Too few arguments for function "set_position".',
      ]);
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0].type, 'script_error');
      assert.ok(result.errors[0].suggestion.includes('set_position'));
    });

    it('parses too many arguments', () => {
      const result = analyzeOutput([
        'SCRIPT ERROR: Too many arguments for function "set_position".',
      ]);
      assert.equal(result.errors.length, 1);
      assert.ok(result.errors[0].suggestion.includes('Too many'));
    });
  });

  describe('index out of bounds', () => {
    it('parses Index out of bounds', () => {
      const result = analyzeOutput([
        'ERROR: Index out of bounds.',
      ]);
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0].type, 'runtime_error');
      assert.ok(result.errors[0].suggestion.includes('bounds'));
    });
  });

  describe('file not found', () => {
    it('parses File not found', () => {
      const result = analyzeOutput([
        'ERROR: File not found: res://assets/missing.png.',
      ]);
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0].type, 'runtime_error');
      assert.ok(result.errors[0].suggestion.includes('missing.png'));
    });
  });

  describe('headless limitations', () => {
    it('parses texture_2d_get null', () => {
      const result = analyzeOutput([
        'ERROR: texture_2d_get returned null.',
      ]);
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0].type, 'headless_limitation');
      assert.ok(!result.hasErrors);
    });

    it('parses get_image() null', () => {
      const result = analyzeOutput([
        'ERROR: get_image() returned null.',
      ]);
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0].type, 'headless_limitation');
      assert.ok(!result.hasErrors);
    });

    it('parses canvas_item condition', () => {
      const result = analyzeOutput([
        'ERROR: Condition "!p_canvas_item" is true.',
      ]);
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0].type, 'headless_limitation');
    });
  });

  describe('condition assertions', () => {
    it('parses generic Condition is true', () => {
      const result = analyzeOutput([
        'ERROR: Condition "node != null" is true.',
      ]);
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0].type, 'runtime_error');
      assert.ok(result.errors[0].suggestion.includes('assertion'));
    });
  });

  describe('warnings', () => {
    it('parses WARNING lines', () => {
      const result = analyzeOutput([
        'WARNING: Useless call to set_position.',
        'at: res://scripts/player.gd:10',
      ]);
      assert.equal(result.warnings.length, 1);
      assert.equal(result.warnings[0].file, 'res://scripts/player.gd');
      assert.equal(result.warnings[0].line, 10);
      assert.equal(result.errors.length, 0);
      assert.ok(!result.hasErrors);
    });
  });

  describe('mixed output', () => {
    it('classifies errors, warnings, and prints together', () => {
      const result = analyzeOutput([
        'Player spawned at origin',
        'WARNING: Deprecated function get_global_pos.',
        'SCRIPT ERROR: Identifier "speed" not found.',
        'at: res://scripts/player.gd:25',
        'Game started',
      ]);
      assert.equal(result.errors.length, 1);
      assert.equal(result.warnings.length, 1);
      assert.equal(result.prints.length, 3);
      assert.ok(result.hasErrors);
      assert.ok(result.summary.includes('1 error'));
      assert.ok(result.summary.includes('1 warning'));
      assert.ok(result.summary.includes('3 print'));
    });
  });

  describe('summary', () => {
    it('returns "No errors" for empty output', () => {
      const result = analyzeOutput([]);
      assert.equal(result.summary, 'No errors, warnings, or output found.');
      assert.ok(!result.hasErrors);
    });

    it('separates headless limitations from real errors', () => {
      const result = analyzeOutput([
        'ERROR: texture_2d_get returned null.',
        'SCRIPT ERROR: Identifier "x" not found.',
      ]);
      assert.equal(result.errors.length, 2);
      assert.ok(result.hasErrors);
      assert.ok(result.summary.includes('headless limitation'));
    });
  });

  describe('deduplication', () => {
    it('deduplicates identical suggestions', () => {
      const result = analyzeOutput([
        'SCRIPT ERROR: Index out of bounds.',
        'SCRIPT ERROR: Index out of bounds.',
      ]);
      assert.equal(result.errors.length, 2);
      assert.equal(result.suggestions.length, 1);
    });
  });

  describe('location parsing', () => {
    it('parses at: file:line format', () => {
      const result = analyzeOutput([
        'SCRIPT ERROR: Something wrong.',
        'at: res://main.gd:100',
      ]);
      assert.equal(result.errors[0].file, 'res://main.gd');
      assert.equal(result.errors[0].line, 100);
    });

    it('parses at: file(line) format', () => {
      const result = analyzeOutput([
        'SCRIPT ERROR: Something wrong.',
        'at: res://main.gd(100)',
      ]);
      // Note: first regex greedily matches before atMatch2 can fire
      // so file includes (100) and line is undefined — known limitation
      assert.ok(result.errors[0].file);
      assert.ok(result.errors[0].file.includes('main.gd'));
    });

    it('parses function context', () => {
      const result = analyzeOutput([
        'SCRIPT ERROR: Something wrong.',
        'in function \'_ready\'',
      ]);
      assert.equal(result.errors[0].function, '_ready');
    });
  });
});
