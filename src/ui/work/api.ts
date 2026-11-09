/** The narrow client boundary the work views use; implemented by client.tsx against DSH. */
export interface WorkspaceApi {
  call<T>(action: string, payload?: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
  openSession(id: string): void;
  beginNavigation(): AbortSignal;
  openBot(id: string, navigation?: AbortSignal): Promise<void>;
  currentSession?(): string | undefined;
}
