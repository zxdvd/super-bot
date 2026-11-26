import { AppError } from './model.ts';

/** One gate for in-flight admission and for the protected development reload. */
export class ReloadAdmission {
  private paused = false;
  private readonly inFlight = new Map<symbol, string>();

  blockers(): string[] {
    return [...this.inFlight.values()];
  }

  pause(): () => void {
    if (this.paused || this.inFlight.size) throw Error('reload admission is already occupied');
    this.paused = true;
    return () => {
      this.paused = false;
    };
  }

  tryEnter(description: string): (() => void) | undefined {
    if (this.paused) return;
    const ticket = Symbol();
    this.inFlight.set(ticket, description);
    return () => {
      this.inFlight.delete(ticket);
    };
  }

  async run<T>(description: string, operation: () => Promise<T>): Promise<T> {
    const leave = this.tryEnter(description);
    if (!leave)
      throw new AppError('reload-in-progress', '开发重载暂时停止派发新工作，请等命令结束后再试。');
    try {
      return await operation();
    } finally {
      leave();
    }
  }
}
