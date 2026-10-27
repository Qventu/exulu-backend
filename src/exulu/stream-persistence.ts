import { consumeStream } from "ai";

/**
 * Keeps a chat turn's persistence alive when the viewer leaves mid-answer.
 *
 * `onFinish` — where saveChat runs — is reached only from the terminal
 * flush/cancel of the UI-message stream, and it is the HTTP response writer
 * that pulls that stream. A client that goes away mid-turn (tab closed,
 * reload, dropped connection) leaves the writer stalled forever on
 * `response.once("drain")`, so the flush never happens and NOTHING of the turn
 * is written — the user's own message included, which is why such a session
 * reloads empty rather than merely answerless.
 *
 * Draining a server-side `tee()` branch of the same stream pulls the source to
 * completion no matter what the client does, so onFinish always runs, with the
 * whole answer rather than the part that made it onto the wire.
 *
 * `result.consumeStream()` cannot stand in for this: it drains a DIFFERENT tee
 * branch (the raw `fullStream`), which keeps generation — and billing — going
 * but never touches the branch onFinish sits on.
 */
export const persistThroughDisconnect = () => ({
    consumeSseStream: ({ stream }: { stream: ReadableStream<string> }) => {
        // Not awaited: this drains alongside the response writer for the whole
        // turn. Errors are the onError handler's business, never this drain's.
        void consumeStream({ stream });
    },
});
