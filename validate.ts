/**
 * 校验本工作流 `package.json` → `xportWorkflow`，并生成 `config.types.ts`。
 *
 * ```bash
 * {BUN} --no-env-file validate.ts
 * ```
 */
import { runTaskValidate } from 'xport-workflow-sdk';

process.exit(await runTaskValidate());
