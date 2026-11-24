import { SqliteDriver } from '@nanobot/runtime';
const driver = await SqliteDriver.open(process.argv[2]);
const controller = new AbortController();
let nativeCode = '';
let start = performance.now();
let writing: Promise<unknown> | undefined;
try {
  await driver.read(async snapshot => {
    start = performance.now();
    writing = driver.write(transaction => transaction.run('INSERT INTO interrupt_peer VALUES (?)', ['accepted during read']));
    const timer = setTimeout(() => controller.abort(), 30);
    try {
      return await snapshot.all('WITH RECURSIVE counter(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM counter WHERE n<1000000000) SELECT sum(n) AS total FROM counter');
    } catch (error) {
      nativeCode = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
      throw error;
    } finally { clearTimeout(timer); }
  }, controller.signal);
  throw new Error('Long query unexpectedly completed');
} catch (error) {
  if (!(error instanceof Error) || error.name !== 'AbortError' || nativeCode !== 'SQLITE_INTERRUPT') throw error;
  await writing;
  const peer = await driver.read(snapshot => snapshot.all('SELECT value FROM interrupt_peer'));
  if (peer[0]?.value !== 'accepted during read') throw new Error('Cancelled read interfered with its accepted peer write');
  console.log(JSON.stringify({ nativeCode, elapsedMs: performance.now() - start, writeCommitted: true }));
} finally { await driver.close(); }
