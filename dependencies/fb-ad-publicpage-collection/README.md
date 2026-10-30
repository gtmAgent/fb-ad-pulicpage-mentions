# browser_automation_template

基于 **Bun** + [`xport-browser-sdk`](../xport_browser_sdk) 的浏览器自动化模版。新建任务可复制本目录。

- 智能体开发总入口：[`../xport_browser_sdk/AGENTS.md`](../xport_browser_sdk/AGENTS.md)
- 本模版任务指南：[`AGENTS.md`](./AGENTS.md)
- 场景→API：[`../xport_browser_sdk/BROWSER_AUTOMATION.md`](../xport_browser_sdk/BROWSER_AUTOMATION.md)
- 配置字段全集：[`../xport_browser_sdk/CONFIG_SCHEMA.md`](../xport_browser_sdk/CONFIG_SCHEMA.md)
- 脚本内单次 AI：[`../xport_browser_sdk/SCRIPT_AI_PROMPT.md`](../xport_browser_sdk/SCRIPT_AI_PROMPT.md)
- 脚本内设备 AI 操控：[`../xport_browser_sdk/SCRIPT_AI_DEVICE_ACT.md`](../xport_browser_sdk/SCRIPT_AI_DEVICE_ACT.md)
- env / HTTP / SDK API：[`../xport_browser_sdk/AGENTS.md`](../xport_browser_sdk/AGENTS.md)

## 配置（`package.json` → `xportAutomation`）

各键含义与何时配置：**[`CONFIG_SCHEMA.md` §7](../xport_browser_sdk/CONFIG_SCHEMA.md)**。本目录 `package.json` 为**动作型**活例子。

| 字段 | 说明 |
|------|------|
| `taskGroupConfig` | **批量**建任务组 → `distribute.ts` |
| `taskRunConfig` | **单次**子任务 → `main.ts` |
| `taskResultConfig` | 结果页 ↔ `return { data }`（[§2.1](../xport_browser_sdk/AUTOMATION_DATA_AND_RESULT.md)） |
| `intermediateDataSchema` | **仅采集型**（动作模版无此项） |
| `scriptAi` | 脚本内 AI 声明（[§7.1](../xport_browser_sdk/CONFIG_SCHEMA.md)） |

改任一层须同步其余层并跑 `validate.ts`：**先**阶段 A 定 `taskRunConfig`/`main.ts` 并 verify，**再**阶段 B 确认批量后改 `taskGroupConfig`。总流程见 Skill `topics/dev-flow.md`；manifest 细则见 **`AGENTS.md` §3**、会话物化的 **`.cursor/rules/automation-manifest.mdc`**。

**`cmd`**：任务目录名（复制本目录时重命名文件夹即可），不必写在 manifest 里。  
**`target`**：依赖本 SDK 的任务固定为 `browser`，不必写。

字段类型与 JSON 结构见 **[`../xport_browser_sdk/CONFIG_SCHEMA.md`](../xport_browser_sdk/CONFIG_SCHEMA.md)**；本目录 `package.json` 为完整示例。

## 入口

| 文件 | 用途 |
|------|------|
| `validate.ts` | 校验 schema + 生成 `config.types.ts` |
| `gen-types.ts` | 仅生成类型 |
| `main.ts` | 执行单条任务 |
| `distribute.ts` | 任务组 → 分发任务 |

## 快速测试

**前提**：桌面端已启动；`main.ts` 还需对应浏览器已连接。在任务目录下用 **`{sdkPath}/bun`**（macOS/Linux）或 **`{sdkPath}/bun.exe`**（Windows），勿用系统 Bun：

```bash
# macOS / Linux（正式任务：wire 由桌面按 TASK_ID HTTP 注入）
../bun install

DEVICE_ID=1 LISTEN_PORT=19080 TASK_ID=1001 DESKTOP_PORT=19818 \
  ../bun --no-env-file main.ts
```

```bat
REM Windows（任务目录下）
..\bun.exe install
set DEVICE_ID=1& set LISTEN_PORT=19080& set TASK_ID=1001& set DESKTOP_PORT=19818
..\bun.exe --no-env-file main.ts
```

详见 [`AGENTS.md`](./AGENTS.md) §5（本地命令）与 §6（常见错误）。

## 新建项目

1. 复制本目录并重命名为你的任务名（即 `cmd`），位于 `{SDK_PATH}/` 下。
2. 按 **[`CONFIG_SCHEMA.md`](../xport_browser_sdk/CONFIG_SCHEMA.md)** 编辑 `taskGroupConfig` / `taskRunConfig`。
3. `{BUN} --no-env-file validate.ts` 校验并生成 `config.types.ts`。
4. 实现 `distribute.ts`、`main.ts`（引用 `./config.types.ts`）。
