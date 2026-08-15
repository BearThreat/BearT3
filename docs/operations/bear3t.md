# Bear3t fork purpose and changes

Bear3t is Barrett's public fork of [T3 Code](https://github.com/pingdotgg/t3code). It preserves
the upstream product while carrying a small set of reliability changes proven in a private,
multi-device Tailscale deployment.

## Why the fork exists

The deployment uses one coding-agent host with browsers connecting from Linux, Windows, and
Android over a private tailnet. The server remains on loopback while Tailscale Serve terminates
HTTPS. That topology exposed two practical failures in T3 Code 0.0.33:

1. the server saw the proxy-side HTTP request and issued its persistent browser-session cookie
   without `Secure`, even though the browser's public origin was HTTPS;
2. the chat header's identity and project-action controls occupied the same pixels on a narrow
   phone viewport.

## Fork-specific changes

### Opt-in Secure browser-session cookies

Set this only when a trusted HTTPS reverse proxy terminates TLS in front of T3 Code:

```bash
T3CODE_BROWSER_COOKIE_SECURE=true
```

The browser-session cookie then retains its existing persistent, `HttpOnly`, `SameSite=Lax`, and
path settings while also carrying `Secure`. The setting is deliberately opt-in so direct plain-HTTP
local access continues to work.

### Two-row narrow-screen chat header

Below 640 CSS pixels, the chat header becomes 96 pixels tall. Project identity/navigation stays on
the first row and scripts, editor, Git, terminal, and panel actions move to a separate second row.
The toast offset moves with the header so notifications do not cover the controls.

### Android pairing operational note

Pairing must happen in the browser's normal persistent tab/profile. Some Android external-link
flows use an ephemeral WebView cookie partition: authentication can appear correct until the
browser process is killed, then vanish. Open the clean `/pair` page in a normal tab, enter the
one-time token there, restart the browser, and verify the ordinary environment URL still opens
without returning to `/pair`.

## Validation target

For a reverse-proxied deployment, acceptance means:

- the public HTTPS origin receives one persistent `Secure`, `HttpOnly`, `SameSite=Lax` session
  cookie;
- a newly opened tab reaches the authenticated workspace without `/pair`;
- a browser restart preserves that result;
- at a 375-pixel viewport, header controls are individually visible and tappable without overlap.

## Upstream relationship

Bear3t remains an MIT-licensed fork of T3 Code. Upstream is tracked as
`pingdotgg/t3code`; fork-specific behavior is intentionally small and documented here so future
upstream syncs can be reviewed cleanly.
