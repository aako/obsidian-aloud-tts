# AirPods And Explicit Playback Controls (0.15.1-ios.3)

This experimental fork preserves `aloud-ios-fork`, the two alternating
`reading-progress.a.json` / `.b.json` files, and all existing user data.

The iPhone action menu has **Resume saved article**, **Start Over**,
**Pause/Continue**, **Previous**, **Next**, **Stop**, and a truthful
sentence-group count (or paragraph count when configured). Short sentences can
share one audio chunk. Start Over resets the checkpoint before a new track,
including when playback has not finished its first sentence. It never
silently interprets Start Over as normal cursor playback.

Web Media Session support is feature-detected. It installs play/pause and
previous/next handlers when supported by the Obsidian WebView; unsupported
handlers are ignored. Audio element `play()` rejections are observed and
reported. Stop closes the track without destroying the reusable audio store.

**Not a guarantee of persistent iOS Lock Screen controls.** Apple's host app
controls whether WKWebView can keep audio active in background. A JavaScript
plugin cannot restart a terminated WebView, prevent OS suspension, or force
native AVAudioSession/MediaPlayer integration. No fake/silent keepalive audio
is used. `disableRemotePlayback` is unchanged; AirPlay and AirPods Bluetooth
button behavior are different concerns.

## Physical iPhone Verification (Not Yet Performed)

1. Pause and continue after 5 seconds, both in app and with AirPods.
2. Pause for 2–5 minutes with the phone locked; then try AirPods Play.
3. Repeat after switching apps and after automatic ear removal/reinsertion.
4. Inspect Lock Screen/Control Center Now Playing before/during/after pause.
5. Force quit Obsidian; reopen and use Resume saved article, without autoplay.
6. Save progress halfway through an article, choose Start Over, and confirm it
   begins at the actual first sentence (including while the first chunk is active).

Record iOS version, Obsidian version, and which system-media controls appear.

Detached/PDF playback supports Pause/Continue and Start Over within its active
session. Durable recovery is for validated markdown-note selections; PDF and
clipboard text is not stored in the checkpoint files. If iOS closes the underlying
media source, reopen Obsidian and use Resume saved article for a saved note.
No installed plugin, vault content, credentials, or existing checkpoint is
modified by building or publishing this release.
