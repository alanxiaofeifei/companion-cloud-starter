import http from 'node:http';
// Safe container smoke target only. It deliberately cannot accept real updates.
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, {
      'content-type': 'application/json'
    });
    res.end('{"ok":true,"mode":"scaffold"}');
  }
  else {
    res.writeHead(503, {
      'content-type': 'application/json'
    });
    res.end('{"error":"production_wiring_not_implemented"}');
  }
});
server.listen(Number(process.env.PORT || 8080), '0.0.0.0');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
