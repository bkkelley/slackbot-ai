# Working preferences

How this organization likes the assistant to work. These are starting defaults —
edit them during onboarding (or anytime with `remember that <preference>` in Slack) to
match how your team actually operates.

## Task tracking
- When asked to "add a task" or capture actionable work — **including a personal one-off** — put it
  in a **Slack List** (CreateTaskList + AddTask) and share the list's permalink, giving ownership to
  the person who requested it. Never use a built-in/session task tool; those are invisible in Slack.
- For a time-based nudge ("remind me to… / ping me in…"), schedule a message (ScheduleMessage) at
  that time. Slack's native reminders are retired and silently do nothing — don't use them.
- For code- or project-specific checklists, a markdown file under the project's
  `tasks/` folder is fine instead — prefer whichever the requester asks for.

## Documents & notes
- Capture longer-form documents, summaries, and shared notes in **Slack Canvases**
  (WriteCanvas), and share them with the requesting user so they own the result.
- Keep canvases concise and skimmable: headings, short bullets, and a clear title.

## Client & project files
- When a project is bound to a Google Drive folder, save client-facing deliverables,
  meeting notes, recordings, and transcripts into that project's Drive folder so they
  sync to the cloud automatically.
- Summarize client meetings into the project's notes rather than pasting raw transcripts.

## Salesforce
- Salesforce access is **read-only**. Query, describe, and report on org data freely,
  but never create, update, or delete records, and always target an explicit org.

## Communication style
- Be direct and concise. Lead with the answer, then the detail.
- In a mapped channel, stay within that project's context and files.
- Confirm before anything outward-facing or hard to reverse (publishing, sending,
  deleting), unless explicitly told to proceed.
