/**
 * 任务组分发：多行关键词平均分配到浏览器；国家代码与采集上限整组共用。
 *
 * 分配规则（已与用户确认）：
 * - 关键词数 ≤ 浏览器数：随机抽取与关键词数相同的浏览器，一对一
 * - 关键词数 > 浏览器数：打乱后轮询，使各浏览器任务数尽量平均
 *
 * 试跑需桌面注入 RUN_CONFIG_KEY / TASK_GROUP_ID。
 */
import type { TaskGroupConfig } from './config.types';
import { assignBrowsersEvenly } from './assign_browsers';
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

function normalizeCountryCode(raw: unknown): string {
  const t = String(raw ?? '').trim();
  if (!t) return 'CN';
  return t.toUpperCase();
}

async function distributeGroup(ctx: {
  manifest: AutomationTaskManifest;
  groupConfig: TaskGroupConfig;
  gid: number;
}): Promise<AutomationRunResult> {
  const { groupConfig, manifest, gid } = ctx;
  const keywords = splitConfigLines(groupConfig.keywords);
  const browserIds = parseBrowserDeviceIds(groupConfig.browsers);
  const country = normalizeCountryCode(groupConfig.country);
  const maxCount = parsePositiveIntConfig(groupConfig.max_count, 50);

  if (keywords.length === 0) {
    return { succ: false, msg: '请至少填写一个搜索关键词' };
  }
  if (browserIds.length === 0) {
    return { succ: false, msg: '请选择至少一台浏览器' };
  }

  const dailyLimit = parsePositiveIntConfig(groupConfig.daily_limit, 10);
  const duringMin = parsePositiveIntConfig(groupConfig.during_min, 1);
  const duringMax = parsePositiveIntConfig(groupConfig.during_max, 2);
  const dayStartMin = parseTimeToMinutes(groupConfig.daily_time_start, '09:00');
  const dayEndMin = parseTimeToMinutes(groupConfig.daily_time_end, '18:00');
  const scheduleErrors = validateTaskGroupScheduleConfig(groupConfig);
  if (scheduleErrors.length > 0) {
    return { succ: false, msg: scheduleErrors.join('; ') };
  }

  const assignedBrowsers = assignBrowsersEvenly(browserIds, keywords.length);
  const nowSec = Math.floor(Date.now() / 1000);
  const perBrowserSchedule = new Map<number, PerBrowserScheduleState>();
  const tasks: TaskCreateInput[] = [];

  for (let i = 0; i < keywords.length; i++) {
    const keyword = keywords[i]!;
    const browserId = assignedBrowsers[i]!;
    const st: PerBrowserScheduleState =
      perBrowserSchedule.get(browserId) ??
      ({
        dayOffset: 0,
        usedInDay: 0,
        cursorSec: Math.max(nowSec, localDayStartSec(nowSec, 0, dayStartMin)),
      } satisfies PerBrowserScheduleState);

    prepareSlotForCurrentTask(nowSec, st, dailyLimit, duringMin, dayStartMin, dayEndMin);

    const planStartAt = st.cursorSec;
    tasks.push({
      gid,
      cmd: manifest.cmd,
      deviceId: browserId,
      target: manifest.target,
      config: {
        keyword,
        country,
        max_count: maxCount,
        _gid: gid,
      },
      planStartAt,
    });

    st.usedInDay += 1;
    st.cursorSec = planStartAt + randomIntBetween(duringMin, duringMax);

    perBrowserSchedule.set(browserId, st);
  }

  if (tasks.length === 0) {
    return { succ: false, msg: 'no tasks generated (check daily_limit / keywords / browsers)' };
  }

  const usedBrowsers = new Set(assignedBrowsers);
  return {
    succ: true,
    msg: `generated ${tasks.length} tasks on ${usedBrowsers.size} browsers`,
    data: { tasks },
  };
}

process.exit(await XportBrowserAdminClient.runDistribute<TaskGroupConfig>(distributeGroup));
