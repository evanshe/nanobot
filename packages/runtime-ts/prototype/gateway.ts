// Distribution probe only: no profile reads, model calls or production routes.
import { createServer } from 'node:http';

const server = createServer((_request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ runtime: process.version, source: import.meta.url }));
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing TCP address');
  console.log(JSON.stringify({ port: address.port, pid: process.pid }));
});
function stop(signal: string): void {
  server.close(() => {
    console.log(JSON.stringify({ stopped: signal }));
    process.exitCode = 0;
  });
}
process.once('SIGTERM', () => stop('SIGTERM'));
process.once('SIGINT', () => stop('SIGINT'));
