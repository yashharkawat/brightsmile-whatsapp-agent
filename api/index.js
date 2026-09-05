// Vercel Node runtime entry. Vercel's Node helpers pre-read the request body (req.body), which leaves the
// IncomingMessage stream consumed, so the stock @hono/node-server listener would hang on c.req.json().
// We therefore rebuild a web Request from what Vercel gives us and call app.fetch directly.
import app from "../src/index.js";

export default async function handler(req, res) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const url = `${proto}://${host}${req.url}`;
  const method = req.method || "GET";
  let body;
  if (!["GET", "HEAD"].includes(method)) {
    if (req.body !== undefined && req.body !== null) {
      body = typeof req.body === "string" || Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body);
    } else {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = Buffer.concat(chunks);
    }
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  const response = await app.fetch(new Request(url, { method, headers, body }));
  res.statusCode = response.status;
  response.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(Buffer.from(await response.arrayBuffer()));
}
