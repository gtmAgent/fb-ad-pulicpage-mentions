# 浏览器自动化任务 — 智能体开发指南

适用于 **`{SDK_PATH}/browser_automation_template/`**（模版）或 **`{SDK_PATH}/{cmd}/`**（从模版复制出的任务）。  
`{SDK_PATH}` 为桌面软件安装目录（env `SDK_PATH`），**不是** ai-desktop 源码路径。

修改 `package.json`、`main.ts`、`distribute.ts` 之前按下列顺序阅读。

> **开发总流程 SSOT**：`.cursor/skills/browser-automation/SKILL.md` **`topics/`（见该 Skill `SKILL.md` 文档地图）**（录制业务指引 → MCP 逐步探路 → 阶段 A → verify → 阶段 B）。

---

## 1. 阅读顺序

| 顺序 | 文档 | 路径（相对 `{SDK_PATH}`） |
|------|------|---------------------------|
| 0 | SDK 开发总约定、env、HTTP、API | **`xport_browser_sdk/AGENTS.md`** |
| 1 | 脚本内单次 AI（`main.ts` 运行时） | `xport_browser_sdk/SCRIPT_AI_PROMPT.md` |
| 2 | 脚本内设备 AI 操控（`aiDeviceAct`） | `xport_browser_sdk/SCRIPT_AI_DEVICE_ACT.md` |
| 3 | 中间数据 / 结果 UI | `xport_browser_sdk/AUTOMATION_DATA_AND_RESULT.md` |
| 4 | 场景→API 菜谱 | `xport_browser_sdk/BROWSER_AUTOMATION.md` |
| 5 | schema 字段与 wire 值 | `xport_browser_sdk/CONFIG_SCHEMA.md`（**§7 manifest 总览** + §2 wire） |

> 任务标识 **`cmd`** = 本目录文件夹名（位于 `{SDK_PATH}/{cmd}/`）。

---

## 2. 本目录文件

| 文件 | 作用 |
|------|------|
| `package.json` → `xportAutomation` | schema |
| `config.types.ts` | **生成**：`TaskRunConfig` / `TaskGroupConfig` / 可选 `IntermediateDataRow`、`TaskResultData`（勿手改） |
| `validate.ts` | 校验 schema + 生成 `config.types.ts` |
| `gen-types.ts` | 仅生成 `config.types.ts`（会先校验） |
| `main.ts` | 执行单条任务 |
| `distribute.ts` | 任务组 → 分发任务 |

---

## 3. 单次 vs 批量（manifest 必核对）

脚本按 **单设备、单次任务** 写（`main.ts` + `taskRunConfig`）；客户建任务时几乎总是 **批量**（`taskGroupConfig` + `distribute.ts`）。二者不对齐会导致表单无法填、分发失败或结果页空白。

**前置条件**：会话/项目已绑定录制（**业务指引**）。Agent 按录制步骤 **MCP 逐步探路** 编写 `main.ts`；**实际页面结构以 MCP 实时读屏为准**。无录制则引导客户先采集，勿凭模糊描述猜 DOM。

| `xportAutomation` 键 | 桌面 UI | 代码 | 深入 |
|------------------------|---------|------|------|
| **`taskRunConfig`** | 单条任务调试 / 子任务参数 | `main.ts` ← `loadTaskRunConfig` | CONFIG_SCHEMA **§7** |
| **`taskGroupConfig`** | **创建任务组**表单 | `distribute.ts` ← `loadTaskGroupConfig` | 模版 `package.json` 第一节 + 频率第二节 |
| **`taskResultConfig`** | 任务详情结果展示 | `return { data }` 键 | AUTOMATION_DATA **§2.1** |
| **`intermediateDataSchema`** | 任务组「采集数据」（**仅采集型**） | `ingestIntermediateRows` | AUTOMATION_DATA **§1.1** |
| **`scriptAi`** | （无 UI，交付校验用） | `validate.ts` 对照 `main.ts` | CONFIG_SCHEMA **§7.1** |

### 3.1 阶段 A：先定单次任务参数

1. 读取绑定录制（录制 manifest、`routes/*/steps/*`）；**多线路先与用户确认选线**（Skill `topics/dev-flow.md`）。
2. 用 Skill **§1.2 模板**向用户确认单次方案，再根据共识 **建议** `taskRunConfig` 字段并写入 schema。
3. **推导**采集型/纯动作型（§1.1）→ 按需 `intermediateDataSchema`；结果页 → `taskResultConfig`；`scriptAi` → CONFIG_SCHEMA **§7.1**。
4. 实现 **`main.ts`**：**业务步骤意图**对齐录制；**选择器/DOM 经 MCP 逐步探路验证**；`browser_project_verify` 通过。

**此阶段不敲定**多目标如何分给多设备。

### 3.2 阶段 B：单次稳定后再确认批量分配

`taskRunConfig` + `main.ts` 定稿且 verify 通过后，用 Skill **§1.3 模板**请用户确认批量规则（不可默认模版轮询）：

- 批量目标从哪来（多行 `hosts` 等）→ **`taskGroupConfig`** 表单字段
- 选哪些设备、是否 **`platform`** 过滤
- **分配规则**：轮询、一对一、笛卡尔积、仅频率调度…
- 频率：`daily_limit`、间隔、每日时间窗

确认后再改 **`taskGroupConfig`** + **`distribute.ts`**；`tasks[].config` 键必须与阶段 A 的 `taskRunConfig` 一致。

**阶段 B 完成后**：用样例组配置跑 `{BUN} --no-env-file distribute.ts`，核对 `data.tasks` 条数与各条 `config` 键名（见 Skill `topics/manifest-phase.md`）。

### 3.3 每次改动后的同步与验证

同一轮改动内完成：

1. **`taskRunConfig`** — 与 `main.ts` 读取的 `taskConfig.*` 一致  
2. **`taskGroupConfig`** — 与 `distribute.ts` 读取的 `groupConfig.*` 一致（含批量专用字段）  
3. **`distribute.ts`** — 实现已确认的分配；`tasks[].config` 键对齐 `taskRunConfig`  
4. **`intermediateDataSchema`** — **仅采集型任务**：有 `ingestIntermediateRows` 时字段与 payload 一致；纯动作任务**删除该键**
5. **`taskResultConfig`** — 与 `return data` 键一致  
6. **`{BUN} --no-env-file validate.ts`** — 退出码 `0`（schema + 频率默认值 + 生成 `config.types.ts`）
7. 有 schema/行为变更时 bump `package.json` `version`，并同步 **`{SDK_PATH}/{cmd}_tar.txt`**（单行，与 `version` 相同）

细则见会话物化的 **`.cursor/rules/automation-manifest.mdc`**（打开智能体会话时由本软件从 Skill 包覆盖注入）。

---

## 4. 从模版新建任务

1. 复制本目录 → 重命名为任务 id（即 `cmd`），位于 `{SDK_PATH}/` 下。
2. 按 **CONFIG_SCHEMA.md** 编写 `taskGroupConfig` / `taskRunConfig`；**确认是数据采集型任务后**再加 `intermediateDataSchema`；需要结构化结果页则加 `taskResultConfig`。
3. `{BUN} --no-env-file validate.ts` 校验并生成 `config.types.ts`。
4. 采集型任务：`main.ts` 在 `manifest.intermediateDataSchema` 存在时 `prepareIntermediateStorage`，采集中 `ingestIntermediateRows`；临时文件只用 `AUTOMATION_CACHE_DIR`（`{SDK_PATH}/cache/{cmd}/`；勿写 cwd）。
5. 实现 `distribute.ts`、`main.ts`（`return { succ, msg, data }` 与 `taskResultConfig` 字段对齐）。
6. 按 §7 完成检查。

桌面拉起智能体会话时，**工作目录**设为新任务目录 `{SDK_PATH}/{cmd}/`。

---

## 5. 本地命令

**勿**在任务或 SDK 的 `package.json` 里配 `scripts`；在任务目录直接执行本目录入口文件。  
`{BUN}`：macOS/Linux **`../bun`**，Windows **`..\bun.exe`**，或 env **`BUN_PATH`**。

```bash
{BUN} install
{BUN} --no-env-file validate.ts
{BUN} --no-env-file gen-types.ts
{BUN} --no-env-file main.ts
{BUN} --no-env-file distribute.ts
```

Windows 示例：

```bat
..\bun.exe install
..\bun.exe --no-env-file validate.ts
..\bun.exe --no-env-file main.ts
```

---

## 6. 常见错误

| 错误 | 正确 |
|------|------|
| switch 用 boolean | wire 用 `0` / `1` |
| `browsers: [{id:1}]` | `browsers: [1,2]` |
| 用 `taskLog` 写结果 | `return { succ, msg, data }` |
| 系统 PATH 的 `bun` | `../bun` / `..\bun.exe` 或 `BUN_PATH` |
| 去 SDK 目录跑 scripts | 本目录 `{BUN} --no-env-file validate.ts` 等 |
| 在 package.json 配 scripts | 直接 `{BUN} --no-env-file <入口.ts>`（任务与 SDK 包均勿配 scripts） |
| 文件头 `#!/usr/bin/env bun` | 用 `{BUN} --no-env-file xxx.ts` |
| 临时文件写入任务目录或随意路径 | 仅 `Bun.env.AUTOMATION_CACHE_DIR`（`{SDK_PATH}/cache/{cmd}/`） |
| 复制 CONFIG_SCHEMA 到任务目录 | 引用 `{SDK_PATH}/xport_browser_sdk/CONFIG_SCHEMA.md` |
| 资源 URL 写成 `.../md5/file` | 用 upload/query 返回的 `staticUrl` 或 `name` 拼 `/static/docs/{md5}/{name}` |
| 凭录制截图/page.html 写 node_path | **页面结构以 MCP 读屏为准**；录制仅业务指引 |
| 找图模板含角标/文字、白块或从不看裁剪图 | Skill **§4.1b**：只留稳定主体；`pixel_rect`；`suggestRecrop`/假满分必重裁 |
| 凭想象写流程、与录制步骤不符 | **业务意图**对齐录制；**DOM/选择器**对齐 MCP 读屏 |
| 单次参数字段 AI 自行决定 | 根据需求**建议** `taskRunConfig` 字段，**须用户确认**后再改 schema |
| 批量分配未问用户就写死轮询 | **先**定单次 `taskRunConfig`/`main.ts`，**再**确认分配规则后改 `taskGroupConfig`/`distribute.ts` |
| 只改 `main.ts` 不核对 manifest | 同步 `taskRunConfig` / `taskGroupConfig` / `taskResultConfig` 等并跑 `validate.ts` |
| 业务 fail 裸 `AutomationRunResult.fail(msg)` | **先** `captureIncident` **再** `automationFailWithContext`（`code`/`step`/`incidentId`）；Skill **§10.7**（**开发模式 / 排错模式**改码均须 capture） |
| 设备 id 猜名称 / 读 2FA·代理等 | `queryBrowserDevices` / `getBrowserDeviceById`（完整 `BrowserModel`；`AUTOMATION_DATA_AND_RESULT.md` §5） |

---

## 7. 完成检查

- [ ] 已读绑定录制（业务指引），`main.ts` 业务步骤对齐录制；DOM/选择器经 MCP 验证
- [ ] 单次参数（`taskRunConfig` + `main.ts`）已与用户确认（AI 建议字段已获认可）并试跑通过
- [ ] 批量分配规则已与用户确认，`taskGroupConfig` 与 `distribute.ts` 一致
- [ ] `{BUN} --no-env-file distribute.ts` 试跑：`data.tasks` 条数与 `config` 键名符合已确认规则
- [ ] `{BUN} --no-env-file validate.ts` 退出码 `0`，已生成 `config.types.ts`
- [ ] `main.ts` 使用 `TaskRunConfig`；`distribute.ts` 使用 `TaskGroupConfig`
- [ ] 有 `intermediateDataSchema` 时：`main.ts` 已 `prepareIntermediateStorage`；入库用 `ingestIntermediateRows` + `IntermediateDataRow`
- [ ] 有 `taskResultConfig` 时：`AutomationRunResult.data` 键与 schema 的 `key` 一致
- [ ] 临时文件仅写在 `AUTOMATION_CACHE_DIR`（勿写 cwd；勿写任务目录外随意路径）
- [ ] `main.ts` 本地试跑：stdout 含 `XPORT_TASK_RESULT:` 且 `succ: true`（需 `DEVICE_ID`、`LISTEN_PORT`、`TASK_ID` 等）
- [ ] **`main.ts` 各业务 fail / `catch` 分支均有 `captureIncident` + 结构化 fail（Skill `topics/failure-dev.md`）**
- [ ] `distribute.ts` 成功时 `data: { tasks: TaskCreateInput[] }`（本软件解析 stdout 写入任务库）
- [ ] 未把脚本内部优化状态（如定位器 hit/miss）写入 **`intermediateDataSchema`** / ingest；**任务交付业务行仍按 manifest 走 ingest**（跨次内部状态用 store — **`AUTOMATION_SCRIPT_STORE.md`**）
- [ ] `package.json` description / version 已按最终实现更新
- [ ] **`{SDK_PATH}/{cmd}_tar.txt` 已与 `package.json` version 同步**（bump 版本时必做）
- [ ] 未在任务目录复制 SDK 文档、未加 shebang、未配 `package.json` scripts

---

## 8. 智能体开发速查（写脚本时）

| 需求 | 调用 |
|------|------|
| 临时文件目录 | `Bun.env.AUTOMATION_CACHE_DIR`（`{SDK_PATH}/cache/{cmd}/`；仅此落盘） |
| 采集行入库（**仅采集型任务**） | `prepareIntermediateStorage` → `ingestIntermediateRows` |
| 本地图进资源库 | `uploadAutomationResourceFromPath` / `client.uploadResourceFromPath` → 用返回的 `md5` |
| 资源访问 URL | 用 API 的 `staticUrl`，勿手写路径 |
| 查浏览器设备 | `queryBrowserDevices({ ids })` / `getBrowserDeviceById` — 完整模型（`fa2` / `proxyId` / `preProxyId` 等） |
| verify 前设备就绪 | MCP **`browser_ensure_ready`**（开发模式） |
| 任务结果回传 | `return { succ, msg, data }` 的键与 `taskResultConfig` 的 `key` 对齐 |
| **业务步骤 fail** | **先** `client.captureIncident({ step, reason, code })`，**再** `automationFailWithContext`（Skill `topics/failure-dev.md`；**开发模式 / 排错模式**改码均须 capture） |
| 脚本内单次 AI | `client.aiPrompt(...)` — 见 `xport_browser_sdk/SCRIPT_AI_PROMPT.md` |
| 脚本内设备 AI 操控 | `client.aiDeviceAct(...)` — 见 `xport_browser_sdk/SCRIPT_AI_DEVICE_ACT.md` |
| **可选** 跨次内部优化 | `scriptStoreGet` / `scriptStoreSet` — 见 `AUTOMATION_SCRIPT_STORE.md`（非 ingest 任务交付数据） |
| 总契约 | `{SDK_PATH}/xport_browser_sdk/AGENTS.md` · **`FAILURE_INCIDENT.md`**（失败 capture） |
