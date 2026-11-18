# ArchiChat (standalone)

A shared study chat for architecture and construction. Friends join with **their name and a room code**, with no Claude account needed. Claude runs on the server and:

- lights a **bulb** on a message when it has a correction, an answer, an addition or a code/book reference,
- answers **follow-up questions** about any bulb note,
- files key facts into **What we learned** and uses them later,
- writes **ARE-style quiz** questions from what you discussed.

Everything is stored in one JSON file (`DATA_DIR/archichat.json`).

## Settings (environment variables)

| Variable | Required | What it is |
|---|---|---|
| `ROOM_CODE` | yes | The password people type to join. Share it only with your friends. |
| `ANTHROPIC_API_KEY` | for the bulb | Your Claude API key from https://console.anthropic.com. Without it the chat works but the bulb and quiz are off. |
| `DATA_DIR` | no | Folder for the data file. Defaults to `./data`. On a host, point it at a persistent disk. |
| `PORT` | no | Defaults to 3000. Hosts set this for you. |
| `CLAUDE_MODEL` | no | Defaults to `claude-opus-5-5`. |

Claude calls opt into server-side refusal fallbacks (`fallbacks: "default"`), so a request a safety check declines is retried on another model instead of failing.

Cost: roughly one Claude call per message, plus one per follow-up or quiz question. Expect a few US cents per message on `claude-opus-5-5`. Set a monthly spend limit in the Anthropic Console.

## Run it on your computer

```bash
cd archichat-server
npm install
ROOM_CODE=pick-a-code ANTHROPIC_API_KEY=sk-ant-... npm start
# open http://localhost:3000
```

## Put it online (Render)

1. Push this repo to GitHub (already done if you are reading this there).
2. At https://render.com: **New > Blueprint**, pick this repository. Render reads `render.yaml` at the repository root, which points at the `archichat-server` folder.
3. Fill in `ROOM_CODE` and `ANTHROPIC_API_KEY` when prompted.
4. Render gives you an address like `https://archichat.onrender.com`. Open it, enter your name and the room code.

The blueprint uses the Starter plan (about US$7/month) because the free plan wipes the disk on every restart and you would lose your chat history.

Any other Node host works too (Railway, Fly.io, a VPS). Give it `npm install`, `npm start`, the two variables above, and a persistent folder for `DATA_DIR`.

## Use your own domain: archichat.app

1. Buy `archichat.app` from a registrar (Namecheap, Porkbun, Cloudflare, GoDaddy and others sell `.app`, roughly US$15/year).
2. In Render: your service > **Settings > Custom Domains > Add**, add `archichat.app` and `www.archichat.app`.
3. Render shows the DNS records to add. At your registrar, add them (usually an `A` record for `archichat.app` and a `CNAME` for `www`).
4. Wait for DNS (minutes to a few hours). Render issues the HTTPS certificate automatically. `.app` domains only open over HTTPS, so wait until Render shows the certificate as issued. Typing `archichat.app` in Chrome then opens ArchiChat.

## Invite a friend

Send them `https://archichat.app` and the room code. They pick a name and they're in. If they use the same name next time, they get their history and their bulb state back.
