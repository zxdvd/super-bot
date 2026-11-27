/** The narrow client boundary the work views use; implemented by client.tsx against DSH. */
export interface WorkspaceApi {
  botNavigation: ReturnType<typeof import('../bot-navigation.ts').createBotNavigation>;
  workFeed?: ReturnType<typeof import('./activity.tsx').createWorkFeed>;
  call<T>(action: string, payload?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
  openSession(id: string): void;
  openChildSession?(parentId: string, childId: string): void;
  beginNavigation(): AbortSignal;
  openBot(id: string, navigation?: AbortSignal): Promise<void>;
  openHome?(): void;
  currentSession?(): string | undefined;
  watchCurrentSession?(listener: () => void): () => void;
}
