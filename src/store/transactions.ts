import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError, requiredText } from '../model.ts';

type StoredReceipt = { hash: string; result: string };

export function writeTransaction<T>(db: DatabaseSync, write: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = write();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function storedReceipt(db: DatabaseSync, id: string): StoredReceipt | undefined {
  return db.prepare('SELECT hash,result FROM requests WHERE id=?').get(id) as StoredReceipt | undefined;
}

function requestHash(action: string, payload: unknown): string {
  // Callers supply the normalized payload in its persisted property order.
  return createHash('sha256').update(JSON.stringify({ action, payload })).digest('hex');
}

function readResult<T>(receipt: StoredReceipt, hash: string): T {
  if (receipt.hash !== hash) throw new AppError('idempotency-conflict', '同一请求标识不能用于不同的内容。');
  return JSON.parse(receipt.result) as T;
}

export function readCommandReceipt<T>(db: DatabaseSync, requestId: string, action: string, payload: unknown): T | undefined {
  const id = requiredText(requestId, '请求标识', 200);
  const receipt = storedReceipt(db, id);
  return receipt ? readResult<T>(receipt, requestHash(action, payload)) : undefined;
}

export function runCommand<T>(db: DatabaseSync, requestId: string, action: string, payload: unknown, apply: () => T): T {
  const id = requiredText(requestId, '请求标识', 200);
  const hash = requestHash(action, payload);
  return writeTransaction(db, () => {
    const receipt = storedReceipt(db, id);
    if (receipt) return readResult<T>(receipt, hash);

    const result = apply();
    db.prepare('INSERT INTO requests VALUES (?,?,?)').run(id, hash, JSON.stringify(result));
    return result;
  });
}
