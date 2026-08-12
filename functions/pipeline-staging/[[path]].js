const DASHBOARD_KEY = "wxopticon/dashboard.json";
const HISTORY_INDEX_KEY = "wxopticon/history/index.json";
const HISTORY_SNAPSHOT_KEY =
  /^wxopticon\/history\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.json$/;

function isAllowed(key) {
  return (
    key === DASHBOARD_KEY ||
    key === HISTORY_INDEX_KEY ||
    HISTORY_SNAPSHOT_KEY.test(key)
  );
}

export async function onRequestGet(context) {
  const key = (context.params.path ?? []).join("/");
  if (!isAllowed(key)) return new Response("Not found", { status: 404 });
  if (!context.env.WXOPTICON_STAGING) {
    return new Response("Staging data unavailable", { status: 503 });
  }

  const object = await context.env.WXOPTICON_STAGING.get(key);
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers({
    "cache-control": "public, max-age=15",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  if (object.httpEtag) headers.set("etag", object.httpEtag);
  return new Response(object.body, { headers });
}
