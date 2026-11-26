import type { FeishuSettingsView } from '../feishu-types.ts';

export const feishuConnectionLabel: Record<FeishuSettingsView['connection'], string> = {
  disabled: '当前宿主未启用',
  offline: '连接不可用',
  connecting: '正在连接',
  ready: '连接就绪',
  reconnecting: '正在重连',
  stopped: '连接已停止',
};
