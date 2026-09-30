const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Shown to browser navigations while a backend cold-starts. Reloads itself until the app answers. */
export function wakePage(appName: string, serviceName: string, error = ''): string {
  const title = error ? `${appName} failed to start` : `Starting ${appName}…`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --bg:#f7f7f5; --fg:#1b1b1b; --muted:#6b6b6b; --accent:#2f6fed; --err:#c0392b; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141414; --fg:#eaeaea; --muted:#9a9a9a; --accent:#6b9bff; --err:#ff7b6b; } }
  html,body { height:100%; margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 -apple-system, system-ui, sans-serif; }
  main { height:100%; display:grid; place-items:center; padding:16px; box-sizing:border-box; }
  .box { max-width:520px; text-align:center; }
  h1 { font-size:20px; font-weight:600; margin:16px 0 4px; }
  p { color:var(--muted); margin:0; }
  pre { text-align:left; white-space:pre-wrap; font-size:12px; color:var(--err); background:rgba(127,127,127,.1); padding:12px; border-radius:8px; max-height:40vh; overflow:auto; }
  .spin { width:28px; height:28px; margin:auto; border-radius:50%; border:3px solid rgba(127,127,127,.25); border-top-color:var(--accent); animation:s .8s linear infinite; }
  @keyframes s { to { transform:rotate(360deg) } }
  button { margin-top:16px; font:inherit; padding:6px 14px; border-radius:6px; border:1px solid rgba(127,127,127,.4); background:transparent; color:inherit; cursor:pointer; }
</style></head>
<body><main><div class="box">
${
  error
    ? `<h1>${esc(appName)} · ${esc(serviceName)} failed to start</h1><pre>${esc(error)}</pre><button onclick="location.reload()">Try again</button>`
    : `<div class="spin" role="status" aria-label="Loading"></div><h1>Starting ${esc(appName)}</h1><p>Waking up ${esc(serviceName)}. This page reloads when it's ready.</p>
<script>setTimeout(function(){ location.reload(); }, 700);</script>`
}
</div></main></body></html>`;
}
