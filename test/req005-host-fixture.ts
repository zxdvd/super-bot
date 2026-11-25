/** Synthetic conversation and file contents for the isolated REQ-005 native Web/Feishu run. */
export const preflightGoal = '首发预检';
export const preflightRequest = '请只读检查首发预检文件 preflight.txt，并告诉我实际结果。';
export const preflightFile = 'preflight.txt';
export const preflightValue = '合成发布前置已齐备';
export const preflightResult = `首发预检已实际读取：${preflightValue}。`;

export const imageGoal = '镜像升级';
export const imageRequest = '请处理镜像升级，先提交升级变更并核对升级入口。遇到范围变化先告诉我。';
export const imageBlocked = '变更已合入。线上仍是旧镜像，现有实例缺少正式升级作业。';
export const imageScope = '镜像升级先只查线上版本';
export const versionFile = 'fixture-version.txt';
export const imageVersion = 'registry.invalid/synthetic/image:old';
export const imageResult = `镜像升级只读核对：线上版本是 ${imageVersion}。`;

export const wiringGoal = '接线验证';
export const wiringRequest = '请处理接线验证。需要范围决定时，在这里问我。';
export const wiringQuestion = '接线验证需要决定：仅核对测试环境，还是追加配置？';
export const ambiguous = '先只查一下';
export const clarify = '你指镜像升级，还是接线验证？';
export const cancelWiring = '取消接线验证';
export const wiringCancelled = '已取消接线验证。';
export const pauseWiring = '暂停接线验证的自动管理';
export const wiringPaused = '已暂停接线验证的自动管理。';


export const startupGoal = '首次启动';
export const startupRequest = '请先启动合成环境的实例，再只读核对实例状态。';
export const startupContinue = '继续首次启动';
export const startupResult = '首启资源已创建，目前未就绪。原操作回执仍待核对。请应用负责人核对配置；保留原实例。';

export const pendingGoal = '同步校验';
export const pendingRequest = '请做同步校验，先检查本地基线。若尚缺条件，只汇报实际状态。';
export const pendingContinue = '继续同步校验';
export const pendingScope = '同步校验先只读现有回执';
export const baselineFile = 'fixture-baseline.txt';
export const baselineValue = '合成同步基线存在';
export const receiptFile = 'fixture-receipt.txt';
export const receiptValue = '合成回执：同步检查尚缺下游确认';
export const appendixScope = '同步校验也只读附录中的回执';
export const appendixFile = 'fixture-appendix.txt';
export const appendixValue = '附录记录：下游已签收';
export const pendingInitial = '同步基线存在，仍需在本地核对回执。';
export const pendingResult = `同步校验已读取两份回执：${receiptValue}。${appendixValue}。`;

export const req005Goals = [preflightGoal, imageGoal, wiringGoal, startupGoal, pendingGoal];
