import { randomUUID } from 'node:crypto';
import type { ChildWaitMember, RunChildWait } from './model.ts';

export interface NativeChildEdge {
  runId: string;
  id: string;
  provider: string;
  local: boolean;
  parentSessionId?: string;
  stopReason?: string;
}

type EndOutcome = Extract<RunChildWait['outcome'], 'converged' | 'clear' | 'cancelled' | 'unknown'>;
type RecordEdge = (edge: 'started' | 'updated' | 'ended', record: RunChildWait) => boolean;

/** One invocation of the host's existing tree wait. Stores facts independent of the viewing client. */
export class ChildWaitObservation {
  readonly id = randomUUID();
  private readonly startedAt = Date.now();
  private readonly members = new Map<string, ChildWaitMember>();
  private published = false;
  private ended = false;

  constructor(
    private boundary: Pick<RunChildWait, 'runId' | 'turn' | 'startSeq' | 'inputSeq' | 'source'>,
    active: Iterable<ChildWaitMember>,
    private record: RecordEdge,
  ) {
    for (const member of active) this.members.set(member.nativeRunId, member);
  }

  publish() {
    if (this.published || this.ended) return;
    this.published = this.record('started', this.snapshot());
  }

  observe(member: ChildWaitMember) {
    if (this.ended || (member.endedAt !== null && !this.members.has(member.nativeRunId))) return;
    this.members.set(member.nativeRunId, member);
    if (this.published) this.record('updated', this.snapshot());
  }

  finish(outcome: EndOutcome, endedAt: number | null, joined = false) {
    if (this.ended) return;
    if (joined) this.publish();
    this.ended = true;
    if (this.published) this.record('ended', this.snapshot(outcome, endedAt));
  }

  private snapshot(outcome?: EndOutcome, endedAt: number | null = null): RunChildWait {
    const children = [...this.members.values()];
    const active = children.filter((child) => child.endedAt === null).length;
    return {
      ...this.boundary,
      id: this.id,
      startedAt: this.startedAt,
      endedAt,
      children,
      outcome: outcome ?? (active ? 'waiting' : 'checking'),
      pendingCount: outcome === 'converged' || outcome === 'clear' ? 0 : active || null,
    };
  }
}
