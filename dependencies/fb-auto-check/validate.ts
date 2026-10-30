/**
 * 校验本任务 `package.json` → `xportAutomation`，并生成 `config.types.ts`。
 *
 * 校验项：schema wire、类型生成、任务组频率默认值（`validateTaskGroupScheduleConfig`）。
 * 改 manifest 前：录制指引业务步骤，MCP 实时读屏定 DOM；阶段 A 用户确认（Skill §1.2）。见 AGENTS.md §3。
 *
 * ```bash
 * {BUN} --no-env-file validate.ts
 * ```
 */
import {
  defaultValuesFromFormGroups,
  loadAutomationManifest,
  runTaskValidate,
  validateTaskGroupScheduleConfig,
} from 'xport-browser-sdk';

const code = await runTaskValidate();
if (code !== 0) process.exit(code);

try {
  const manifest = await loadAutomationManifest();
  const defaults = defaultValuesFromFormGroups(manifest.taskGroupConfig);
  const errors = validateTaskGroupScheduleConfig(defaults);
  if (errors.length > 0) {
    console.error(`task group schedule validation failed (${manifest.cmd}):`);
    for (const line of errors) console.error(`  - ${line}`);
    process.exit(1);
  }
  console.log('OK: task group schedule defaults');
  process.exit(0);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
