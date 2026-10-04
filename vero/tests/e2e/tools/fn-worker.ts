// Runs ONE Edge Function (supabase/functions/<name>/index.ts) unchanged under
// the host's Deno on a given port. Used by host-functions.ts.
//
//   deno run -A --no-lock fn-worker.ts <name> <port>
const [name, portArg] = Deno.args;
const port = Number(portArg);
const original = Deno.serve.bind(Deno);
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (a: any, b?: any) => {
  const handler = typeof a === "function" ? a : b ?? a.handler;
  return original({ port, hostname: "127.0.0.1", onListen: () => {} }, handler);
};
const url = new URL(`../../../supabase/functions/${name}/index.ts`, import.meta.url);
await import(url.href);
