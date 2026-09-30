/**
 * pm2 definition for the gateway itself.
 *
 *   npm run pm2:start     build the admin UI, start the gateway, pm2 save
 *   npm run pm2:restart   rebuild the UI and restart
 *
 * Managed apps are separate pm2 processes (namespace "localserver", names "ls-<app>-<service>").
 * Restarting the gateway leaves them running and re-adopts them.
 */
const { resolve } = require('node:path');

const ROOT = __dirname;

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

module.exports = {
  apps: [
    {
      name: 'localserver',
      script: resolve(ROOT, 'gateway', 'src', 'index.ts'),
      cwd: ROOT,
      // pm2 maps .ts to bun by default; Node 25 runs this TypeScript natively.
      interpreter: 'node',
      node_args: ['--disable-warning=ExperimentalWarning'],
      exec_mode: 'fork',
      instances: 1,
      // Pass an explicit env instead of whatever shell ran `pm2 start`.
      filter_env: true,
      env: {
        ...pick(process.env, ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR', 'TERM', 'PM2_HOME']),
        NODE_ENV: 'production',
        PORT: 8080,
      },
      autorestart: true,
      restart_delay: 1000,
      max_restarts: 20,
      min_uptime: '5s',
      max_memory_restart: '300M',
      watch: false,
      out_file: resolve(ROOT, 'data', 'logs', 'gateway-out.log'),
      error_file: resolve(ROOT, 'data', 'logs', 'gateway-error.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
