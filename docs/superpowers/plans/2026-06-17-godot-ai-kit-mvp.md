# godot-ai-kit MVP Implementation Plan(计划 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`). **执行约定**:本 plan 在**新会话**执行(fresh context),spec @ `9562c67` + plan1(load_skill P0 已完成,commits `04634b2..31f19ce` 在 enhanced)是干净起点。
>
> **v2 修订(2026-06-17)**: 审查必修 3 处已改——① Task 5 `dist/index.js`→`build/index.js`(package.json bin 实际输出 build/);② Task 4/6 load_skill 示例去 stage(plan1 P0 签名仅 query/libraries/limit,无 stage);③ Task 3 rules 列表改实际 5 个(原列 13 个有 8 个悬空)。

**Goal:** 建 `godot-ai-kit` 套件仓库 MVP——meta 仓库聚合 enhanced(执行)+ GodotPrompter/gd-agentic(知识)三子模块,粘合层(统一 CLAUDE.md + 5 阶段 workflow + install + 3D demo + boundaries)把它们编排成开箱即用的 AI Godot 开发环境。

**Architecture:** meta 仓库 + 三 git 子模块(enhanced 本地相对路径 + 两知识库 GitHub)+ 粘合层(只用指针/索引引用,不复制改写知识内容,LGPLv3 合规)。MVP 仅 Claude Code 单端。

**Tech Stack:** git submodules、markdown、PowerShell(install)、Claude Code config(`.claude/settings.json`)。

**关联 spec:** `docs/superpowers/specs/2026-06-17-godot-ai-kit-design.md` @ `9562c67`。**plan1**(load_skill P0)已完成,本 plan 前置。

## Global Constraints

- **位置**: `D:\GitHub\godot-ai-kit`(与 enhanced 平级,spec §11 #4)
- **三子模块**:
  - enhanced 本地相对路径: `git submodule add ../godot-mcp-enhanced enhanced`
  - GodotPrompter: `https://github.com/jame581/GodotPrompter`(分支 `master`,MIT)
  - gd-agentic-skills: `https://github.com/thedivergentai/gd-agentic-skills`(分支 `main`,**LGPLv3**)
- **粘合层只用指针/索引**,绝不复制或改写知识内容(LGPLv3 真聚合前提)
- **不修改任何子模块源文件**(LGPLv3 红线)
- **token 预算门禁**: `CLAUDE.md` ≤ 4KB,`rules/` 总 ≤ 8KB(spec §6.1/§8.3)
- **客户端**: MVP 仅 Claude Code(spec §8.2)
- **套件本体 MIT**,`NOTICE` 声明各组件来源/版本/许可证(spec §8.1)
- commit message conventional + 中文 + `Co-Authored-By: Claude <noreply@anthropic.com>`
- **load_skill P0 签名(plan1 实际)**: `query`(必填)+ `libraries?`(默认 env `GODOT_SKILL_LIBRARIES`)+ `limit?`。**无 stage**(stage 加权是 v1)。返回 `matches[]` 每项含 200 字符 `snippet` + `path`(需全文按 path 二次读)。

---

## File Structure(godot-ai-kit 仓库)

```
godot-ai-kit/
├─ 📦 子模块(.gitmodules)
│   ├─ enhanced/                ← ../godot-mcp-enhanced (本地,MIT,含 load_skill)
│   ├─ GodotPrompter/           ← github.com/jame581/GodotPrompter (MIT)
│   └─ gd-agentic-skills/       ← github.com/thedivergentai/gd-agentic-skills (LGPLv3)
├─ 🔗 粘合层
│   ├─ CLAUDE.md                ← 顶层规则(≤4KB,索引)
│   ├─ rules/                   ← enhanced 工具规则指针 + budget-guard(≤8KB)
│   ├─ workflow/                ← 5 阶段(concept/architecture/production/polish/delivery)
│   ├─ install.ps1              ← 一键安装(Claude 单端)
│   ├─ config/claude/settings.json  ← MCP server 配置
│   ├─ demo/                    ← 3D demo(概念+架构两阶段产出物)
│   └─ docs/enhanced-boundaries.md  ← §7 裂缝 + 降级
├─ compatibility-matrix.md / README.md / LICENSE(MIT) / NOTICE / .gitignore / .gitmodules
```

---

## Task 1: 仓库骨架 + enhanced 本地子模块

**Files:** Create `D:\GitHub\godot-ai-kit\`(git init)+ README.md/LICENSE/.gitignore;submodule `enhanced/`

- [ ] **Step 1: 建仓库 + git init**

```powershell
mkdir D:\GitHub\godot-ai-kit
cd D:\GitHub\godot-ai-kit
git init
git checkout -b main
```

- [ ] **Step 2: 基础文件**

`.gitignore`: `node_modules/` / `.godot/` / `*.tmp` / `*.log` / `.DS_Store`(子模块内部忽略由各自管)。

`LICENSE`: MIT 全文(版权 `2026 wgt`)。

`README.md`:
```markdown
# godot-ai-kit

AI Godot 开发环境套装——把 godot-mcp-enhanced(执行层)+ GodotPrompter/gd-agentic-skills(知识层)装进开箱即用的 Claude Code 工作区,用 Godot 专版 5 阶段工作流编排。

## 快速开始
```powershell
.\install.ps1
```

## 四家分工
- **enhanced**(子模块):动手 + 验证(读场景/写脚本/运行/验证)
- **GodotPrompter**(子模块):教 AI 写 Godot(写法规范,C# 双语)
- **gd-agentic-skills**(子模块):专家经验(NEVER 规则 + 27 游戏蓝图)
- **本仓库粘合层**:统一规则 + 5 阶段工作流 + install + demo

详见 spec:`enhanced/docs/superpowers/specs/2026-06-17-godot-ai-kit-design.md`。
```

- [ ] **Step 3: enhanced 本地子模块**

```powershell
cd D:\GitHub\godot-ai-kit
git submodule add ../godot-mcp-enhanced enhanced
git commit -m "chore: 初始化 godot-ai-kit + enhanced 本地子模块" -m "spec @ 9562c67 §3。enhanced 含 load_skill P0(plan1 完成)。" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 4: 验证**

```powershell
git submodule status enhanced   # 期望: commit hash + 路径,无错误
Test-Path enhanced\src\tools\load-skill.ts   # 期望: True
Test-Path enhanced\build\index.js            # 期望: True(若 enhanced 已构建);否则 install 时 npm run build 生成
```

---

## Task 2: 知识库子模块 + NOTICE

**Files:** submodule `GodotPrompter/`、`gd-agentic-skills/`;Create `NOTICE`

- [ ] **Step 1: 添加两知识库子模块**

```powershell
cd D:\GitHub\godot-ai-kit
git submodule add https://github.com/jame581/GodotPrompter GodotPrompter
git submodule add https://github.com/thedivergentai/gd-agentic-skills gd-agentic-skills
```

- [ ] **Step 2: NOTICE 文件**

`NOTICE`:
```
godot-ai-kit
Copyright 2026 wgt (MIT License)

本仓库是聚合(mere aggregation),各子模块保持独立、原样、可替换,各自许可证不变:

- enhanced/           godot-mcp-enhanced (MIT)         upstream: 本地 ../godot-mcp-enhanced
- GodotPrompter/      GodotPrompter by jame581 (MIT)   upstream: https://github.com/jame581/GodotPrompter
- gd-agentic-skills/  gd-agentic-skills by thedivergentai (LGPLv3)  upstream: https://github.com/thedivergentai/gd-agentic-skills

粘合层(CLAUDE.md/rules/workflow/install/demo/docs)只用指针/索引引用子模块内容,
不复制或改写任何知识源文件——LGPLv3 真聚合豁免的前提。
```

- [ ] **Step 3: commit + 验证**

```powershell
git add NOTICE .gitmodules GodotPrompter gd-agentic-skills
git commit -m "chore: 添加 GodotPrompter + gd-agentic-skills 子模块 + NOTICE" -m "spec §8.1。原样聚合,LGPLv3 真聚合。" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
git submodule status   # 期望: 三个子模块都有 commit hash
```

---

## Task 3: 统一 CLAUDE.md + rules/

**Files:** Create `CLAUDE.md`(≤4KB)、`rules/godot-mcp-index.md`、`rules/budget-guard.md`(rules/ 总 ≤8KB)

- [ ] **Step 1: 顶层 CLAUDE.md(按 spec §6.1,≤4KB)**

四块:① 定位(四家分工一句话+何时用谁);② 工具入口(enhanced MCP 工具速查:read_scene/write_script/run_and_verify/load_skill/validate_gdd/profiler/verify_delivery);③ 阶段索引("你在哪个阶段?"→ workflow/<阶段>.md);④ 加载约定(重内容用 load_skill 按需,不预载)。逐字照 spec §6.1,约束 ≤4KB。

- [ ] **Step 2: rules/ 指针 + token 门禁**

`rules/godot-mcp-index.md`:指针引用 enhanced 子模块的工具规则。**enhanced `.claude/rules/` 实际 5 个文件**(2026-06-17 Glob 确认):`godot-mcp-{core,bridge,editor,ui,recording}.md`。写明"详细规则在 `enhanced/.claude/rules/`,按需读这 5 个;其他子系统(particles/tilemap/animation 等)规则散落在 enhanced CLAUDE.md 或待建,执行时 Glob `enhanced/.claude/rules/*.md` 确认实际清单"。

`rules/budget-guard.md`:token 预算门禁——`rules/` 总 ≤8KB、CLAUDE.md ≤4KB、超限下沉 load_skill;CI 检查说明。

- [ ] **Step 3: 验证 token 预算 + commit**

```powershell
$content = (Get-Content CLAUDE.md -Raw).Length
Write-Host "CLAUDE.md: $content bytes (限 4096)"
$rules = (Get-ChildItem rules -Recurse -Filter *.md | ForEach-Object { (Get-Content $_.FullName -Raw).Length } | Measure-Object -Sum).Sum
Write-Host "rules/: $rules bytes (限 8192)"
git add CLAUDE.md rules
git commit -m "feat: 统一 CLAUDE.md + rules(token 门禁)" -m "spec §6.1/§8.3。顶层 ≤4KB,rules/ ≤8KB 指针(enhanced 实际 5 个规则文件)。" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```
期望: CLAUDE.md ≤ 4096、rules/ ≤ 8192。

---

## Task 4: workflow/ Godot 专版 5 阶段

**Files:** Create `workflow/{concept,architecture,production,polish,delivery}.md` + `workflow/README.md`

- [ ] **Step 1: 5 阶段文件(按 spec §6.3 表)**

每文件结构:① 阶段目标;② 知识输入(load_skill 示例);③ 执行闭环(enhanced 工具);④ 产出;⑤ 降级(引用 docs/enhanced-boundaries.md)。

> **⚠️ load_skill 调用约定**: plan1 P0 签名**仅 `query`/`libraries`/`limit`,无 `stage`**(stage 加权是 v1,spec §5.3)。下面示例的 stage 标注是**v1 预留语义提示**,执行 P0 调用时**只传 query**(去掉 stage)。

逐阶段(照 §6.3 表):
- `concept.md`(stage 语义=concept): gd-agentic 蓝图 → `load_skill(query="3D platformer collectible")` → `validate_gdd` → 轻量 GDD
- `architecture.md`(stage=architecture): gd-agentic 决策矩阵 → `load_skill(query="scene split autoload signal architecture")` → `read_scene`/`add_node`/`save_scene` → 场景树+ADR
- `production.md`(stage=production): gd-agentic NEVER + GodotPrompter → `load_skill(query="CharacterBody3D movement NEVER")` → `write_script`/`batch_add_nodes`/`run_and_verify` → 可运行构建
- `polish.md`(stage=polish): GodotPrompter 性能 → `load_skill(query="performance draw call")` → `profiler`/`validate_scripts` → 性能达标
- `delivery.md`(stage=delivery): CCGS checklist 借鉴 → `load_skill(query="release review checklist")` → `verify_delivery` → 发版包

> **query 语言提示**: gd-agentic/GodotPrompter skill 多为英文,P0 检索是大小写不敏感 substring 匹配——**query 用英文关键词更准**(中文词在英文 skill 上可能 miss)。执行时 query 用英文。

- [ ] **Step 2: workflow/README.md(硬闭环诚实化)**

说明 5 阶段顺序 + **诚实化措辞**(spec §6.3):"每阶段**约定调用 enhanced 验证工具 + 阶段门禁**(靠 AI 遵守约定 + 文档要求贴验证结果)。enhanced 工具能验证、不能阻止跳阶段。与 CCGS 区别:CCGS 靠 AI 自觉读 markdown,本工作流每阶段强制调用验证工具。"

- [ ] **Step 3: commit**

```powershell
git add workflow
git commit -m "feat: workflow Godot 专版 5 阶段" -m "spec §6.3。load_skill 示例(P0 无 stage,query 英文)。硬闭环诚实化。" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: install.ps1(Claude 单端)+ config

**Files:** Create `install.ps1`、`config/claude/settings.json`

- [ ] **Step 1: install.ps1(7 步,按 spec §6.2)**

`install.ps1`——7 步:① 前置检查(Godot 4.5+/Node 20+/git,缺失报错+指引);② `git submodule update --init --recursive`;③ `Push-Location enhanced; npm install; npm run build; Pop-Location`(构建输出 `enhanced/build/index.js`,package.json bin 实际路径);④ 复制 `config/claude/settings.json` → 用户 `.claude/settings.json`(或项目级);⑤ 在 settings.json 的 env 写 `GODOT_SKILL_LIBRARIES` 指向 `GodotPrompter/skills` + `gd-agentic-skills/skills`(供 load_skill 扫描);⑥ Claude Code 单端(MVP,跳过 Cursor/Cline);⑦ 自检(调 enhanced `validate_scripts` 离线验证链路)。任一步失败明确报错不静默。**注意**: ④⑤ 不要重复写 env(只在 settings.json 的 mcpServers.env 写一次 GODOT_SKILL_LIBRARIES)。

- [ ] **Step 2: config/claude/settings.json(MCP server,build 路径)**

`config/claude/settings.json`:
```json
{
  "mcpServers": {
    "godot-mcp-enhanced": {
      "command": "node",
      "args": ["D:\\GitHub\\godot-ai-kit\\enhanced\\build\\index.js"],
      "env": {
        "GODOT_SKILL_LIBRARIES": "D:\\GitHub\\godot-ai-kit\\GodotPrompter\\skills,D:\\GitHub\\godot-ai-kit\\gd-agentic-skills\\skills"
      }
    }
  }
}
```
(路径 `build/index.js` 对应 package.json:16 `bin=./build/index.js`)

- [ ] **Step 3: 验证语法 + commit**

```powershell
$null = [System.Management.Automation.PSParser]::Tokenize((Get-Content install.ps1 -Raw), [ref]$null)
Write-Host "install.ps1 语法 OK"
Get-Content config/claude/settings.json -Raw | ConvertFrom-Json | Out-Null
Write-Host "settings.json JSON OK"
git add install.ps1 config
git commit -m "feat: install.ps1(Claude 单端)+ MCP 配置" -m "spec §6.2/§8.2。settings.json 用 build/index.js(package.json bin),GODOT_SKILL_LIBRARIES 配 load_skill。" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: demo/ 3D(概念+架构两阶段)

**Files:** Create `demo/README.md`、`demo/docs/01-concept-gdd.md`、`demo/docs/02-architecture-adr.md`、`demo/scenes/`(骨架)

- [ ] **Step 1: demo README**

`demo/README.md`:3D demo 说明(第三人称角色+收集物,中等复杂度)+ 5 阶段产出物索引(MVP 只填①②,③④⑤ v1)。3D 因 enhanced 截图 3D 可靠(§6.4);2D 短板在 docs/enhanced-boundaries.md。

- [ ] **Step 2: ① 概念阶段产出**

`demo/docs/01-concept-gdd.md`:轻量 GDD(游戏概念/核心机制/3D platformer 收集物),顶部标注 `load_skill(query="3D platformer collectible")` 检索 gd-agentic 蓝图示例(P0 无 stage)。**load_skill 返回 200 字符 snippet + path——需蓝图全文时按 path 二次读**(plan1 P0 行为)。末尾 `validate_gdd` 通过记录。

- [ ] **Step 3: ② 架构阶段产出**

`demo/docs/02-architecture-adr.md`:ADR(场景拆分/autoload/信号架构)+ 场景树设计,顶部标注 `load_skill(query="scene split autoload signal architecture")` 检索 gd-agentic 决策矩阵示例(P0 无 stage,snippet+path)。`demo/scenes/player.tscn` 骨架(CharacterBody3D+MeshInstance3D+Camera3D),用 enhanced `add_node`+`save_scene` 生成(执行时跑)。

- [ ] **Step 4: commit**

```powershell
git add demo
git commit -m "feat: demo 3D(概念+架构两阶段)" -m "spec §6.4/§9 MVP。演示 load_skill(P0 snippet+path)+enhanced 协作。③④⑤ v1。" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: enhanced-boundaries + compatibility-matrix

**Files:** Create `docs/enhanced-boundaries.md`、`compatibility-matrix.md`

- [ ] **Step 1: enhanced-boundaries.md(按 spec §7 全表)**

逐条(spec §7 的 9 行):autoload 盲区(⚠️M4/M5 争议)、Edit tab、CRLF、validate_scripts 不一致(最致命,交叉确认)、重复幂等、超时、2D 截图(Bridge 不可靠,MVP 2D 需人工介入)、确认令牌/GateGuard、run_and_verify 残留进程。每条:影响阶段+降级方案+降级可靠性。原则段:"降级路径自身不可靠时标'需人工介入',不假装自动化。"

- [ ] **Step 2: compatibility-matrix.md**

套件版本 × enhanced/GodotPrompter/gd-agentic 版本 × Godot 版本矩阵。MVP 行:godot-ai-kit v0.1.0 × enhanced(fix/review-verification @ 31f19ce)× GodotPrompter(master HEAD)× gd-agentic(main HEAD)× Godot 4.5+。标注"CI 实跑 demo 全流程才标绿(spec §8.4),MVP 手动验证"。

- [ ] **Step 3: commit**

```powershell
git add docs enhanced-boundaries.md compatibility-matrix.md
git commit -m "docs: enhanced-boundaries + compatibility-matrix" -m "spec §7 裂缝降级 + §8.4 CI 矩阵。MVP 手动验证,CI v1。" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Exit Criteria(spec §9 套件 MVP)

- [ ] 仓库 `D:\GitHub\godot-ai-kit` git init + 三子模块聚合生效
- [ ] CLAUDE.md(≤4KB)+ rules/(≤8KB token 门禁,引用 enhanced 实际 5 个规则)
- [ ] workflow 5 阶段(load_skill 示例 P0 无 stage,query 英文 + enhanced 闭环 + 降级)
- [ ] install.ps1(Claude 单端)7 步 + settings.json(`build/index.js` + GODOT_SKILL_LIBRARIES)
- [ ] demo 3D 概念+架构两阶段(load_skill snippet+path)
- [ ] enhanced-boundaries(§7 全裂缝)+ compatibility-matrix
- [ ] NOTICE 声明三子模块许可证(LGPLv3 真聚合)
- [ ] **dogfood**:维护者用 MVP 跑 demo ①②,验证 load_skill + enhanced 链路通

(套件 v1:工作流 5 阶段完整 + load_skill L2/L3/L5;v2:Cursor/Cline + CI 矩阵自动化)

---

## Self-Review(v2,审查后)

**必修 3 处已改**:
- ✅ Task 5 `dist/index.js`→`build/index.js`(package.json:16 bin 实际 build/)
- ✅ Task 4/6 load_skill 示例去 stage(plan1 P0 签名 query/libraries/limit 无 stage)+ 加 v1 预留注 + query 英文提示
- ✅ Task 3 rules 13→实际 5 个(core/bridge/editor/ui/recording,Glob 确认)+ 其余泛指

**ADVISORY(执行时处理,不改 plan)**:
- load_skill P0 返回 200 字符 snippet(非完整内容)——Task 6 已加"按 path 二次读"注
- query 中文词在英文 skill 匹配存疑——Task 4 已加"query 用英文"提示
- spec §5.1 对 gd-agentic 结构描述过时——spec 层修正(可选,单独)
- enhanced 子模块相对路径发布受限(本地 OK,push GitHub 时子模块 URL 需改绝对)——执行 Task 1 时若套件仓库要 push,改 .gitmodules enhanced URL 为 GitHub
- install 第④⑤步冗余——Task 5 已加"不要重复写 env"注

**Spec coverage**: §3/§6.1/§6.2/§6.3/§6.4/§7/§8.1-8.4/§9 全覆盖。**Consistency**: 子模块 URL/路径、token 预算、build 路径、load_skill 签名(plan1 一致)跨 task 一致。

无问题,plan 可执行。
