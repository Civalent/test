# ArchiChat page for atdfw.web.app

This folder makes **https://atdfw.web.app/archichat** show an ArchiChat page whose button opens the app in a new window.

## Add it to your Firebase project

1. Copy the `archichat` folder into your Firebase Hosting `public` folder, so you have `public/archichat/index.html`.
2. Deploy: `firebase deploy --only hosting` (if the site has more than one target: `firebase deploy --only hosting:atdfw`).
3. Open https://atdfw.web.app/archichat and click **Open ArchiChat in a new window**.

If your `firebase.json` has a catch-all rewrite (`"source": "**"` → `/index.html`, common for single-page apps), Firebase still serves real files first, so `/archichat` keeps working. If it doesn't, add this rewrite above the catch-all:

```json
{ "source": "/archichat", "destination": "/archichat/index.html" }
```

## Linking from other pages on the site

Use a link that opens in a new window:

```html
<a href="https://claude.ai/artifact/6exGYVhH6bpzVgzhDsR7kk" target="_blank" rel="noopener">ArchiChat</a>
```

## Which app the button opens

- Now: the claude.ai version (`https://claude.ai/artifact/6exGYVhH6bpzVgzhDsR7kk`). Friends need a claude.ai account and an invite from the page's Share menu.
- After you deploy the standalone server and connect `archichat.app`: change the button's `href` to `https://archichat.app`. Then anyone can join with a name and the room code.

Browsers block pages from opening a new window by themselves, so the page uses a button the visitor clicks.
