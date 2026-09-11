/**
 * 工作台的推进逻辑：建档 → 调试 → 方案。
 *
 * 这里集中定义"什么算齐备"和"当前该做什么"。界面提示与下发给助手的上下文
 * 都取自同一份判断，避免出现"界面说缺东西、助手却在直接产出方案"的错位。
 */

export type FlowStage = 'archive' | 'debug' | 'plans';

/** 调试分析模块尚未合并进当前工作台。接入后把这里改成 true 即可打通后续阶段。 */
export const DEBUG_MODULE_INTEGRATED = false;

/** 建档阶段的必填项，数组顺序即建议补充顺序。 */
export const ARCHIVE_REQUIRED_FIELDS: { key: string; label: string }[] = [
  { key: 'area', label: '村庄面积' },
  { key: 'households', label: '常住户数' },
  { key: 'population', label: '常住人口' },
  { key: 'elderlyPopulation', label: '老年人口' },
  { key: 'old', label: '老年人口占比' },
  { key: 'livingAlone', label: '60岁以上老年人口数' },
  { key: 'mobilityLimited', label: '行动受限老人' },
  { key: 'economy', label: '主要经济模式' },
  { key: 'budget', label: '建设预算' },
  { key: 'direction', label: '期望建设方向' },
  { key: 'elderProfiles', label: '重点老人画像' },
  { key: 'elderBehaviors', label: '村中老人的日常活动' },
];

/** 图片库的三个槽位，与档案页的上传卡一一对应。 */
export const PHOTO_SLOTS: { title: string; sub: string }[] = [
  { title: '卫星航拍图', sub: '了解道路、居住点与设施的整体关系' },
  { title: '重点区域与道路', sub: '记录高差、积水、断点与建设约束' },
  { title: '村庄场景图片', sub: '留存老人真实使用与停留场景' },
];

export type NextAction =
  | 'address'
  | 'fields'
  | 'photos'
  | 'align-debug'
  | 'debug-pending'
  | 'debug'
  | 'confirm-plan'
  | 'plan';

export type WorkspaceFlow = {
  stage: FlowStage;
  archive: {
    ready: boolean;
    missingFields: string[];
    missingSlots: string[];
    photoCount: number;
  };
  debug: {
    integrated: boolean;
    /** 用户已确认疑点对齐、同意进入调试。 */
    confirmed: boolean;
    runCount: number;
    markCount: number;
  };
  /** 进入调试前需要与用户对齐的疑点。 */
  openIssues: string[];
  nextAction: NextAction;
  nextActionLabel: string;
};

type FlowProject = {
  address?: string;
  fields?: Record<string, string>;
  photos?: { category?: string }[];
  marks?: { label?: string; status?: string }[];
  debugRuns?: unknown[];
  plans?: { tasks?: string[] }[];
  debugEntry?: string;
};

/** 汇总需要用户确认的疑点：档案里记录的待核问题，以及尚未确认的空间标记。 */
function collectOpenIssues(project: FlowProject): string[] {
  const issues: string[] = [];

  const recorded = project.fields?.openQuestions ?? '';
  for (const part of recorded.split(/[、;；\n]/)) {
    const item = part.trim();
    if (item) issues.push(item);
  }

  for (const mark of project.marks ?? []) {
    if (mark?.label && mark.status !== '已确认') {
      issues.push(`${mark.label}（待核实）`);
    }
  }

  return issues;
}

function filled(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 档案里尚未填写、允许从文档回填的字段（键名与表单一一对应）。 */
export function fillableArchiveFields(
  project: FlowProject,
): { key: string; label: string }[] {
  const fields = project.fields ?? {};
  return ARCHIVE_REQUIRED_FIELDS.filter((item) => !filled(fields[item.key]));
}

export function computeWorkspaceFlow(
  project: FlowProject,
  stage: FlowStage,
): WorkspaceFlow {
  const fields = project.fields ?? {};
  const photos = project.photos ?? [];

  const missingFields = ARCHIVE_REQUIRED_FIELDS.filter(
    (item) => !filled(fields[item.key]),
  ).map((item) => item.label);

  const missingSlots = PHOTO_SLOTS.filter(
    (slot) => !photos.some((photo) => photo.category === slot.title),
  ).map((slot) => slot.title);

  const addressMissing = !filled(project.address);
  const archiveReady =
    !addressMissing && !missingFields.length && !missingSlots.length;

  const runCount = project.debugRuns?.length ?? 0;
  const markCount = project.marks?.length ?? 0;
  const confirmedPlans = (project.plans ?? []).filter(
    (plan) => (plan.tasks?.length ?? 0) > 0,
  ).length;

  const debugConfirmed = project.debugEntry === 'confirmed';

  const nextAction: NextAction = addressMissing
    ? 'address'
    : missingFields.length
      ? 'fields'
      : missingSlots.length
        ? 'photos'
        : !debugConfirmed
          ? 'align-debug'
          : !DEBUG_MODULE_INTEGRATED
            ? 'debug-pending'
            : runCount === 0
              ? 'debug'
              : stage === 'plans' && confirmedPlans === 0
                ? 'confirm-plan'
                : 'plan';

  let nextActionLabel: string;
  switch (nextAction) {
    case 'address':
      nextActionLabel = '先补上村庄地址';
      break;
    case 'fields': {
      const parts = [`档案信息还缺 ${missingFields.length} 项`];
      if (missingSlots.length) {
        parts.push(`图片库还缺 ${missingSlots.length} 类影像`);
      }
      nextActionLabel = `先补齐建档：${parts.join('，')}`;
      break;
    }
    case 'photos':
      nextActionLabel = `补齐图片库，还缺 ${missingSlots.length} 类影像`;
      break;
    case 'align-debug':
      nextActionLabel = '档案已齐备，对齐待核疑点后进入调试';
      break;
    case 'debug-pending':
      nextActionLabel = '已确认进入调试，等待接入调试分析';
      break;
    case 'debug':
      nextActionLabel = '先完成调试分析';
      break;
    case 'confirm-plan':
      nextActionLabel = '由你在对话中确认方案后转入方案工作区';
      break;
    default:
      nextActionLabel = '在方案工作区修改与比对';
  }

  return {
    stage,
    archive: {
      ready: archiveReady,
      missingFields,
      missingSlots,
      photoCount: photos.length,
    },
    debug: {
      integrated: DEBUG_MODULE_INTEGRATED,
      confirmed: debugConfirmed,
      runCount,
      markCount,
    },
    openIssues: archiveReady && !debugConfirmed ? collectOpenIssues(project) : [],
    nextAction,
    nextActionLabel,
  };
}
