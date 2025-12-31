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
- Queue actions for when you're back online

An offline indicator appears when you lose connection.

### Auto-Update

HAPI automatically checks for updates:

- Updates are checked hourly in the background
- When a new version is available, you'll see a prompt
- Click "Reload" to get the latest version

### Background Sync

Actions taken offline are synced when reconnected:

- Pending messages are sent
- Permission decisions are relayed
- Session state is refreshed

## Caching Strategy

HAPI uses intelligent caching:

| Content | Strategy | Duration |
|---------|----------|----------|
| App shell | Cache first | Until update |
| Sessions API | Network first | 5 minutes |
| Machines API | Network first | 10 minutes |
| Static assets | Cache first | Forever |

## Notifications

::: warning Work in Progress
Push notifications are planned for a future release. Currently, notifications work through:
- Telegram bot (recommended)
- Keeping the app open in background
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

On Android, disable battery optimization for HAPI to ensure:
- Background sync works reliably
- Notifications arrive promptly

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
- No background sync on iOS
- Limited offline capabilities

## Telegram Mini App Alternative

If PWA doesn't suit your needs, consider the Telegram Mini App:

- Works inside Telegram
- No separate installation
- Same features as PWA
- Integrated notifications

See [Installation Guide](/guide/installation#telegram-setup) for Telegram setup.
