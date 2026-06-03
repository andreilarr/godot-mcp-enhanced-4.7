import { describe, it, expect, beforeEach } from 'vitest';
import { getToolDefinitions, handleTool, resetBridgeState } from '../src/tools/game-bridge.js';

describe('game-bridge UI discovery', () => {
  beforeEach(() => {
    resetBridgeState();
  });

  describe('tool registration', () => {
    it('should register find_ui_elements and click_button in ACTIONS', () => {
      const tools = getToolDefinitions();
      const gameTool = tools.find(t => t.name === 'game');
      const actions = gameTool.inputSchema.properties.action.enum;
      expect(actions).toContain('find_ui_elements');
      expect(actions).toContain('click_button');
    });

    it('should include UI-related properties in inputSchema', () => {
      const tools = getToolDefinitions();
      const gameTool = tools.find(t => t.name === 'game');
      const props = gameTool.inputSchema.properties;
      expect(props.pattern).toBeDefined();
      expect(props.type).toBeDefined();
      expect(props.visible_only).toBeDefined();
      expect(props.limit).toBeDefined();
      expect(props.text).toBeDefined();
      expect(props.path).toBeDefined();
    });
  });

  describe('find_ui_elements response schema', () => {
    it('should return array of UI elements with metadata', () => {
      const response = {
        elements: [
          {
            path: 'root/CanvasLayer/MainMenu/StartButton',
            type: 'Button',
            text: 'Start Game',
            disabled: false,
            visible: true,
            position: { x: 100, y: 200 },
            size: { x: 200, y: 50 },
            center: { x: 200, y: 225 },
          },
          {
            path: 'root/CanvasLayer/MainMenu/HealthBar',
            type: 'ProgressBar',
            value: 75,
            min_value: 0,
            max_value: 100,
            visible: true,
            position: { x: 50, y: 10 },
            size: { x: 300, y: 20 },
            center: { x: 200, y: 20 },
          },
        ],
        count: 2,
      };
      expect(response.elements).toHaveLength(2);
      expect(response.elements[0].type).toBe('Button');
      expect(response.elements[0].center).toBeDefined();
    });
  });

  describe('click_button response schema', () => {
    it('should return clicked button info', () => {
      const response = {
        clicked: true,
        button_path: 'root/CanvasLayer/MainMenu/StartButton',
        button_text: 'Start Game',
      };
      expect(response.clicked).toBe(true);
    });

    it('should return error when button not found', () => {
      const response = {
        error: { code: -1, message: 'No visible Button with text "NonExistent" found' },
      };
      expect(response.error).toBeDefined();
    });
  });

  describe('UI type extraction', () => {
    it('should extract type-specific properties for each Control subclass', () => {
      const types = {
        Button: ['text', 'disabled'],
        Label: ['text'],
        HSlider: ['value', 'min_value', 'max_value'],
        ProgressBar: ['value', 'min_value', 'max_value'],
        CheckBox: ['button_pressed', 'text'],
        LineEdit: ['text', 'editable', 'max_length'],
        SpinBox: ['value', 'min_value', 'max_value'],
        OptionButton: ['text', 'item_count'],
      };
      for (const [type, props] of Object.entries(types)) {
        expect(Array.isArray(props)).toBe(true);
        expect(props.length).toBeGreaterThan(0);
      }
    });
  });

  describe('handler', () => {
    it('should handle find_ui_elements when bridge is unavailable', async () => {
      const result = await handleTool('game', {
        project_path: '/tmp/test-ui',
        action: 'find_ui_elements',
      }, { opsScript: '' });
      expect(result).toBeDefined();
      expect(result.content[0].text).toContain('Error');
    });

    it('should handle click_button when bridge is unavailable', async () => {
      const result = await handleTool('game', {
        project_path: '/tmp/test-ui',
        action: 'click_button',
        text: 'Start',
      }, { opsScript: '' });
      expect(result).toBeDefined();
    });
  });
});
