# Durable Reading Progress

The `aloud-ios-fork` plugin stores up to 100 article-selection checkpoints in
`<vault>/.obsidian/plugins/aloud-ios-fork/reading-progress.a.json` and `reading-progress.b.json`.
These alternating snapshots protect against an interrupted write. Settings and
API keys remain in their separate Obsidian plugin data file.

A checkpoint contains the note path, selection boundaries, compact text hash,
chunk index, and sentence-anchor hash; it does not contain article text or credentials.
Progress is saved when the spoken chunk changes, on a pause, every three seconds
(when the position changes), and when iOS hides the app. On resume the checkpoint
is intentionally one chunk behind the last observed position, but never behind
the current session's initial resume boundary unless Previous explicitly moves
backward. Repeated resume/pause cycles therefore do not drift backward.
Replaying a short sentence is safer than skipping unspoken text.

To resume, either replay the identical selection or use the Command Palette's
**Aloud (iOS Fork): Resume last reading (saved progress)**. If the source note has
changed, the explicit command declines to resume rather than silently jumping.

No plugin can guarantee timer execution after iOS suspends its WebView or
autoplay audio after process termination. This release makes the last persisted
position recoverable when the user returns or starts playback again.
