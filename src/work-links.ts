/** Shared route grammar for links emitted in chat and opened by the work panel. */
export type WorkLink = { taskId: string } & (
  | { kind: 'task' }
  | { kind: 'question'; attentionId: string }
  | { kind: 'result'; resultId: string }
);

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const taskIdPattern = new RegExp(`^${uuid}$`);
const attentionIdPattern = new RegExp(`^run:${uuid}$`);
export const RESULT_FILE_PATH = '/api/super-bot-file';

export function resultFileUrl(resultId: string, index: number, sessionId?: string): string {
  const query = new URLSearchParams({ resultId, index: String(index) });
  if (sessionId !== undefined) query.set('sessionId', sessionId);
  return `${RESULT_FILE_PATH}?${query}`;
}

export function parseResultFileLink(url: URL): { resultId: string; index: number } | undefined {
  if (url.pathname !== RESULT_FILE_PATH || url.hash || url.searchParams.size !== 2) return;
  const resultId = url.searchParams.get('resultId'),
    index = url.searchParams.get('index');
  if (
    resultId &&
    taskIdPattern.test(resultId) &&
    index &&
    /^(0|[1-9][0-9]*)$/.test(index) &&
    Number.isSafeInteger(Number(index))
  ) {
    return { resultId, index: Number(index) };
  }
}

export function workUrl(link: WorkLink): string {
  const hash = new URLSearchParams({ 'super-bot-task': link.taskId });
  if (link.kind === 'question') hash.set('attentionId', link.attentionId);
  if (link.kind === 'result') hash.set('resultId', link.resultId);
  return `/#${hash}`;
}

export function parseWorkLink(hash: string): WorkLink | undefined {
  const params = new URLSearchParams(hash.slice(1));
  const taskId = params.get('super-bot-task');
  if (
    !hash.startsWith('#') ||
    !taskId ||
    !taskIdPattern.test(taskId) ||
    params.getAll('super-bot-task').length !== 1
  )
    return;
  if (params.size === 1) return { kind: 'task', taskId };
  if (params.size !== 2) return;
  const attentionId = params.get('attentionId'),
    resultId = params.get('resultId');
  if (attentionId && attentionIdPattern.test(attentionId))
    return { kind: 'question', taskId, attentionId };
  if (resultId && taskIdPattern.test(resultId)) return { kind: 'result', taskId, resultId };
}
