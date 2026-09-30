/**
 * Imported first by index.ts, before the pm2 library loads.
 *
 * When the gateway runs under pm2, pm2 copies the gateway's own settings (namespace, cwd,
 * max_memory_restart, restart_delay, …) into process.env, and pm2's library then applies them as
 * overrides to every app we start. Whatever shell launched the gateway leaks in too. Keep only
 * what the gateway itself needs; apps get their env explicitly (see LifecycleManager.buildSpec).
 */
const KEEP = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TMPDIR',
  'TERM',
  'PORT',
  'NODE_ENV',
  'LOCALSERVER_DATA',
  'PM2_HOME',
]);

for (const key of Object.keys(process.env)) {
  if (!KEEP.has(key) && !key.startsWith('LC_')) delete process.env[key];
}
