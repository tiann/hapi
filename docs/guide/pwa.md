# Progressive Web App (PWA)

HAPI's web interface is a fully-featured PWA that can be installed on your phone for a native app-like experience.

## What is PWA?

A Progressive Web App (PWA) is a web application that can be installed on your device and works like a native app:

- **Home screen icon** - Launch HAPI like any other app
- **Full screen mode** - No browser chrome, immersive experience
- **Offline support** - Basic functionality works without internet
- **Auto-updates** - Always get the latest version

## Installing HAPI PWA

### Android (Chrome/Edge)

1. Open HAPI in Chrome or Edge browser
2. Look for the **"Install HAPI"** banner at the bottom
3. Tap **"Install"**
4. HAPI appears on your home screen

::: tip
If you don't see the install banner, tap the three-dot menu and select **"Add to Home screen"** or **"Install app"**.
:::

### iOS (Safari)

1. Open HAPI in Safari browser
2. Tap the **Share** button (square with arrow)
3. Scroll down and tap **"Add to Home Screen"**
4. Tap **"Add"** in the top right corner

::: warning
iOS requires Safari for PWA installation. Chrome/Firefox on iOS don't support the "Add to Home Screen" feature.
:::

### Desktop (Chrome/Edge)

1. Open HAPI in your browser
2. Click the install icon in the address bar (⊕)
3. Or use the menu: **"Install HAPI..."**
4. HAPI opens as a standalone window

## PWA Features

### Offline Mode

When offline, HAPI can:

- Display cached session lists
- Show previously loaded messages

HAPI does not queue actions taken while offline — an offline banner appears at the top when you lose connection, and live features resume once you're back online.

### Auto-Update

HAPI checks for updates in the background and lets you choose when to reload:

- Updates are checked hourly and when you return to the tab
- When a new version is available, a persistent in-app banner appears at the top
- Tap **Reload** when you're ready to apply the update — the banner stays until you do
- Expand **"Why can't I dismiss this?"** on the banner for the rationale

HAPI uses a user-controlled reload instead of forcing an automatic refresh, so you choose when to reload. The banner cannot be dismissed without upgrading, so you won't forget you're on an old build.

### Share Target (Android)

On Android, HAPI appears in the system share sheet. When you share content to HAPI:

1. Chrome sends a `POST /share` multipart form (title, text, URL, and files) to the app
2. The service worker intercepts the request and stores the payload in IndexedDB
3. The app is then redirected (303) to the share picker, which reads the stored content

This lets you share images, PDFs, text, and other files directly into a session from any app.

## Caching Strategy

HAPI uses intelligent caching:

| Content | Strategy | Duration |
|---------|----------|----------|
| App shell | Cache first | Until update |
| Sessions API | Network first | 5 minutes |
| Machines API | Network first | 10 minutes |
| Session detail API | Network first | 5 minutes |
| CDN (cdn.socket.io) | Cache first | 30 days |
| CDN (telegram.org) | Cache first | 7 days |
| Static assets | Cache first | Forever |

## Notifications

HAPI supports push notifications to alert you when agents need attention.

### Enable Notifications

1. Open HAPI - a permission popup appears automatically
2. Tap **Allow** to enable notifications
3. If you missed the popup, go to system settings to grant permission

### Notification Types

| Type | When Sent |
|------|-----------|
| Permission Request | Agent needs your approval |
| Ready | Agent finished and awaits input |
| Task completed / Task failed | A background task finishes (success or failure) |

### Native Push via FCM

In addition to Web Push, the hub can send notifications through Firebase Cloud Messaging (FCM) to native companion apps on Android and Wear OS. When FCM is configured and a native device is registered for your namespace, the companion app is treated as the canonical notification surface — if FCM already delivered a notification, the hub skips the Web Push duplicate so you only get one alert. See the [native companion API contract](../api/native-companion-contract.md) for setup details.

::: tip
If push notifications don't work in your region (e.g., FCM unavailable), use [Telegram integration](./notifications.md#telegram-setup) instead.
:::

## Managing Your PWA

### Check Install Status

HAPI shows different UI based on install status:

- **Not installed** - Shows install prompt
- **Installing** - Shows progress indicator
- **Installed** - No prompt shown

### Uninstalling

**Android:**
1. Long-press the HAPI icon
2. Drag to "Uninstall" or tap the X

**iOS:**
1. Long-press the HAPI icon
2. Tap "Remove App" → "Delete App"

**Desktop:**
1. Open HAPI
2. Click the three-dot menu
3. Select "Uninstall HAPI"

### Clearing Cache

If you experience issues:

1. Open HAPI in browser (not installed version)
2. Open Developer Tools (F12)
3. Go to Application → Storage
4. Click "Clear site data"

## Best Practices

### Battery Optimization

On Android, disable battery optimization for HAPI to ensure notifications arrive promptly.

Settings → Apps → HAPI → Battery → Unrestricted

### Data Usage

HAPI uses minimal data:

- Initial load: ~500KB
- Cached after first load
- Only syncs changed data

### Multiple Devices

You can install HAPI on multiple devices:

- All devices use the same server
- Sessions sync across devices
- Same access token works everywhere

## Troubleshooting

### Install Button Not Showing

- Ensure you're using HTTPS (required for PWA)
- Try refreshing the page
- Check if already installed

### App Not Updating

1. Close the app completely
2. Reopen and wait for update prompt
3. If stuck, clear cache and reinstall

### Offline Mode Not Working

- Ensure you've loaded the app at least once online
- Check if ServiceWorker is registered (DevTools → Application)
- Clear cache and reload

### iOS-Specific Issues

- Must use Safari for installation
- Limited offline capabilities

## Telegram Mini App Alternative

If PWA doesn't suit your needs, consider the Telegram Mini App:

- Works inside Telegram
- No separate installation
- Same features as PWA
- Integrated notifications

See [Notifications](./notifications.md#telegram-setup) for Telegram setup.
