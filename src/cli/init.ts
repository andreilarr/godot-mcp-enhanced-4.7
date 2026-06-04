/** init 命令 — 创建 Godot 项目骨架 */
import { join } from 'path';
import { mkdirSync, existsSync, writeFileSync } from 'fs';

function parseInitArgs(args: string[]): { name: string; template: string } {
  const name = args[0] || 'my-game';
  let template = 'empty';
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--template=')) template = args[i].split('=')[1];
  }
  return { name, template };
}

/** 项目名称合法性校验：只允许字母、数字、连字符、下划线 */
const VALID_NAME = /^[a-zA-Z0-9_-]+$/;

export async function runInit(args: string[]): Promise<void> {
  const { name, template } = parseInitArgs(args);
  if (!VALID_NAME.test(name)) {
    console.error(`Invalid project name: "${name}". Use only letters, numbers, hyphens, and underscores.`);
    process.exit(1);
  }
  const projectDir = join(process.cwd(), name);

  if (existsSync(projectDir)) {
    console.error(`Directory already exists: ${projectDir}`);
    process.exit(1);
  }

  console.log(`Creating project "${name}" (template: ${template})...`);

  // 创建项目目录
  mkdirSync(projectDir, { recursive: true });

  // 写入最小 project.godot
  writeFileSync(join(projectDir, 'project.godot'), [
    '; Engine configuration file.',
    "; It's best edited using the editor UI and not directly.",
    '',
    '[application]',
    '',
    `config/name="${name}"`,
    '',
    '[display]',
    '',
    'window/size/viewport_width=1280',
    'window/size/viewport_height=720',
    '',
  ].join('\n'), 'utf-8');

  // 写入 scenes 目录
  mkdirSync(join(projectDir, 'scenes'), { recursive: true });

  // 提示运行 setup_project_rules
  console.log(`\n✓ Project created at ${projectDir}`);
  console.log('\nNext steps:');
  console.log(`  1. cd ${name}`);
  console.log('  2. Open in AI editor (Claude Code / Cursor)');
  console.log('  3. Run setup_project_rules to generate CLAUDE.md and hooks');
}
