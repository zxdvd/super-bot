export const artifactGoal = '请核对两条合成 MR、一个 CR 和联调方案，完成后登记到任务交付物。';
export const artifactDeliveryText = '已核对两条 MR、客户端 CR 和联调方案，等待你确认。';
export const artifactEditReply = '已按要求更新这项任务的交付物。';
export const artifactLinks = {
  '后端 MR': 'https://gitlab.example.invalid/team/service/-/merge_requests/1087',
  '前端 MR !37': 'https://gitlab.example.invalid/team/web/-/merge_requests/37',
  '客户端 CR 1842763': 'https://review.example.invalid/c/client/+/1842763',
  '飞书文档 · 联调方案': 'https://example.feishu.cn/docx/synthetic-plan',
};
export const supplementalDoc = 'https://example.feishu.cn/docx/synthetic-notes';
export const replacementMr = 'https://gitlab.example.invalid/team/service/-/merge_requests/1092';
export const artifactReference = 'https://reference.example.invalid/guide';
export const artifactPortProbeGoal = '请联调并交付这项隔离任务的合成评审和方案。';
export const artifactPortProbeText = `${artifactDeliveryText} [核对后端评审](${artifactLinks['后端 MR']})`;
export const artifactRevision = {
  text: '已完成返工并回读修订后的合成方案。',
  checks: '已核对修订版文件中的新增结论。',
  links: { '飞书文档 · 修订版方案': 'https://example.feishu.cn/docx/synthetic-revision' },
};
