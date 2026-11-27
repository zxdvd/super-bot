export const stageGoal =
  '请先整理资料目录、核对引用，等引用检查流水线成功后编排附录，再交付最终说明。';
export const stageSupplement =
  '引用检查仍照旧等待。编排附录的时候也只读核对引用日志，写入一条日志位置。';
export const stageRevoke = '说明任务的附录不用再编排了，撤回这个下一步，保留已经核对的引用。';
export const stageArtifacts = [
  {
    name: '资料目录',
    filename: 'catalog.txt',
    contents: '已编目三篇合成资料',
    nextStep: '核对引用',
  },
  { name: '引用', filename: 'references.txt', contents: '已核对三项引用', nextStep: '编排附录' },
  {
    name: '附录',
    filename: 'appendix.txt',
    contents: '已按主题组织附录',
    nextStep: '交付最终说明',
  },
];

export const stoppableGoal = 'STOP_PROBE 等待整理资料';
export const closeTask = '这份等待整理的资料不用做了，关掉。';

export const ownerAcceptance = '这版资料说明成果看起来可以。';
export const ownerAcceptanceConfirm = '可以。';
export const ownerSessionTitle = '已有合成材料会话';
export const ownerOldGoal = '合成关联任务草稿';
export const ownerNewGoal = '已有材料的简短说明';
export const ownerRevise = `把「${ownerOldGoal}」的目标改为「${ownerNewGoal}」。`;
export const ownerInspect = `请给「${ownerNewGoal}」关联「${ownerSessionTitle}」这条已有会话。`;
export const ownerRefuse = '先别关联。';
export const ownerConfirm = '好，就用它。';
export const ownerDetach = `解除「${ownerNewGoal}」的执行会话关联，保留材料。`;
export const ownerPrepare = `先为「${ownerNewGoal}」准备新执行会话，暂时不运行。`;

export const rosterGoal = '整理合成名单，保存本地草稿。';
export const rosterDirection = '沿用原有 26 人名单，只补第 26 项缺少的负责人，写入原文件。';
export const rosterDraft =
  Array.from({ length: 26 }, (_, i) => [i + 1, i === 25 ? '待补' : '保留'].join(' ')).join('\n') +
  '\n';
export const rosterFinal = rosterDraft.replace('26 待补', '26 已补');
