// Fallback for `supabase functions serve` in sandboxes whose outbound TLS is
// intercepted by a private CA that the edge-runtime container does not trust
// (it ignores DENO_CERT / the system store when it fetches jsr: modules, so
// every worker fails to boot with "invalid peer certificate: UnknownIssuer").
//
// Serves every function in supabase/functions UNCHANGED under the host's Deno
// (which does trust the CA) and emulates the gateway's verify_jwt check from
// supabase/config.toml. Kong keeps routing /functions/v1/* to
// supabase_edge_runtime_vero:8081; serve-functions-host.sh puts a socat
// container with that name in front of this process.
//
//   deno run -A --no-lock tests/e2e/tools/host-functions.ts
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, plus any
// function secrets (CRON_SECRET, ...). LISTEN_PORT (default 8081).

const root = new URL("../../../supabase/", import.meta.url);
const listenPort = Number(Deno.env.get("LISTEN_PORT") ?? 8081);
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const config = await Deno.readTextFile(new URL("config.toml", root));
const verifyJwt = new Map<string, boolean>();
for (const m of config.matchAll(/\[functions\.([a-z0-9-]+)\]\s*\nverify_jwt\s*=\s*(true|false)/g)) {
  verifyJwt.set(m[1], m[2] === "true");
}

const names: string[] = [];
for await (const e of Deno.readDir(new URL("functions/", root))) {
  if (e.isDirectory && !e.name.startsWith("_")) {
    try {
      await Deno.stat(new URL(`functions/${e.name}/index.ts`, root));
      names.push(e.name);
    } catch { /* not a function */ }
  }
}
names.sort();

const ports = new Map<string, number>();
const workerScript = new URL("fn-worker.ts", import.meta.url).pathname;
let next = listenPort + 100;
for (const name of names) {
  const port = next++;
  ports.set(name, port);
  new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--no-lock", "--quiet", "--config", new URL("functions/deno.json", root).pathname, workerScript, name, String(port)],
    env: { ...Deno.env.toObject() },
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
}
console.log(`[host-functions] ${names.length} functions:`, names.map((n) => `${n}${verifyJwt.get(n) === false ? "" : " (jwt)"}`).join(", "));

async function jwtOk(req: Request): Promise<boolean> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  if (token === anonKey || token === serviceKey) return true;
  const res = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: anonKey, Authorization: `Bearer ${token}` } });
  await res.body?.cancel();
  return res.ok;
}

Deno.serve({ port: listenPort, hostname: "0.0.0.0" }, async (req) => {
  const url = new URL(req.url);
  const [, name, ...rest] = url.pathname.split("/");
  const port = ports.get(name);
  if (!port) return Response.json({ msg: "function not found" }, { status: 404 });
  if (req.method !== "OPTIONS" && verifyJwt.get(name) !== false && !(await jwtOk(req))) {
    return Response.json({ msg: "Invalid JWT" }, { status: 401 });
  }
  const target = `http://127.0.0.1:${port}/${name}/${rest.join("/")}${url.search}`;
  const body = req.body ? await req.arrayBuffer() : undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(target, {
        method: req.method,
        headers: req.headers,
        body,
        redirect: "manual",
      });
    } catch (e) {
      if (attempt >= 40) return Response.json({ msg: `worker unavailable: ${e}` }, { status: 502 });
      await new Promise((r) => setTimeout(r, 250));
    }
  }
});
