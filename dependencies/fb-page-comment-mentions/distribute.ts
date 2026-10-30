/**
 * 任务组分发入口：将组配置按本任务规则拆成多条待运行任务。
 *
 * 规则：
 * - 主页列表按身份去重（同一数字 ID / 同一 vanity 路径只生成一条任务）
 * - 每个主页只分发「一条」评论 +「一条」提及（从文案/图片池按序轮询取用）
 *
 * 阶段 B 定稿后试跑：`{BUN} --no-env-file distribute.ts`（桌面注入 wire）；
 * 核对 stdout `data.tasks` 条数与各条 `config` 键名与 `taskRunConfig` 一致。见 AGENTS.md §3.2、Skill `topics/manifest-phase.md`。
 */
import type { TaskGroupConfig } from './config.types';
import { canonicalizePageUrl, pageIdentityKey } from './page_identity';
import {
  type AutomationRunResult,
  type AutomationTaskManifest,
  localDayEndSec,
  localDayStartSec,
  parseBrowserDeviceIds,
  parsePositiveIntConfig,
  parseTimeToMinutes,
  randomIntBetween,
  splitConfigLines,
  type TaskCreateInput,
  validateTaskGroupScheduleConfig,
  XportBrowserAdminClient,
} from 'xport-browser-sdk';

type PerBrowserScheduleState = {
  dayOffset: number;
  usedInDay: number;
  cursorSec: number;
};

function rollBrowserToNextDay(baseSec: number, st: PerBrowserScheduleState, dayStartMin: number): void {
  st.dayOffset += 1;
  st.usedInDay = 0;
  st.cursorSec = localDayStartSec(baseSec, st.dayOffset, dayStartMin);
}

/** 为「当前这条」任务准备可排期时刻：超结束时间、开始+间隔超结束、或超单日上限则滚到下一天。 */
function prepareSlotForCurrentTask(
  baseSec: number,
  st: PerBrowserScheduleState,
  dailyLimit: number,
  duringMin: number,
  dayStartMin: number,
  dayEndMin: number,
): void {
  const maxDayRolls = 366;
  let dayRolls = 0;
  for (;;) {
    const dayStart = localDayStartSec(baseSec, st.dayOffset, dayStartMin);
    const dayEnd = localDayEndSec(baseSec, st.dayOffset, dayEndMin);
    if (st.cursorSec < dayStart) st.cursorSec = dayStart;
    const exceedsDayEnd = st.cursorSec > dayEnd || st.cursorSec + duringMin > dayEnd;
    if (st.usedInDay >= dailyLimit || exceedsDayEnd) {
      if (++dayRolls > maxDayRolls) {
        throw new Error('schedule: too many day rollovers (check daily_limit / during_min / time window)');
      }
      rollBrowserToNextDay(baseSec, st, dayStartMin);
      continue;
    }
    return;
  }
}

function normalizeResources(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof raw === 'string' && raw.trim()) {
    return [raw.trim()];
  }
  return [];
}

/** 列表内主页去重：保留首次出现顺序；规范为 profile.php?id= 便于执行。 */
function dedupeHosts(rawHosts: string[]): { hosts: string[]; skippedDuplicates: number } {
  const seen = new Set<string>();
  const hosts: string[] = [];
  let skippedDuplicates = 0;
  for (const raw of rawHosts) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = pageIdentityKey(trimmed);
    if (seen.has(key)) {
      skippedDuplicates += 1;
      continue;
    }
    seen.add(key);
    hosts.push(canonicalizePageUrl(trimmed));
  }
  return { hosts, skippedDuplicates };
}

function pickPoolLine(lines: string[], index: number): string {
  if (lines.length === 0) return '';
  return lines[index % lines.length]!;
}

function pickPoolResource(items: string[], index: number): string[] {
  if (items.length === 0) return [];
  return [items[index % items.length]!];
}

async function distributeGroup(ctx: {
  manifest: AutomationTaskManifest;
  groupConfig: TaskGroupConfig;
  gid: number;
}): Promise<AutomationRunResult> {
  const { groupConfig, manifest, gid } = ctx;
  const { hosts, skippedDuplicates } = dedupeHosts(splitConfigLines(groupConfig.hosts));
  const browserIds = parseBrowserDeviceIds(groupConfig.browsers);

  if (hosts.length === 0) {
    return { succ: false, msg: 'no hosts in group config' };
  }
  if (browserIds.length === 0) {
    return { succ: false, msg: 'no browsers selected' };
  }

  const commentTextLines = splitConfigLines(String(groupConfig.comment_texts ?? ''));
  const mentionTextLines = splitConfigLines(String(groupConfig.mention_texts ?? ''));
  const commentImages = normalizeResources(groupConfig.comment_images);
  const mentionImages = normalizeResources(groupConfig.mention_images);

  const hasComment = commentTextLines.length > 0 || commentImages.length > 0;
  const hasMention = mentionTextLines.length > 0 || mentionImages.length > 0;
  if (!hasComment && !hasMention) {
    return {
      succ: false,
      msg: 'need at least one comment or mention text/image in group config',
    };
  }

  const dailyLimit = parsePositiveIntConfig(groupConfig.daily_limit, 10);
  const duringMin = parsePositiveIntConfig(groupConfig.during_min, 60);
  const duringMax = parsePositiveIntConfig(groupConfig.during_max, 600);
  const dayStartMin = parseTimeToMinutes(groupConfig.daily_time_start, '09:00');
  const dayEndMin = parseTimeToMinutes(groupConfig.daily_time_end, '18:00');
  const scheduleErrors = validateTaskGroupScheduleConfig(groupConfig);
  if (scheduleErrors.length > 0) {
    return { succ: false, msg: scheduleErrors.join('; ') };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const perBrowserSchedule = new Map<number, PerBrowserScheduleState>();
  const tasks: TaskCreateInput[] = [];

  for (let i = 0; i < hosts.length; i++) {
    const host = hosts[i]!;
    const browserId = browserIds[i % browserIds.length]!;
    const st: PerBrowserScheduleState =
      perBrowserSchedule.get(browserId) ??
      ({
        dayOffset: 0,
        usedInDay: 0,
        cursorSec: Math.max(nowSec, localDayStartSec(nowSec, 0, dayStartMin)),
      } satisfies PerBrowserScheduleState);

    prepareSlotForCurrentTask(nowSec, st, dailyLimit, duringMin, dayStartMin, dayEndMin);

    // 每个主页只配一条评论 + 一条提及（从池轮询），禁止把整池塞进单任务导致连发
    const commentText = pickPoolLine(commentTextLines, i);
    const mentionText = pickPoolLine(mentionTextLines, i);
    const commentImage = pickPoolResource(commentImages, i);
    const mentionImage = pickPoolResource(mentionImages, i);

    const planStartAt = st.cursorSec;
    tasks.push({
      gid,
      cmd: manifest.cmd,
      deviceId: browserId,
      target: manifest.target,
      config: {
        host,
        comment_texts: commentText,
        comment_images: commentImage,
        mention_texts: mentionText,
        mention_images: mentionImage,
      },
      planStartAt,
    });

    st.usedInDay += 1;
    st.cursorSec = planStartAt + randomIntBetween(duringMin, duringMax);

    perBrowserSchedule.set(browserId, st);
  }

  if (tasks.length === 0) {
    return { succ: false, msg: 'no tasks generated (check daily_limit / hosts / browsers)' };
  }

  const dedupNote =
    skippedDuplicates > 0 ? `, dropped ${skippedDuplicates} duplicate page URL(s)` : '';
  return {
    succ: true,
    msg: `generated ${tasks.length} tasks (1 comment+mention per page)${dedupNote}`,
    data: { tasks },
  };
}

process.exit(await XportBrowserAdminClient.runDistribute<TaskGroupConfig>(distributeGroup));
