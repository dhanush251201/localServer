'use strict';
/**
 * Loaded into every managed Node process via NODE_OPTIONS=--require. When a server in this process
 * starts listening on LOCALSERVER_READY_PORT, it tells the gateway over the Unix socket
 * LOCALSERVER_READY_SOCK, so the gateway can forward the waiting request immediately instead of
 * polling the port. It inherits into child Node processes (npm → vite); only the one that listens
 * on the port reports. It never changes the app's behaviour, and does nothing if the variables are unset.
 */
const sockPath = process.env.LOCALSERVER_READY_SOCK;
const port = Number(process.env.LOCALSERVER_READY_PORT || 0);
const name = process.env.LOCALSERVER_READY_NAME || '';
if (sockPath && port) {
  const net = require('node:net');
  const listen = net.Server.prototype.listen;
  let sent = false;
  net.Server.prototype.listen = function (...args) {
    this.once('listening', () => {
      const a = this.address();
      if (sent || !a || typeof a !== 'object' || a.port !== port) return;
      sent = true;
      const c = net.connect(sockPath, () => c.end(`${name}\n`));
      c.on('error', () => {});
      c.unref();
    });
    return listen.apply(this, args);
  };
}
