/**
 * 从本任务 schema 生成 `config.types.ts`（会先校验）。
 *
 * ```bash
 * {BUN} --no-env-file gen-types.ts
 * ```
 */
import { runTaskGenTypes } from 'xport-browser-sdk';

process.exit(await runTaskGenTypes());
