import { SessionLocation } from './location.ts';
import { SqliteDriver } from './sqlite.ts';
import { SessionRepository } from './repository.ts';
import { SessionState } from './state.ts';
import { importLegacyJsonl, finishLegacyIsolation } from './jsonl.ts';
export async function openSessionStore(options: { workspace: string; sessionsRoot: string; capacity?: number; generationExclusions?: readonly string[]; signal?: AbortSignal }): Promise<{ location: SessionLocation; state: SessionState; close(): Promise<void> }> {
  const location = await SessionLocation.open(options.workspace, options.sessionsRoot, { signal: options.signal });
  options.signal?.throwIfAborted();
  const driver = await SqliteDriver.open(`${location.sessionsDirectory}/sessions.sqlite3`), repository = new SessionRepository(driver);
  try {
    await driver.initializeSchema(transaction => importLegacyJsonl(transaction, repository, location.workspace));
    await driver.write(transaction => finishLegacyIsolation(transaction, repository, location.workspace));
    options.signal?.throwIfAborted();
    const state = new SessionState(repository, { capacity: options.capacity, generationExclusions: options.generationExclusions });
    return { location, state, close: () => state.close() };
  } catch (error) { await driver.close(); throw error; }
}
