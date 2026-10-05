// Raven — opencode plugin entry. Loaded by opencode (global plugins dir);
// joins the raven spool as the "oc" instance and forwards every interesting
// event to the bridge core (the leader polls Telegram and renders the UI).
import { startOpencodePlugin } from "./opencode.js"

const INTERESTING = new Set([
  "permission.asked",
  "permission.replied",
  "permission.v2.asked",
  "permission.v2.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
  "question.v2.asked",
  "question.v2.replied",
  "question.v2.rejected",
  "session.status",
  "session.idle",
  "session.error",
  "message.part.updated",
  "session.created",
  "session.updated",
  "session.deleted",
])

export default {
  id: "raven",
  server: async (input: any, _options?: any) => {
    const handle = await startOpencodePlugin(input)
    return {
      event: async ({ event }: { event: { type: string; properties: any } }) => {
        try {
          if (!event?.type || !INTERESTING.has(event.type)) return
          await handle.feedEvent({ type: event.type, properties: event.properties ?? {} })
        } catch {}
      },
      dispose: async () => {
        await handle.dispose()
      },
    }
  },
}
