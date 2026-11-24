import { AppError, type DeliveryLinks } from './model.ts';

export function deliveryArtifactUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^https?:\/\/[^/?#@]+(?:[/?#]|$)/i.test(value) || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return;
  try {
    const url = new URL(value);
    if (url.hostname && !url.username && !url.password) return value;
  } catch { /* A malformed address has no external action. */ }
}

export function readDeliveryLinks(value: unknown, allowDeletion: false): DeliveryLinks;
export function readDeliveryLinks(value: unknown, allowDeletion: true): Record<string, string | null>;
export function readDeliveryLinks(value: unknown, allowDeletion: boolean): Record<string, string | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('invalid-delivery-links', '交付物需要提供显示名与链接的映射。');
  }
  const map = value as Record<string, unknown>;
  const entries = new Map<string, string | null>();
  for (const name of Object.keys(map).sort()) {
    if (!name.trim()) throw new AppError('invalid-delivery-links', '交付物显示名不能为空。');
    const url = allowDeletion && map[name] === null ? null : deliveryArtifactUrl(map[name]);
    if (url === undefined) {
      throw new AppError('invalid-delivery-links', '交付物链接需要使用不含凭据的完整 HTTP(S) 地址。');
    }
    entries.set(name, url);
  }
  return Object.fromEntries(entries);
}
