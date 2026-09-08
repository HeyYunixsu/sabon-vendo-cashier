# Kiosk / POS Mode

Turning the counter tablet into a till: no address bar, no tabs, no wandering
off to another site, and a screen that does not sleep mid-queue.

There are three separate jobs here, and they are independent. Doing only the
first still leaves a tablet a cashier can browse away from.

| | Job | Where it is done |
|---|---|---|
| 1 | Remove the browser chrome | The device, using tags already in the page |
| 2 | Lock the device to the dashboard | The device's own settings |
| 3 | Stop the screen sleeping | The device, plus the page's Wake Lock |

---

## 1. Remove the browser chrome

### iPad / iPhone — the smooth path

1. Open the dashboard in **Safari** (not Chrome — only Safari can install to the
   home screen on iOS).
2. Share button → **Add to Home Screen** → Add.
3. Launch it from the new icon, **not** from Safari.

It opens with no address bar and no tabs. The icon and the name come from
`apple-touch-icon.png` and the `apple-mobile-web-app-title` tag in the page, so
nothing needs configuring.

### Android tablet

Chrome → menu → **Add to Home screen**. This gives a shortcut, but it still
opens inside Chrome with the address bar visible.

**Why:** a chromeless install on Android is a WebAPK, and Chrome only builds one
over **HTTPS**. This machine serves plain HTTP on the shop LAN, so Chrome
declines. The page ships a `manifest.json` with `display: standalone` already,
so the moment the dashboard is served over HTTPS this starts working with no
code change.

Until then, on Android use **Settings → Fullscreen** in the dashboard.
Switch it **On** and Chrome goes fullscreen: no address bar, no tabs, no
system navigation bar.

**To leave, switch the toggle Off.** Swiping down from the top drops out of
fullscreen only until the next tap: any exit that is not the toggle is treated
as accidental and restored. That is deliberate — on a counter tablet a stray
swipe should not quietly end kiosk mode for the rest of the day.

The toggle is remembered, because fullscreen itself cannot be. A reload or a
reboot always drops fullscreen, and **no page is allowed to put itself
fullscreen on load** — browsers require a user gesture, or every pop-up ad
would take the whole screen. So after a power cut the tablet comes up in a
normal window and enters fullscreen on the first touch of the shift. Nobody
has to visit Settings again.

For a tablet that must be fullscreen before anyone touches it, install a kiosk
browser app — the usual choice for a POS — or serve the dashboard over HTTPS
so Chrome installs it properly.

### Windows / Linux PC

Make a desktop shortcut with the `--kiosk` flag:

```
chrome.exe --kiosk http://dgsi.local
```

No tabs, no address bar, no exit except Alt+F4. `--app=http://dgsi.local` is a
softer version: its own window, still no tabs, but the user can close it.

---

## 2. Lock the device to the dashboard

Without this, a cashier can swipe out of the dashboard and into anything else.

### iPad — Guided Access

1. Settings → Accessibility → **Guided Access** → on.
2. Passcode Settings → set a passcode **the cashier does not know**.
3. Open the dashboard, then **triple-click the side button** → Start.

Triple-click and enter the passcode to leave. The device is now locked to the
dashboard, including through a restart of the app.

### Android — App pinning

Settings → Security → **App pinning** → on, then pin Chrome (or the kiosk
browser) from the recent-apps view. Require the unlock PIN to unpin.

---

## 3. Stop the screen sleeping

**On the device:**

- iPad: Settings → Display & Brightness → Auto-Lock → **Never**.
- Android: Settings → Display → Screen timeout → longest available.

Keep the tablet on its charger. Auto-Lock: Never on battery will flatten it
inside a shift.

**In the page:** the dashboard requests a **Screen Wake Lock** on load and
re-requests it whenever it comes back to the foreground. Supported on iOS 16.4+
and Android Chrome; on anything older it does nothing, silently, which is why
the device setting above still matters.

---

## What to expect once it is a kiosk

- **There is no reload button.** The dashboard reconnects its own live feed, so
  this is normally fine. If the page itself ever wedges, close it from the app
  switcher and reopen — with Guided Access on, end the session first.
- **The Fullscreen row in Settings is hidden on iPad.** iOS implements the
  Fullscreen API for video only, so the button would do nothing. Add to Home
  Screen is the iOS path, and it gives a better result than fullscreen anyway.
- **The dashboard has no login, by design.** The Wi-Fi password is the boundary.
  Kiosk mode locks the *device*; it does not restrict who on the shop network
  can open the dashboard.
