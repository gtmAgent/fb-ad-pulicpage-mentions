# 工作流编排模板（Agent 指南）

本目录是 **工作流** Bun 项目模版（`xportWorkflow`），用于串联多个已安装的 **自动化脚本**（`xportAutomation`）。

## 与自动化模版的区别

| | 自动化脚本 | 工作流 |
|--|-----------|--------|
| manifest 键 | `xportAutomation` | `xportWorkflow` |
| 入口 | `main.ts`（单设备单任务） | `main.ts`（编排，动态入队） |
| 分发 | `distribute.ts` | 无 |
| SDK | `xport-*-sdk` | `xport-workflow-sdk` |
| 启动参数 | `taskRunConfig` / `taskGroupConfig` | `workflowRunConfig` |
| 结果展示 | `taskResultConfig` | `workflowResultConfig` |

## 推荐 `main.ts` 结构

```typescript
import {
  XportWorkflowClient,
  loadWorkflowManifest,
  loadWorkflowRunConfig,
} from 'xport-workflow-sdk';

const manifest = await loadWorkflowManifest();
const cfg = await loadWorkflowRunConfig(manifest);

process.exit(
  await XportWorkflowClient.run(async (ctx) => {
    const step = await ctx.runAutomation({
      cmd: 'target-automation-cmd',
      deviceId: 1,
      target: 'browser',
      config: { /* 与目标脚本 taskRunConfig 键一致 */ },
    });
    if (!step.succ) return { succ: false, msg: step.msg };

    return { succ: true, msg: 'done', data: { processed: 1, summary: '...' } };
  }),
);
```

**采集型工作流**（须落库多行）才加 manifest `intermediateDataSchema`，并在步骤中调用 `prepareIntermediateStorage` / `ingestIntermediateRows` — 见 `WORKFLOW_DATA_AND_RESULT.md` §0–§1。

**收尾等待（SDK 固化）**：`XportWorkflowClient.run` 在编排回调返回后会自动 `waitForGroupIdle`——任务组仍有 pending / running / **paused** 时进程不退出（含仅 `enqueueTask` / 跨天 `planStartAt`）。仅 completed / failed 算任务结束；**paused 不算**。勿在 `main.ts` 里提前 `process.exit`。子步骤由客户端调度执行，编排只入队与查询结果。

**子自动化采集数据**：采集型浏览器等脚本写入的业务行，用 `ctx.queryAutomationData(子cmd)` / `ctx.fetchAllAutomationData(子cmd, { taskId })` 读取（默认本任务组）；详见 `{SDK_PATH}/xport_workflow_sdk/WORKFLOW_DATA_AND_RESULT.md` §1.0。

## 环境变量（桌面端注入）

| 变量 | 说明 |
|------|------|
| `SDK_PATH` | 本机 SDK 根目录 |
| `AUTOMATION_CMD` / `WORKFLOW_CMD` | 工作流目录名 |
| `AUTOMATION_CACHE_DIR` | 任务临时目录（`{SDK_PATH}/cache/{cmd}/`；勿写 cwd；缺 env 勿回落） |
| `TASK_GROUP_ID` | 本次运行任务组 id |
| `WORKFLOW_ID` | 桌面端 `WorkflowModel.id` |
| `LISTEN_PORT` | 手动停止 sidecar 端口 |
| `DESKTOP_PORT` | 桌面 HTTP 端口 |
| `FFMPEG_PATH` / `YTDLP_PATH` | 编排内直接混剪/下载时 |
| *（用户自定义）* | 「设置 → 环境变量」 |

与自动化子任务相同：`AUTOMATION_CACHE_DIR` 等由桌面在启动 `main.ts` 时注入，脚本勿写死 `/tmp`，Write/Shell 用绝对路径。

## 自检

```bash
cd {SDK_PATH}/{workflow_cmd}
../bun --no-env-file validate.ts
../bun --no-env-file gen-types.ts
```

若 `main.ts` 使用 `ctx.aiPrompt`，交付前在 `xportWorkflow.scriptAi` 声明 `enabled` 与 `purpose`（见 `SCRIPT_AI_PROMPT.md`）。

有 schema/行为变更时 bump `package.json` `version`，并同步 **`{SDK_PATH}/{cmd}_tar.txt`**（单行，与 `version` 相同）。

## 完成检查

- [ ] `{BUN} --no-env-file validate.ts` 退出码 `0`（或 MCP `task_workflow_validate`）
- [ ] `workflowRunConfig` / `workflowResultConfig` 与 `main.ts` 一致
- [ ] **`flowChart`**：`main.ts` 主路径写完后同轮已写；改编排已同步；客户可读；侧栏「流程图」可核对
- [ ] 子任务 `config` 键与目标自动化 `taskRunConfig` 一致
- [ ] **`{SDK_PATH}/{cmd}_tar.txt` 已与 `package.json` version 同步**（bump 版本时必做）
- [ ] 未加 shebang、未配 `package.json` scripts
- [ ] 临时文件仅 `AUTOMATION_CACHE_DIR`（中间文件/自测勿写 cwd）
- [ ] 核对清单见会话物化的 **`.cursor/rules/automation-manifest.mdc`**（打开智能体会话时由本软件覆盖注入）

## 文档

- Schema / manifest 总览：`{SDK_PATH}/xport_workflow_sdk/CONFIG_SCHEMA.md` **§1**
- 中间数据与结果：`{SDK_PATH}/xport_workflow_sdk/WORKFLOW_DATA_AND_RESULT.md`
- 脚本内单次 AI：`{SDK_PATH}/xport_workflow_sdk/SCRIPT_AI_PROMPT.md`
- SDK API：本文件
- 模版：`{SDK_PATH}/workflow_automation_template/AGENTS.md`

## 常见陷阱

1. **子任务 config 键名** 必须与目标自动化 `taskRunConfig` 一致，不能抄工作流 `workflowRunConfig`。
2. **`listAutomationScripts()`** 只返回自动化脚本，不含其它工作流；**设计会话**编写代码时仍以 Agent 上下文 **本会话允许的自动化脚本** 为准，勿扩选清单外 `cmd`。
3. **中间数据** 仅采集型工作流才配 `intermediateDataSchema` + `prepareIntermediateStorage` / `ingestIntermediateRows`；`cmd` 用工作流目录名。
4. **返回值** `data` 键名须与 `workflowResultConfig` 一致，否则详情页无法渲染结果。
5. 设备须在线；子任务由调度器异步执行，编排侧用 `waitForTask` 轮询，勿在 HTTP 层阻塞过久。
