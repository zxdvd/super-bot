import { isUtf8 } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from './model.ts';
import { parseWorkLink, type WorkLink } from './work-links.ts';

export const CONVENTION_FILE = 'work-convention.md';
export const CONVENTION_LIMIT = 4000;
const MAX_BYTES = 16 * 1024;
const INDEX = `# Bot 记忆\n\n- [工作约定](${CONVENTION_FILE}) · 新任务的默认约定\n`;
const conventionHeader = /^# 工作约定\n\n<!-- super-bot: (\d+) (\d+) -->\n\n/;
const decisionPath = /^decisions\/[a-z0-9][a-z0-9-]{0,79}\.md$/;

function directory(path: string, create: boolean): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat) {
    if (!stat.isDirectory()) throw new AppError('memory-path', 'Bot 记忆目录不可用。');
    return true;
  }
  if (create) mkdirSync(path, { mode: 0o700 });
  return create;
}

function readMarkdown(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new AppError('memory-path', '无法打开 Bot 记忆文件。');
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) {
      throw new AppError('memory-format', 'Bot 记忆须为至多 16 KiB 的独立 Markdown 文件。');
    }
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    const content = buffer.subarray(0, bytes);
    if (bytes > MAX_BYTES || !isUtf8(content) || content.includes(0)) throw new AppError('memory-format', 'Bot 记忆须为至多 16 KiB 的 UTF-8 Markdown。');
    return content.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function publish(dir: string, name: string, markdown: string): void {
  const temporary = join(dir, `.${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, markdown, { flush: true });
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, join(dir, name));
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
}

type Convention = { text: string; generation: number; seq: number };
export class BotMemory {
  constructor(private dataDir: string) {}

  private path(botId: string, create = false): string | undefined {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(botId)) throw new AppError('memory-path', '无效的 Bot 标识。');
    const root = join(this.dataDir, 'memory'), path = join(root, botId);
    if (directory(root, create) && directory(path, create)) return path;
  }

  index(botId: string): string {
    const path = this.path(botId, true)!;
    const index = readMarkdown(join(path, 'index.md'));
    if (index !== undefined) return index;
    publish(path, 'index.md', INDEX);
    return INDEX;
  }

  private readConvention(botId: string): Convention | undefined {
    const path = this.path(botId);
    const markdown = path && readMarkdown(join(path, CONVENTION_FILE));
    if (markdown === undefined) return;
    const header = conventionHeader.exec(markdown);
    const text = header && markdown.slice(header[0].length).trim();
    if (!header || !text || text.length > CONVENTION_LIMIT) throw new AppError('memory-format', '工作约定文件格式无效。');
    return { text, generation: Number(header[1]), seq: Number(header[2]) };
  }

  defaultConvention(botId: string): string | undefined {
    return this.readConvention(botId)?.text;
  }

  saveConvention(botId: string, text: string, generation: number, seq: number): void {
    const prior = this.readConvention(botId);
    if (prior && (generation < prior.generation || (generation === prior.generation && seq <= prior.seq))) {
      if (generation === prior.generation && seq === prior.seq && text === prior.text) return;
      throw new AppError('memory-stale', '这条消息对应的保存已处理或已有更新的工作约定。');
    }
    this.index(botId);
    const path = this.path(botId)!;
    publish(path, CONVENTION_FILE, `# 工作约定\n\n<!-- super-bot: ${generation} ${seq} -->\n\n${text}\n`);
  }

  readDecision(botId: string, entry: string): { text: string; source: WorkLink } {
    const path = this.path(botId);
    const index = path && readMarkdown(join(path, 'index.md'));
    const entries = index?.matchAll(/^- \[[^\]\r\n]+\]\(([^)\r\n]+)\)\s*$/gm);
    if (!path || !decisionPath.test(entry) || !entries || !Array.from(entries).some(match => match[1] === entry)
      || !directory(join(path, 'decisions'), false)) throw new AppError('memory-entry', '没有这条已索引的决策。');
    const markdown = readMarkdown(join(path, entry));
    const header = /^\[来源\]\(\/(#[^)\r\n]+)\)\r?\n\r?\n/.exec(markdown ?? '');
    const source = header && parseWorkLink(header[1]!);
    const text = header && markdown!.slice(header[0].length).trim();
    if (!source || source.kind === 'question' || !text) throw new AppError('memory-source', '决策正文或任务／成果来源缺失。');
    return { text, source };
  }
}
