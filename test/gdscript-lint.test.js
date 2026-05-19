import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lintGDScript } from '../build/tools/gdscript-lint.js';

describe('GDScript Lint', () => {
  it('returns empty results for clean code', () => {
    const code = 'extends Node3D\n\nfunc _ready():\n\tpass';
    const result = lintGDScript(code, true);
    assert.equal(result.errors.length, 0);
    assert.equal(result.warnings.length, 0);
    assert.equal(result.meta.godot_target, '4.6');
  });

  it('returns meta information', () => {
    const result = lintGDScript('', true);
    assert.ok(result.meta.rules_count >= 0);
    assert.ok(result.meta.last_reviewed);
  });

  // L003
  describe('L003 CylinderMesh.radius', () => {
    it('命中: CylinderMesh_inst.radius 赋值', () => {
      assert.ok(lintGDScript('CylinderMesh.radius = 0.5', true).errors.some(e => e.rule === 'L003'));
    });
    it('忽略: SphereMesh.radius 合法', () => {
      assert.ok(!lintGDScript('var mesh := SphereMesh.new()\nmesh.radius = 0.5', true).errors.some(e => e.rule === 'L003'));
    });
    it('边界: 变量名包含 radius', () => {
      assert.ok(!lintGDScript('var cylinder_radius = 0.5', true).errors.some(e => e.rule === 'L003'));
    });
  });

  // L004
  describe('L004 Environment.adjustments_*', () => {
    it('命中: adjustments_enabled 赋值', () => {
      assert.ok(lintGDScript('env.adjustments_enabled = true', true).errors.some(e => e.rule === 'L004'));
    });
    it('忽略: adjustment_enabled 正确', () => {
      assert.ok(!lintGDScript('env.adjustment_enabled = true', true).errors.some(e => e.rule === 'L004'));
    });
    it('边界: 注释中不触发', () => {
      assert.ok(!lintGDScript('# adjustments_enabled is deprecated', true).errors.some(e => e.rule === 'L004'));
    });
  });

  // L005
  describe('L005 Environment.tone_mapper', () => {
    it('命中: tone_mapper 赋值', () => {
      assert.ok(lintGDScript('env.tone_mapper = 1', true).errors.some(e => e.rule === 'L005'));
    });
    it('忽略: tonemap_mode 正确', () => {
      assert.ok(!lintGDScript('env.tonemap_mode = 1', true).errors.some(e => e.rule === 'L005'));
    });
    it('边界: 变量名', () => {
      assert.ok(!lintGDScript('var tone_mapper_value = 1', true).errors.some(e => e.rule === 'L005'));
    });
  });

  // L006
  describe('L006 SoftBody3D.mass', () => {
    it('命中: SoftBody3D.mass 赋值', () => {
      assert.ok(lintGDScript('SoftBody3D.mass = 2.0', true).errors.some(e => e.rule === 'L006'));
    });
    it('忽略: RigidBody3D.mass 合法', () => {
      assert.ok(!lintGDScript('var body := RigidBody3D.new()\nbody.mass = 2.0', true).errors.some(e => e.rule === 'L006'));
    });
    it('边界: 变量名', () => {
      assert.ok(!lintGDScript('var softbody_mass = 2.0', true).errors.some(e => e.rule === 'L006'));
    });
  });

  // L008
  describe('L008 ArrayMesh.create_triangle_shape', () => {
    it('命中: create_triangle_shape 调用', () => {
      assert.ok(lintGDScript('mesh.create_triangle_shape()', true).errors.some(e => e.rule === 'L008'));
    });
    it('忽略: create_triangle_mesh 正确', () => {
      assert.ok(!lintGDScript('mesh.create_triangle_mesh()', true).errors.some(e => e.rule === 'L008'));
    });
    it('边界: 注释中不触发', () => {
      assert.ok(!lintGDScript('# mesh.create_triangle_shape()', true).errors.some(e => e.rule === 'L008'));
    });
  });

  // L009
  describe('L009 Node.get_child_or_null', () => {
    it('命中: get_child_or_null 调用', () => {
      assert.ok(lintGDScript('var child = get_child_or_null(0)', true).errors.some(e => e.rule === 'L009'));
    });
    it('忽略: get_child 正确', () => {
      assert.ok(!lintGDScript('var child = get_child(0)', true).errors.some(e => e.rule === 'L009'));
    });
    it('边界: 注释中不触发', () => {
      assert.ok(!lintGDScript('# get_child_or_null', true).errors.some(e => e.rule === 'L009'));
    });
  });

  // L010
  describe('L010 FogMaterial.albedo_color', () => {
    it('命中: FogMaterial.albedo_color 赋值', () => {
      const r = lintGDScript('FogMaterial.albedo_color = Color.RED', true);
      assert.ok(r.errors.some(e => e.rule === 'L010'));
      const l010 = r.errors.find(e => e.rule === 'L010');
      assert.ok(l010.suggestion.includes('albedo'));
      assert.ok(!l010.suggestion.includes('emission'));
    });
    it('忽略: FogMaterial.albedo 正确', () => {
      assert.ok(!lintGDScript('var fog := FogMaterial.new()\nfog.albedo = Color.RED', true).errors.some(e => e.rule === 'L010'));
    });
    it('边界: FogMaterial.emission 合法', () => {
      assert.ok(!lintGDScript('var fog := FogMaterial.new()\nfog.emission = Color.RED', true).errors.some(e => e.rule === 'L010'));
    });
  });

  // L011
  describe('L011 Environment.physically_based_lights_enabled', () => {
    it('命中: physically_based_lights_enabled 赋值', () => {
      assert.ok(lintGDScript('env.physically_based_lights_enabled = true', true).errors.some(e => e.rule === 'L011'));
    });
    it('忽略: 其他属性', () => {
      assert.ok(!lintGDScript('env.ambient_light_source = 1', true).errors.some(e => e.rule === 'L011'));
    });
    it('边界: 注释中不触发', () => {
      assert.ok(!lintGDScript('# physically_based_lights_enabled', true).errors.some(e => e.rule === 'L011'));
    });
  });

  // L012
  describe('L012 Line2D.dash_pattern', () => {
    it('命中: dash_pattern 使用普通数组', () => {
      assert.ok(lintGDScript('line.dash_pattern = [1.0, 2.0]', true).errors.some(e => e.rule === 'L012'));
    });
    it('忽略: PackedFloat32Array 正确', () => {
      assert.ok(!lintGDScript('line.dash_pattern = PackedFloat32Array([1.0, 2.0])', true).errors.some(e => e.rule === 'L012'));
    });
    it('边界: 变量间接赋值', () => {
      assert.ok(!lintGDScript('var p := PackedFloat32Array([1, 2])\nline.dash_pattern = p', true).errors.some(e => e.rule === 'L012'));
    });
  });

  // L013
  describe('L013 CharacterBody3D.body_entered', () => {
    it('命中: CharacterBody3D 使用 body_entered', () => {
      assert.ok(lintGDScript('CharacterBody3D.body_entered.connect(_on_enter)', true).errors.some(e => e.rule === 'L013'));
    });
    it('忽略: Area3D 使用 body_entered 合法', () => {
      assert.ok(!lintGDScript('extends Area3D\narea.body_entered.connect(_on_enter)', true).errors.some(e => e.rule === 'L013'));
    });
    it('边界: 注释中不触发', () => {
      assert.ok(!lintGDScript('# body_entered signal', true).errors.some(e => e.rule === 'L013'));
    });
  });

  // L002
  describe('L002 RigidBody3D.bounce', () => {
    it('命中: RigidBody3D.bounce 直接赋值', () => {
      assert.ok(lintGDScript('var rb := RigidBody3D.new()\nrb.bounce = 0.4', true).errors.some(e => e.rule === 'L002'));
    });
    it('忽略: PhysicsMaterial.bounce 合法', () => {
      assert.ok(!lintGDScript('var phys_mat := PhysicsMaterial.new()\nphys_mat.bounce = 0.4', true).errors.some(e => e.rule === 'L002'));
    });
    it('边界: 注释中不触发', () => {
      assert.ok(!lintGDScript('# rb.bounce = 0.4', true).errors.some(e => e.rule === 'L002'));
    });
  });

  // L007
  describe('L007 Node3D.visibility_range_*', () => {
    it('命中: Node3D 上下文引用 visibility_range', () => {
      assert.ok(lintGDScript('var node := Node3D.new()\nnode.visibility_range_begin = 5.0', true).errors.some(e => e.rule === 'L007'));
    });
    it('忽略: MeshInstance3D 合法', () => {
      assert.ok(!lintGDScript('var mesh := MeshInstance3D.new()\nmesh.visibility_range_begin = 5.0', true).errors.some(e => e.rule === 'L007'));
    });
    it('边界: 注释中不触发', () => {
      assert.ok(!lintGDScript('# visibility_range_begin', true).errors.some(e => e.rule === 'L007'));
    });
  });
});
