import { promises as fs } from 'fs';
import { join, basename, isAbsolute, relative } from 'path';

export interface SkillMatch {
  source: string;
  path: string;
  name: string;
  description: string;
  score: number;
  snippet: string;
}

export interface MissingLibrary {
  path: string;
  reason: string;
}

export interface SearchResult {
  matches: SkillMatch[];
  missing: MissingLibrary[];
}

interface ParsedSkill {
  name: string;
  description: string;
  body: string;
}

function parseSkill(content: string, fallbackName: string): ParsedSkill {
  let name = fallbackName;
  let description = '';
  let body = content;
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (fm) {
    const frontmatter = fm[1] ?? '';
    body = fm[2] ?? '';
    const nm = frontmatter.match(/^name:\s*(.+)$/m);
    if (nm?.[1]) name = nm[1].trim();
    const dm = frontmatter.match(/^description:\s*(.+)$/m);
    if (dm?.[1]) description = dm[1].trim();
  }
  return { name, description, body };
}

function scoreMatch(query: string, name: string, description: string, body: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  const n = name.toLowerCase();
  const d = description.toLowerCase();
  const b = body.toLowerCase();
  let total = 0;
  for (const term of terms) {
    let s = 0;
    if (n.includes(term)) s = Math.max(s, 1.0);
    if (d.includes(term)) s = Math.max(s, 0.6);
    if (b.includes(term)) s = Math.max(s, 0.3);
    total += s;
  }
  return total / terms.length;
}

async function* walkMd(dir: string): AsyncGenerator<string> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMd(full);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      yield full;
    }
  }
}

function validateLibraryPath(p: string): { ok: true } | { ok: false; reason: string } {
  if (!p || typeof p !== 'string' || p.trim() === '') return { ok: false, reason: 'empty path' };
  if (p.includes('..')) return { ok: false, reason: 'traversal detected' };
  if (!isAbsolute(p)) return { ok: false, reason: 'not absolute path' };
  return { ok: true };
}

export async function searchSkills(
  libraries: string[],
  query: string,
  limit = 10
): Promise<SearchResult> {
  const matches: SkillMatch[] = [];
  const missing: MissingLibrary[] = [];
  const q = (query ?? '').trim();

  for (const lib of libraries) {
    const v = validateLibraryPath(lib);
    if (!v.ok) {
      missing.push({ path: lib, reason: v.reason });
      continue;
    }
    let real: string;
    try {
      real = await fs.realpath(lib);
    } catch {
      missing.push({ path: lib, reason: 'not found' });
      continue;
    }
    const source = basename(real);
    for await (const filePath of walkMd(real)) {
      let content: string;
      try {
        content = await fs.readFile(filePath, 'utf-8');
      } catch {
        continue;
      }
      const { name, description, body } = parseSkill(content, basename(filePath, '.md'));
      const score = q ? scoreMatch(q, name, description, body) : 0;
      if (score > 0) {
        matches.push({
          source,
          path: relative(real, filePath) || filePath,
          name,
          description,
          score,
          snippet: body.slice(0, 200).trim(),
        });
      }
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return { matches: matches.slice(0, limit), missing };
}