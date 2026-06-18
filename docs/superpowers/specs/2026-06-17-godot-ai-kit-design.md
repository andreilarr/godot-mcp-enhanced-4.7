# godot-ai-kit 设计文档(暂定名)

> 日期: 2026-06-17
> 状态: 待批准(brainstorming 产出,spec 审查第 2 轮修订)
> 作者: wgt
> 关联:
> - `docs/research/四项目生态定位分析.md`(战略定位,走法 A)
> - `docs/superpowers/specs/2026-06-08-competitive-borrowing-design.md`(执行层增强)
> - `docs/superpowers/specs/2026-06-10-agent-architecture-design.md`(多 Agent/实例)
> 前置依赖: enhanced 的 `load_skill` 工具(本文 §5 定义其接口需求)

---

## 0. 一句话定位

**godot-ai-kit 是 enhanced `load_skill` 能力的产品化外壳**——一个 meta 仓库,把 GodotPrompter(知识) + gd-agentic-skills(知识) + godot-mcp-enhanced(执行) 装进开箱即用的 AI Godot 开发环境,并用自研的 Godot 专版 5 阶段工作流把它们串起来。enhanced 继续深耕执行层护城河,套件负责把"四家所长"零配置地交到用户手里。

**关键关系**: load_skill 是底座(enhanced 的能力),套件是外壳(产品化分发)。本套件**不是独立产品**,它建立在 enhanced 还没有的 `load_skill` 能力之上——见 §5。

---

## 1. 背景与战略锚点

### 1.1 为什么做套件

《四项目生态定位分析》给出三个事实:

1. AI Godot 开发栈分三层:知识层(GodotPrompter/gd-agentic)、流程层(CCGS)、执行层(enhanced)。
2. enhanced 的护城河是**执行闭环**(语法/运行/性能/交付四环可靠),是唯一能动手的层。
3. 战略走法 A(§6):**切勿自建知识库,做调度方,让 MCP 消费第三方知识库**。

套件是走法 A 的**产品化落地**——把"调度消费第三方知识库"从 enhanced 的一个工具(load_skill),包装成用户零配置就能用的完整环境。

### 1.2 与纯 load_skill 路线的关系

| | load_skill(enhanced 内) | godot-ai-kit(本套件) |
|---|---|---|
| 本质 | 一个 MCP 工具,运行时从用户本地知识库按需加载 | meta 仓库 + 粘合层,把四家装好并编排 |
| 谁维护知识 | 各家作者(GodotPrompter/gd-agentic) | 同左——套件不维护知识,只编排 |
| 角色 | 能力底座 | 产品外壳 |
| 顺序 | **先做**(P0) | **后做**(load_skill 成熟后做 MVP) |

**两者共存,关系是底座与外壳。本 spec 现在写,是为了锚定套件愿景 + 反推 load_skill 该长成什么样(§5)。**

### 1.3 目标用户

**熟练 Godot 开发者**:会用 Godot、想用 AI 提效、但不想折腾组装三家 + 配 MCP 的人。

- 价值主张:省去组装三家 + 配 MCP server + 调 skills 路径的折腾,且保证质量组合。
- 非目标用户(明确排除):
  - Godot 新手——要理解三家分工 + 5 阶段 + 多客户端,认知负担劝退(《四项目分析》研讨中确认)
  - 团队/企业——gd-agentic 的 LGPLv3 + 实验性(v0.0.6)是采用硬障碍
- MVP 阶段:**先自己 dogfood**(套件维护者自己用),验证四家组合真的 1+1+1>3,稳定后再对外。

---

## 2. 关键决策记录

| # | 决策 | 选择 | 理由 |
|---|------|------|------|
| D1 | 形态 | 发行套件(meta 仓库) | 规避内化知识层的许可证/维护风险,护城河不变 |
| D2 | 战略关系 | load_skill 底座 + 套件外壳 | 战略一致(走法 A),套件不偏离 |
| D3 | 实现顺序 | load_skill 先,套件 MVP 后 | 套件建在 load_skill 真实能力上,非空中楼阁 |
| D4 | CCGS | 借鉴不打包 | CCGS 引擎无关 + Claude Code 专属 + 49 agent 太重,打包会套娃且绑死平台 |
| D5 | 知识消费 | load_skill 运行时读本地库;粘合层只用指针 | 法理安全(真聚合,不触发 LGPLv3 派生义务) |
| D6 | 客户端 | Claude Code 优先,其他降级 | 分层按需只有 Claude Code 的 Skill 机制真支持 |
| D7 | demo | 3D 中等复杂度 | enhanced 截图 3D 可靠,第一印象展示视觉闭环强项 |
| D8 | 目标用户 | 熟练开发者(MVP 先 dogfood) | 认知负担可控,且是 load_skill 天然用户 |

---

## 3. 架构总览

```
godot-ai-kit/                       ← meta 仓库(套件本体,MIT)
│
├─ 📦 子模块层(各家所长,原样保留,绝不修改源文件)
│   ├─ enhanced/                    godot-mcp-enhanced (执行层·MIT·v0.18.1·稳)
│   ├─ GodotPrompter/               知识-写法规范 (MIT·v1.9.0·新)
│   └─ gd-agentic-skills/           知识-专家经验/蓝图 (LGPLv3·v0.0.6·实验性)
│
└─ 🔗 粘合层(套件独有价值,只用指针/索引,不复制改写知识)
    ├─ CLAUDE.md                    统一顶层规则(轻·索引·见 §6.1)
    ├─ rules/                       始终可见硬约束(enhanced 工具规则 + token 门禁)
    ├─ skills/                      按需加载(@指针引用三家,不复制内容)
    ├─ workflow/                    Godot 专版 5 阶段(见 §6.3)
    ├─ demo/                        3D 示例项目(见 §6.4)
    ├─ install.{ps1,sh}             一键安装(见 §6.2)
    ├─ config/{claude,cursor,cline}/  多客户端配置模板
    ├─ compatibility-matrix.md      版本兼容矩阵(CI 实跑校验,见 §8.4)
    └─ LICENSE + NOTICE              MIT + 各组件来源/许可证声明
```

**核心原则**(不可妥协):

1. **子模块层原样保留**。尤其 gd-agentic 的 LGPLv3 源文件**一个字都不改**——修改才触发 LGPLv3 派生义务。
2. **粘合层只用指针/索引**(指向子模块里的原文路径),绝不复制或改写知识内容。这是"真聚合"(mere aggregation)的前提,LGPLv3 豁免才成立。
3. **套件的所有"融合"发生在粘合层的新建文件**里,通过引用 + load_skill 运行时加载组织三家,而非拷贝拼接。

---

## 4. load_skill 路线下的知识流

套件不物理打包知识,知识在运行时流动:

```
用户在 Claude Code 里工作
  ↓
套件 CLAUDE.md(顶层索引)告诉 AI:"你在 5 阶段的哪一步?"
  ↓
AI 调用 enhanced 的 load_skill(query, library_path, format, stage)
  ↓
load_skill 从用户本地的 GodotPrompter/ 或 gd-agentic/ 子模块,按 query + stage 检索
  ↓
返回带来源标注 + score 的 skill 内容(超预算则截断 + 指针)
  ↓
AI 按知识写代码 → enhanced 执行闭环验证(write_script → run_and_verify → ...)
```

**关键**: 知识始终留在各家子模块的原文件里,套件和 load_skill 都只是"读",从不"写/改/复制"。LGPLv3 合规因此自洽。

---

## 5. load_skill 接口需求(本 spec 关键产出 → enhanced P0 输入)

> 这一节是套件反推 enhanced 该实现什么。**enhanced 侧目前无 load_skill 实现,也无 plan/spec/ROADMAP 条目**(2026-06-17 Grep `"load[._\- ]?skill"` 全仓库 + Glob `**/*skill*` 核实,仅命中《四项目分析》§7 P1 的一句战略雏形 `query`/`library_path`/`format`)。**本节是 load_skill 的首份正式需求定义**,把该雏形扩展为完整能力。enhanced 实现 load_skill 时以本节为准。

### 5.1 套件需要 load_skill 提供的能力

| # | 能力 | 说明 |
|---|------|------|
| L1 | **跨格式 + 两级检索** | 兼容 GodotPrompter(`skills/<name>/SKILL.md`)和 gd-agentic(`skills/godot-master/references/*.md` + `blueprints/`)。**两级检索**(精度核心):① 先按 skill 的 `name`/`description` 高精度匹配;② miss 再全文 fallback。避免纯 grep 精度差导致 L2 加载错知识 |
| L2 | **stage 加权(非摆设)** | `stage` 参数真正影响检索:做 stage → 优先库/类 的加权映射。如 `production` 加权 gd-agentic NEVER 规则、`architecture` 加权 gd-agentic 决策矩阵、`concept` 加权游戏类型蓝图。反推 §6.3 的 query 设计 |
| L3 | **截断到预算(非摘要)** | 超预算时**截断**内容 + 返回剩余部分指针(文件路径+偏移),**不做真摘要**——stdio MCP 不调 LLM,生成摘要在 MCP 侧不可行。措辞明确为"截断" |
| L4 | **来源标注** | 每条返回标明来源库 + 原文件路径,便于追溯和许可证合规 |
| L5 | **会话内缓存/去重(有前提)** | 同一会话不重复加载同一 skill。**前提**:依赖 enhanced MCP 进程在会话内常驻(stdio 长连接)——**需 enhanced 侧确认此假设成立**,否则 L5 降级为无缓存 |
| L6 | **缺失优雅降级** | 用户没装某家子模块时,返回"未找到 + 安装指引",不报错中断 |
| L7 | **relevance score** | `matches[]` 每项带 `score`(0-1),或多 match 时保证已按相关性降序排列,让 AI 知道先看哪个 |

### 5.2 建议的 load_skill 签名

```
load_skill(
  query: string,              // 关键词,如 "platformer 跳跃 coyote time"
  library_path?: string,      // 本地知识库根路径,默认扫描已配置的三家
  format?: "auto" | "godotprompter" | "gdskills",
  stage?: "concept" | "architecture" | "production" | "polish" | "delivery",
  max_tokens?: number         // 预算,默认 4096
) → {
  matches: [{
    source: "gdskills",       // L4 来源
    path: "...",              // L4 原文件路径
    score: 0.87,              // L7 相关性
    content?: string,         // 内容(超预算时省略)
    truncated: boolean,       // L3 是否截断
    next_pointer?: { path, offset }  // L3 截断时的续读指针
  }],
  total_matches, budget_used, missing_libraries: [...]  // L6
}
```

> 此签名为套件侧需求。enhanced 实现时以此为准;若实现偏离,套件 §6.3 映射相应调整。
>
> **续读机制(P0 不实现)**: `next_pointer`/`max_tokens` 属 L3 截断(v1)。P0 不截断,返回完整匹配内容,无 `next_pointer`;续读入参 `offset?` 留 v1 补齐(L3 就绪时)。

### 5.3 能力分层就绪(对应 §9 实现顺序)

load_skill **不必一次实现全部 L1-L7**。按套件消费进度分层,避免 P0 背全:

| 层 | 能力 | 何时需要 |
|---|------|---------|
| **P0(套件 MVP 前置)** | L1(两级检索) + L4(标注) + L6(降级) + L7(score) | 概念+架构两阶段够用 |
| **套件 v1 前置** | L2(stage 加权) + L3(截断) + L5(缓存) | 工作流 5 阶段完整才需要 |

**stage 参数在 P0 的行为**: P0 不实现 L2(stage 加权),`stage` 参数**可传入但暂不影响检索**(为 v1 预留)。因此 MVP ①② 两阶段的检索实际只靠 L1 的 query 匹配——§6.3 示例调用里的 stage 标注为"(P0 预留,v1 生效)"。

### 5.4 load_skill 未就绪时的套件行为

load_skill 是套件前置依赖。实现前套件**不发 MVP**(§9)。P0 完成的客观判据见 §9。

---

## 6. 四支柱设计

### 6.1 统一规则融合(最核心差异化)

**不做"三家 markdown 大拼接"**(会爆 token + 互相矛盾)。做**分层按需**体系:

```
CLAUDE.md (顶层·始终加载·硬 token 预算 ≤ 4KB)
  ├─ 定位:四家分工一句话 + 何时用谁
  ├─ 工具入口:enhanced MCP 工具速查表
  ├─ 阶段索引:"你在哪个阶段?"→ 指向 workflow/<阶段>.md
  └─ 加载约定:重内容用 load_skill 按需,不预载

skills/ (按需加载·指针引用,不复制内容)
  ├─ writing/    → 指针指向 GodotPrompter/skills/<name>/SKILL.md
  ├─ expertise/  → 指针指向 gd-agentic/skills/godot-master/references/*.md
  └─ workflow/   → Godot 专版 5 阶段详解(套件自研)

rules/ (始终可见·硬约束·token 预算门禁 ≤ 8KB)
  ├─ enhanced 工具规则(复用 enhanced/.claude/rules/godot-mcp-*.md)
  └─ budget-guard.md  ← token 预算门禁规则
```

**⚠️ 客户端能力差异(关键约束)**:

| 客户端 | 按需加载 | 套件行为 |
|--------|---------|---------|
| Claude Code | ✅ Skill 工具真按需触发 | 分层按需**完全生效**,这是套件主卖点 |
| Cursor | ❌ `.cursor/rules` 始终全量注入 | **降级模式**:只装顶层 CLAUDE.md + rules/(精简版),注明 token 成本,不装 skills/ 全集 |
| Cline | ❌ `.clinerules` 始终全量注入 | 同 Cursor 降级 |

**因此 MVP 标榜 Claude Code 优先**,"多客户端"是 v2 且明确标注降级代价。

**token 预算门禁**(借鉴 GodotPrompter 16KB 预算 + CI 门禁):
- `rules/` 总体积硬上限 8KB,CI 检查超限则失败
- CLAUDE.md 顶层 ≤ 4KB
- 超限内容必须下沉到 skills/(按需)或 load_skill(运行时)

### 6.2 一键安装配置

`install.ps1` / `install.sh` 七步:

1. **前置检查**: Godot 4.5+、Node 20+、git(缺失则明确报错 + 安装指引)
2. **子模块初始化/更新**: enhanced + GodotPrompter + gd-agentic(`git submodule update --init --recursive`,pin 到 compatibility-matrix 指定 commit)
3. **enhanced 构建**: `cd enhanced && npm install && npm run build`
4. **MCP server 配置**: 生成 `.claude/settings.json`,MCP server 指向 enhanced 的 stdio 命令
5. **skills 路径配置**: GodotPrompter + gd-agentic 的 skills 路径注册到 load_skill 的扫描范围
6. **客户端分发**: 提示选 claude/cursor/cline,`config/<client>/` 覆盖到工作区
7. **自检链路**: 调一次 enhanced 的 `validate_scripts`(离线可用) + 若 Godot 在跑则 `ping`,验证 MCP ↔ enhanced ↔ 知识库 三段通

**降级**: 任一步失败,明确报错 + 指向 troubleshooting,不静默继续。

### 6.3 工作流编排: Godot 专版 5 阶段

借鉴 CCGS 7 阶段骨架,适配 Godot 独立/小队项目精简为 **5 阶段**。每阶段**约定调用 enhanced 验证工具 + 阶段门禁**(落地"执行层渗透流程层"):

| 阶段 | 知识输入 | load_skill 示例调用(query / stage) | 执行闭环(enhanced 工具) | 产出 |
|------|---------|----------------------------------|----------------------|------|
| ① 概念 Concept | gd-agentic 游戏类型蓝图 | `query="3D platformer 收集物", stage="concept"` (stage P0 预留,v1 生效) | `validate_gdd` | 轻量 GDD |
| ② 架构 Architecture | gd-agentic 决策矩阵(节点组织/autoload/场景拆分/信号架构) + GodotPrompter 架构 skill | `query="场景拆分 autoload 信号架构", stage="architecture"` (stage P0 预留,v1 生效) | `read_scene`/`add_node`/`save_scene` | 场景树 + ADR |
| ③ 生产 Production | gd-agentic NEVER 规则 + GodotPrompter 写法规范 | `query="CharacterBody3D 移动 NEVER", stage="production"` | `write_script`/`batch_add_nodes`/`run_and_verify`(每步) | 可运行构建 |
| ④ 打磨 Polish | GodotPrompter 性能规范 | `query="性能优化 draw call", stage="polish"` | `profiler`/`validate_scripts` | 性能达标 |
| ⑤ 交付 Delivery | CCGS code-review checklist(借鉴) | `query="发版前代码审查清单", stage="delivery"` | `verify_delivery`(四维) | 发版包 |

**② 归属修正**: 架构阶段的知识是**架构模式**(gd-agentic 的 16 场景决策矩阵更对口),不是代码写法——GodotPrompter 写法规范挪到 ③ 生产。

**⚠️ "硬闭环"措辞诚实化**: enhanced 工具能**验证**、不能**阻止跳阶段**——阶段推进是 AI/用户行为,enhanced 不拦。准确表述:
- 每阶段**约定调用验证工具** + 工作流约定**阶段门禁**(靠 AI 遵守约定 + 文档要求贴验证结果)
- 与 CCGS 对比要说准:"CCGS 靠 AI 自觉读 markdown,**本工作流每阶段强制调用验证工具**"——这句真;但**不说**"验证不过进不了下一阶段"(工具不强制,会变成计划里的虚假承诺)

### 6.4 示例项目: 3D 中等复杂度

`demo/` 一个 3D demo(如第三人称角色在场景里移动 + 收集物):

- **为什么 3D**: enhanced 截图 3D 可靠(《四项目分析》§5.2 确认),第一印象展示视觉闭环最强一面;2D 截图短板进文档(`docs/known-limitations.md`)不进 demo 主路径
- **复杂度**: 中等——足够演示四家协作(概念→架构→生产→验证),不复杂到劝退
- **教学性**: 5 阶段每步产出物都保留在 demo 仓库里,作为"活教材"
- **gd-agentic 蓝图对齐**: 选 gd-agentic 有对应 3D 蓝图的类型(若无,套件自研一个 3D 起步蓝图,标注"套件补充非 gd-agentic 原产")

---

## 7. enhanced 已知边界与各阶段降级方案

> 套件把 enhanced 当验证工具挂到 5 阶段每一步。enhanced 有已知裂缝(M2-M5 评估积累),某工具在某场景失效,验证链可能断。**每阶段必须有降级路径,且降级路径自身也要标注可靠性。**

| enhanced 已知边界 | 影响阶段 | 降级方案 |
|------------------|---------|---------|
| **autoload 盲区 ⚠️评估有争议** | ③ 生产 | M4 认为是盲区;**M5 评估认为部分实为编译错误连锁,run_and_verify 本身可靠**——此边界需 enhanced 侧最终核实。对策:需 autoload 时用 `load_autoloads=true` 完整类模式 |
| Edit tab 不匹配(内置 Edit 工具改 .gd 失败) | ③ 生产 | 强制走 enhanced 的 `edit_script` + `search_and_replace`,CLAUDE.md 明确禁用内置 Edit |
| **CRLF 行尾(Windows 下 edit/批量替换匹配失败)** | ③ 生产 | 强制 LF 规范化 + 优先 `search_and_replace`(CRLF 安全);Windows 用户文档警示 |
| **validate_scripts 结果不一致**(不同调用方式/与 Godot 解析不一致) | 全阶段验证 | **最致命**——各阶段验证都依赖它。套件文档标注此不一致,验证结论需交叉确认(多方式比对),不单凭一次 validate_scripts 下结论 |
| **重复调用幂等性**(batch + 单独 add 产生重复节点) | ②/③ | add 前先 query_scene_tree 查存在性;batch 操作文档警示幂等陷阱 |
| **超时**(大项目 run_and_verify/bake_mesh) | ③/④ | 文档标注大项目超时风险 + 推荐分块验证 |
| **2D 截图 headless 不可用** | ④ 打磨(2D 项目) | Bridge `take_screenshot` **自身有已知隐患**(手动运行连不上/进程槽死锁/端口冲突/错误信息误导/脚本覆盖丢修复),不可靠作自动化降级。**MVP 阶段 2D 视觉验证标"需人工介入"**,不承诺自动化 |
| 确认令牌/GateGuard 流程中断自动化 | 全阶段 | dev_loop/自动化脚本预判需确认操作,文档化确认点;非交互场景用 `confirm_and_execute` 预授权 |
| run_and_verify 残留进程 | ③/⑤ | 每次运行后 `stop_project` 清理;CI 里加进程清理钩子 |

**原则**: 套件文档(`docs/enhanced-boundaries.md`)逐条列边界 + 对策 + 对策可靠性;工作流每阶段引用对应对策。**降级路径自身不可靠时(如 Bridge),明确标"需人工介入",不假装自动化。** 地基有缝,上面必须有逃生梯,且逃生梯本身要标清楚能不能用。

---

## 8. 工程约束

### 8.1 许可证合规

- 套件本体: **MIT**
- 子模块各保留原许可证: enhanced(MIT)、GodotPrompter(MIT)、gd-agentic(LGPLv3)
- **绝不修改 gd-agentic 源文件**(修改触发 LGPLv3 派生义务,可能传染粘合层)
- 粘合层只用指针/索引引用,真聚合,LGPLv3 豁免成立
- `NOTICE` 文件声明各组件来源、版本、许可证、上游仓库

### 8.2 多客户端(Claude Code 优先)

- **MVP**: 仅 Claude Code(分层按需完全生效)
- **v2**: Cursor/Cline 降级模式(只装顶层 + 精简 rules,注明 token 成本)
- `config/<client>/` 各一份配置模板,install 时选

### 8.3 token 预算门禁

- `rules/` ≤ 8KB,CLAUDE.md ≤ 4KB
- CI 检查超限(借鉴 GodotPrompter 16KB 预算 + CI 门禁理念)
- 超限内容下沉到 skills/(按需)或 load_skill(运行时)

### 8.4 质量分级标注 + CI 兼容矩阵

**质量分级**(不平铺实验性和稳定内容):

| 组件 | 成熟度 | 标注 |
|------|--------|------|
| enhanced | v0.18.1,~950 测试 | 🟢 稳定 |
| GodotPrompter | v1.9.0,2026-04 建 | 🟡 较新 |
| gd-agentic | v0.0.6 预发布 | 🔴 实验性(API 可能变) |

套件对 gd-agentic 的每个蓝图/skill 标注是否经验证(套件 CI 实跑过的标 ✅,否则标 ⚠️ 未验证)。

**CI 兼容矩阵**:`compatibility-matrix.md` 不靠人工声明,**CI 实跑 demo 全流程通过才标绿**。子模块 bump 后矩阵自动重测。避免"按矩阵装却跑不起来"的信任崩塌。

### 8.5 维护与版本

- 子模块 pin 到特定 commit/tag(非 branch)
- 升级流程: bump 子模块 → CI 重跑 demo + 矩阵 → 全绿才发新版
- gd-agentic 预发布,破坏性升级时套件可能需跟改粘合层引用

---

## 9. MVP 与里程碑

| 阶段 | 范围 | 前置 |
|------|------|------|
| **P0(enhanced)** | 实现 `load_skill` **核心子集**: L1(两级检索) + L4(标注) + L6(降级) + L7(score)。L2/L3/L5 是套件 v1 前置,P0 不背。**Exit criteria(可验证):套件 MVP 概念+架构两阶段能调通 load_skill,拿到带来源标注 + score 的知识** | 无——地基先行 |
| **套件 MVP** | 仓库骨架 + 三子模块聚合 + 统一 CLAUDE.md + install(Claude 单端) + 3D demo(概念+架构两阶段跑通) + enhanced-boundaries 文档 | **P0 完成** |
| **套件 v1** | 工作流 5 阶段完整(需 load_skill L2/L3/L5 就绪) + rules/skills 按需体系 + token 门禁 CI + 质量分级标注 | 套件 MVP + load_skill 全能力 |
| **套件 v2** | Cursor/Cline 降级配置 + 兼容矩阵 CI 自动化 + install 自检增强 | 套件 v1 |

**MVP 自己 dogfood**:套件维护者先用 MVP 跑一个真实小项目,验证四家组合 1+1+1>3,再推进 v1/v2 对外。

---

## 10. 不做的事(YAGNI)

1. **不内化知识层**(不走《四项目分析》走法 B)——弱项打强项 + 许可证风险
2. **不打包 CCGS**——套娃 + 绑死 Claude Code
3. **不修改任何子模块源文件**——LGPLv3 合规红线
4. **不支持 Godot 新手**——认知负担劝退(D8)
5. **不做 UI/控制台/面板**——套件是配置包 + 约定集,不是 studio(命名因此弃用 studio)
6. **不在 load_skill 就绪前发 MVP**——避免空中楼阁

---

## 11. 开放问题(spec 审查时定)

1. **命名**: 弃用 studio。候选 `godot-ai-kit` / `godot-agent-stack` / 其他。低优先级,最后定。
2. ~~**load_skill 签名核对**~~ → **已解决**(2026-06-17): Grep+Glob 全仓库确认 enhanced 无 load_skill 实现/plan/spec/ROADMAP 条目,仅有《四项目分析》§7 P1 雏形。§5 为首份正式需求定义,enhanced 实现时以此为准。
3. **3D demo 具体类型**: 选 gd-agentic 有蓝图的类型,还是套件自研 3D 起步蓝图?取决于 gd-agentic 现有 3D 蓝图覆盖度(实施时核查)。
4. **套件仓库归属**: spec 暂存 enhanced/docs/,套件仓库建立后迁移。套件仓库放 D:\GitHub\ 下与 enhanced 平级?
5. **Cursor/Cline 降级的 rules 精简规则**: 哪些 enhanced 规则在降级模式必装、哪些可省,需实测 token 占用后定(v2)。

---

## 12. 风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| load_skill 实现偏离套件需求 | 中 | §5 接口需求作为 enhanced P0 输入,实现时双向对齐 |
| gd-agentic 预发布破坏性升级 | 中 | 子模块 pin + CI 矩阵重测 + 粘合层引用解耦 |
| enhanced 地基裂缝断验证链 | 中 | §7 每阶段降级方案 + boundaries 文档 + 降级可靠性标注 |
| validate_scripts 不一致动摇"验证闭环"可信度 | 中-高 | §7 标注 + 验证结论交叉确认,不单凭一次结果 |
| Cursor/Cline 降级体验差 | 低 | MVP 不支持,v2 明确标注代价 |
| "1+1+1>3"对熟练用户不够硬 | 中 | MVP 先 dogfood 实证,不强推对外 |

---

*本 spec 基于 2026-06-17 brainstorming 会话产出。第 2 轮修订吸收了 spec 审查对 load_skill 检索算法/stage 语义/截断 vs 摘要/缓存假设/score、5 阶段示例 query+②归属+硬闭环诚实化、enhanced 4 个漏网裂缝+Bridge 降级可靠性+autoload 评估争议、load_skill 能力分层+P0 exit criteria 等关键批判的修正。*
