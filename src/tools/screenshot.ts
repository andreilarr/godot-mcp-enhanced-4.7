import { isAbsolute, resolve, join, extname } from 'path';
import { existsSync, readFileSync } from 'fs';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext, ToolResult } from '../types.js';
import { textResult } from '../types.js';
import { opsErrorResult } from './shared.js';
import { captureScreenshot } from '../screenshot.js';
import { validatePath, requireProjectPath, resolveWithinRoot, normalizeUserProjectPath, allowOutsideProjectPaths, isPathInAllowedRoots } from '../helpers.js';

const TOOL_NAMES = ['screenshot'] as const;

export { TOOL_NAMES };

// ─── Tool definitions ──────────────────────────────────────────────────────

export function getToolDefinitions(): Tool[] {
  return [
    {
      name: 'screenshot',
      description: 'Screenshot capture and AI visual analysis. capture: capture a Godot scene screenshot in headless mode (experimental). analyze: return an image as base64 for AI visual analysis.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          project_path: { type: 'string', description: 'Path to Godot project directory' },
          action: {
            type: 'string',
            enum: ['capture', 'analyze'],
            description: 'Action type: capture (take a screenshot) or analyze (AI visual analysis of an image)',
          },
          // capture params
          scene: { type: 'string', description: 'capture: Scene file path relative to project (res://scenes/main.tscn). If omitted, captures the default scene or an empty viewport.' },
          output_path: { type: 'string', description: 'capture: Output PNG path (absolute). Defaults to <project_path>/screenshot.png' },
          frame_delay: { type: 'number', description: 'capture: Frames to wait before capture (default: 15)', default: 15 },
          viewport_width: { type: 'number', description: 'capture: Viewport width in pixels (default: 1280)', default: 1280 },
          viewport_height: { type: 'number', description: 'capture: Viewport height in pixels (default: 720)', default: 720 },
          // analyze params
          image_path: { type: 'string', description: 'analyze: Absolute path to the image file (PNG or JPG)' },
          question: { type: 'string', description: 'analyze: Question for the AI to answer about the image. Default: "Describe what you see in this game screenshot."', default: 'Describe what you see in this game screenshot. Focus on: UI elements, character positions, any visual issues or bugs.' },
        },
        required: ['project_path', 'action'],
      },
    },
  ];
}

// ─── Tool handler ───────────────────────────────────────────────────────────

export async function handleTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | null> {
  if (name !== 'screenshot') return null;

  const action = args.action as string;
  if (!action) return opsErrorResult('INVALID_PARAMS', '"action" is required (capture or analyze).');

  switch (action) {
    case 'capture': {
      const projectPath = requireProjectPath(args);
      const scene = args.scene as string | undefined;
      const outputPathRaw = args.output_path as string | undefined;
      const normalizedOutput = normalizeUserProjectPath(outputPathRaw ?? '');
      const outputPath = outputPathRaw?.trim()
        ? (allowOutsideProjectPaths()
            ? (() => {
                const p = validatePath(outputPathRaw);
                if (!isPathInAllowedRoots(p)) {
                  throw new Error(`Output path is outside allowed project roots: ${p}`);
                }
                return p;
              })()
            : resolveWithinRoot(projectPath, normalizedOutput))
        : join(projectPath, 'screenshot.png');
      const frameDelay = (args.frame_delay as number) || 15;
      const viewportW = (args.viewport_width as number) || 1280;
      const viewportH = (args.viewport_height as number) || 720;
      const godot = await ctx.findGodot();

      const result = await captureScreenshot({
        godotPath: godot,
        projectPath,
        scene,
        outputPath,
        frameDelay,
        viewportSize: { width: viewportW, height: viewportH },
        timeout: 30,
      });

      if (result.success) {
        // 双层空白检测：GDScript BLANK_DETECTED + TS 侧 fileSize 阈值
        let blankWarningAdded = false;
        let blankWarning = '';

        if (result.godotOutput?.includes('BLANK_DETECTED')) {
          blankWarning = '\n⚠ Screenshot may be blank (2D rendering limitation in headless mode).\n' +
            'For 2D projects, consider using screenshot(action=analyze) with a user-provided screenshot instead.';
          blankWarningAdded = true;
        } else if ((result.fileSize ?? 0) < 5120) {
          // 小文件（< 5KB）疑似空白，补充警告
          blankWarning = `\n⚠ Screenshot file is unusually small (${result.fileSize} bytes), possibly blank.\n` +
            'For 2D projects, consider using screenshot(action=analyze) with a user-provided screenshot instead.';
          blankWarningAdded = true;
        }

        return textResult(
          `Screenshot saved to: ${result.imagePath}\n` +
          `File size: ${result.fileSize} bytes\n` +
          `Viewport: ${viewportW}x${viewportH}\n` +
          `Frames waited: ${frameDelay}` +
          blankWarning +
          '\n\nUse screenshot with action=analyze to have the AI examine this image.'
        );
      } else {
        return textResult(
          `Screenshot failed: ${result.error}\n\n` +
          (result.godotOutput ? `Godot output:\n${result.godotOutput}\n\n` : '') +
          'Note: Screenshot capture is experimental. Headless rendering may not be available on all systems.'
        );
      }
    }

    case 'analyze': {
      let imagePath = args.image_path as string | undefined;
      const projectPathRaw = typeof args.project_path === 'string' ? args.project_path : undefined;
      const projectPath = projectPathRaw?.trim() ? validatePath(projectPathRaw) : undefined;
      const question = (args.question as string) ||
        'Describe what you see in this game screenshot. Focus on: UI elements, character positions, any visual issues or bugs.';

      if (imagePath) {
        if (allowOutsideProjectPaths()) {
          if (!isAbsolute(imagePath) && projectPath) {
            imagePath = resolve(projectPath, normalizeUserProjectPath(imagePath));
          }
          imagePath = validatePath(imagePath);
        } else {
          if (!projectPath) {
            return opsErrorResult('INVALID_PARAMS', 'project_path is required when ALLOW_OUTSIDE_PROJECT_PATHS is not set.');
          }
          imagePath = resolveWithinRoot(projectPath, normalizeUserProjectPath(imagePath));
        }
      } else if (projectPath) {
        imagePath = join(projectPath, 'screenshot.png');
      } else {
        return opsErrorResult('INVALID_PARAMS', 'either image_path or project_path is required.');
      }

      if (!existsSync(imagePath)) {
        return textResult(`Image not found: ${imagePath}`);
      }

      const imageBuffer = readFileSync(imagePath);
      const base64 = imageBuffer.toString('base64');
      const ext = extname(imagePath).toLowerCase();
      const mimeType = (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : 'image/png';

      return {
        content: [
          {
            type: 'image' as const,
            data: base64,
            mimeType,
          },
          {
            type: 'text' as const,
            text: question,
          },
        ],
      };
    }

    default:
      return textResult(`Unknown action: ${action}. Use "capture" or "analyze".`);
  }
}

export const TOOL_META: Record<string, { readonly: boolean; long_running: boolean }> = {
  screenshot: { readonly: true, long_running: false },
};
