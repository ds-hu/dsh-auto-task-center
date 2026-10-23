# 10. The origin fence trusts the request's own Host

Date: 2026-10-23
Status: accepted

## Context

Every mutating route calls `assertSameOriginJson(req, originOf())`. The check exists so a page on another
origin cannot drive the panel's API with a plain cross-origin form post, which is possible without CORS.

A user installed the plugin on a VPS, reached the panel through Cloudflare Access, and reported that editing
a task's message did nothing. The message was typed, the Save request went out, and the browser showed a
failed request: `403 cross-origin`. Reproduced against that instance:

```
Origin: https://dsh.example.com   → 403 cross-origin
Origin: http://127.0.0.1:3080     → 200
```

`originOf()` is `getOrigin()` from the Host web server, which is protocol + **bind host** + listened port. Behind
a proxy the listener binds `127.0.0.1:3080` while the browser is on `https://dsh.example.com`, so the two can
never match. The fence was not a security boundary — the routes are reachable only on the listen address — but
it made the panel read-only for every proxied deployment.

## Decision

Compare the announced `Origin` with the **host the request was addressed to**, not with the bound address:

1. `X-Forwarded-Host` (first value), when a proxy set it;
2. otherwise the `Host` header;
3. `originOf()` remains a match too, for a direct caller that sends no `Host` of its own.

Same-site is `new URL(origin).host === host`, lowercase. Browsers omit default ports from both headers, so
`https://dsh.example.com` matches `Host: dsh.example.com` and `http://127.0.0.1:4173` matches
`Host: 127.0.0.1:4173`.

## Consequences

- The panel works unchanged through nginx, an SSH tunnel, Cloudflare Access, or a local proxy.
- A page on another site announces its own host, which never matches the `Host` it addressed, so the
  cross-origin rejection survives — verified by a test that sends `Origin: https://evil.example` with
  `Host: dsh.example.com`.
- The JSON content-type requirement stays: it is the part a cross-origin form post cannot satisfy.
- A malicious local process could spoof both headers, but it could also write the store directly; the fence was
  never the boundary that stopped it.
