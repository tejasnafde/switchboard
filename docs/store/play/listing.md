# Google Play store listing: Switchboard

Paste-ready text and files for Play Console > Grow > Store presence > Main
store listing. Package `app.tn07.switchboard`, the native app in
`apps/android`. Decisions come from `docs/plans/2026-10-12-store-publishing.md`.
The policy forms (Data safety, Content rating, App access) are in
[`data-safety.md`](data-safety.md).

## App details

| Field | Value |
|---|---|
| App name (30 max) | `Switchboard: Run Your Agents` (28) |
| Short description (80 max) | `Watch, steer and approve your desktop coding agents from your phone.` (68) |
| App or game | App |
| Category | Tools |
| Tags | Developer tools, Productivity, Remote control (pick the closest matches Play offers; up to 5) |
| Price | Free, all countries |
| Ads | No ads |
| Contact email | `review@tn07.dev` |
| Website | Leave empty. `switchboard.tn07.dev` only redirects to the retired APK. |
| Privacy policy | `https://tn07.dev/privacy` |

## Full description

Under 4000 characters (about 2200). Plain text, no em dashes, no other
product names.

```text
Your coding agents keep working when you step away from your desk. Switchboard puts them in your pocket.

Switchboard connects your phone to the Switchboard desktop app on your own computer. Every chat your agents run there shows up on your phone, live. You read what they are doing, answer their questions, approve the commands they want to run, and send the next instruction, from anywhere.

WHY PEOPLE USE IT

- Approve without walking back. When an agent asks to run a command or edit a file, you get a notification. Read the exact command and tap Approve or Deny.
- Steer a running agent. Type or dictate a follow-up while it works, or queue one for when it finishes. Stop a turn that went the wrong way.
- Review the changes. Every edited file shows a line-by-line diff, so you see what changed before you trust it.
- Answer questions and plans. When an agent asks you to pick an option or approve a plan, the choices appear as buttons.
- Keep up with pull requests. The Reviews tab lists your open pull requests with their checks and conversations, and you can start an agent on one.
- Start new work. Open a new chat in any project on your computer and pick the agent and model.
- Several machines. Pair your laptop, a desktop at home and a cloud machine, and switch between them.

YOUR CODE STAYS ON YOUR MACHINE

Switchboard has no cloud account and no relay server of its own. Your phone talks straight to the desktop app you run, over an encrypted connection pinned to that machine. Your chats, code and files never pass through our servers. There are no ads and no tracking, and we run no analytics of our own.

TRY IT FIRST

Not set up yet? Tap Try the demo on the first screen. It plays a sample project with a running agent, an approval to tap and a pull request list, all offline, with no account and no computer needed.

GETTING STARTED

1. Install the free Switchboard desktop app on your Mac or Windows computer.
2. In the desktop app, open Settings, then Mobile pairing, to show a QR code.
3. Scan it with this app. You can also type the address by hand.

Switchboard is for developers who run coding agents on their own computers. You need the desktop app and your own agent subscriptions to use it beyond the demo.
```

## Release notes (first release, 500 max)

```text
First release on Google Play.
- See every agent chat from your Switchboard desktop app, live.
- Approve or deny commands from a notification.
- Steer, queue or stop a running agent by text or voice.
- Review file diffs and your open pull requests.
- Pair by QR code over an encrypted, pinned connection.
- Try the demo with no computer or account.
```

## Graphics

All files are in this folder. They are generated, not drawn by hand.

| Play field | File | Spec |
|---|---|---|
| App icon | `icon-512.png` | 512 x 512, 32-bit PNG. The adaptive icon (foreground on `#0A0A0A`); Play applies its own corner mask. |
| Feature graphic | `feature-graphic-1024x500.png` | 1024 x 500, 24-bit PNG, no alpha. |
| Phone screenshots | `01-connections.png` ... `06-reviews.png` | 1080 x 1920 (9:16), 24-bit PNG. |

Screenshot order and captions (Play shows no captions; this is the order to
upload):

1. `01-connections.png` - the Connections screen, with Try the demo.
2. `02-chats.png` - the demo project's chat list.
3. `03-running-chat.png` - an agent at work.
4. `04-approval.png` - an approval card for a command.
5. `05-diff.png` - a file diff opened for review.
6. `06-reviews.png` - the Reviews tab with open pull requests.

Why 1080 x 1920 and not 1080 x 2400: Play takes phone screenshots only when
the long side is at most twice the short side (2400 / 1080 = 2.22 fails), and
9:16 at 1080 px or more keeps them eligible for promotion.

### How to regenerate

- Icon and feature graphic: `source/render.py` (the feature graphic is
  `source/feature-graphic.html`, which reads the app's own fonts and icon).
- Screenshots: the Robolectric test `StoreScreenshotsTest` renders the real
  Compose screens in demo mode. It is skipped unless `SB_STORE_SHOTS_DIR` is
  set:

  ```sh
  cd apps/android
  SB_STORE_SHOTS_DIR="$PWD/../../docs/store/play" ./gradlew :app:testDebugUnitTest \
    --tests '*StoreScreenshotsTest' --max-workers=2
  ./gradlew --stop
  ```

  Then run `source/render.py` again: it flattens the screenshots to 24-bit
  PNG, which Play requires.

  Known issue: in the render, the finished demo chat's header reads
  "Reconnecting" instead of "Ready" (visible in `05-diff.png`). It is not yet
  checked on a device. If a device shows it too, fix the demo runtime, then
  regenerate.

  The screenshots show the demo strip ("Demo, sample data, offline"). That is
  deliberate: they are real screens of the build a reviewer installs.
