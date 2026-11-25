export const readRecoveryGoal='RECOVERY_READ_PROBE';
export const effectRecoveryGoal='RECOVERY_EFFECT_PROBE';
export const readRecoveryRequest='只读核对任务目录内的 preflight.txt。RECOVERY_READ_PROBE';
export const effectRecoveryRequest='在任务目录写入本地合成标记，然后核对 preflight.txt。RECOVERY_EFFECT_PROBE';
export const recoveryFileName='preflight.txt';
export const recoveryEffectName='effect-receipt.txt';
export const recoveryEffectText='SYNTHETIC_EFFECT_APPLIED_ONCE\n';

export const permissionRecoveryGoal='RECOVERY_PERMISSION_PROBE';
export const permissionRecoveryRequest='只读核对 Kubernetes synthetic context 的共享身份在 fixture namespace 是否有 get persistentvolumeclaims 权限。RECOVERY_PERMISSION_PROBE';
export const permissionProbe={kind:'permission',context:'synthetic',namespace:'fixture',name:'',verb:'get',resource:'persistentvolumeclaims'};
export const deploymentRecoveryGoal='RECOVERY_DEPLOYMENT_PROBE';
export const deploymentRecoveryRequest='只读核对 Kubernetes synthetic context 的共享身份能否看到 fixture namespace 的 Deployment fixture-deployment 是否就绪。RECOVERY_DEPLOYMENT_PROBE';
export const deploymentProbe={kind:'deployment-state',context:'synthetic',namespace:'fixture',name:'fixture-deployment'};
export const deploymentEffectGoal='RECOVERY_DEPLOYMENT_EFFECT_PROBE';
export const deploymentEffectRequest='先记录合成操作标记，然后只读核对 Kubernetes synthetic context 的共享身份能否看到 fixture namespace 的 Deployment fixture-deployment。RECOVERY_DEPLOYMENT_EFFECT_PROBE';
export const recoveryGoals=[readRecoveryGoal,effectRecoveryGoal,permissionRecoveryGoal,deploymentRecoveryGoal,deploymentEffectGoal];
