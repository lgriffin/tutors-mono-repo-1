import { describe, it, expect, beforeEach } from "vitest";
import { GistCreatedEventSchema } from "../support/schemas";
import { validateAgainstSchema } from "../support/validators";
import { publishNotice, noticeTopic, noticeEvent, isCourseNotice, type HubMessage, type RealtimeHub } from "@tutors/realtime-valkey";
import { snippetSharedNotice } from "../../../packages/application/src/index.ts";

/**
 * Protocol contract for the `gist-created` real-time event (issue #155:
 * student -> lecturer shared snippet notification). Mirrors the #78
 * `broadcast-protocol.contract.test.ts` convention.
 *
 * These tests lock the on-the-wire shape of the ping (published by the
 * reader's server after `shareSnippet`, streamed to the time app's
 * `SnippetListener`) so the two never drift out of sync.
 *
 * The payload is captured from `publishNotice` through a recording Valkey hub
 * rather than hand-written here: asserting on what the publisher actually
 * emits is what makes this a contract test rather than a test of its own
 * fixture. The server only publishes: it subscribes to nothing.
 */

const COURSE = "cs101-2025";

interface Sent {
  topic: string;
  event: string;
  payload: unknown;
}

/** Records what the publisher publishes, and refuses to subscribe. */
function recordingHub(sink: Sent[]): RealtimeHub {
  return {
    kind: "memory",
    async publish(topic: string, message: HubMessage) {
      sink.push({ topic, event: message.event, payload: message.payload });
    },
    subscribe() {
      throw new Error("the server must never subscribe to a topic it publishes");
    },
    subscribed: () => [],
    close: async () => {}
  };
}

let sent: Sent[];
let hub: RealtimeHub;
let n = 0;
const ping = (courseId = COURSE) => snippetSharedNotice(courseId, `ping-${++n}`, Date.now());

beforeEach(() => {
  sent = [];
  hub = recordingHub(sent);
});

describe("gist-created broadcast protocol", () => {
  it("emits a payload matching the schema on the course's snippets topic", async () => {
    expect(await publishNotice(hub, ping())).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].topic).toBe(`snippets:${COURSE}`);
    expect(sent[0].topic).toBe(noticeTopic(COURSE, "gist-created"));
    expect(sent[0].event).toBe("gist-created");
    expect(sent[0].event).toBe(noticeEvent("gist-created"));

    const result = validateAgainstSchema(sent[0].payload, GistCreatedEventSchema);
    expect(result.errors).toHaveLength(0);
    expect(result.valid).toBe(true);
  });

  it("emits exactly the four contracted fields and nothing else", async () => {
    await publishNotice(hub, ping());
    // Guards the privacy property directly: any browser on the course may
    // stream the snippets topic, so the field list is a security boundary,
    // not a style choice.
    expect(Object.keys(sent[0].payload as object).sort()).toEqual(["courseId", "id", "sentAt", "type"]);
  });

  it("carries no identifying or authored data", async () => {
    await publishNotice(hub, ping());
    const payload = sent[0].payload as Record<string, unknown>;
    for (const leaky of ["gistId", "gistUrl", "student_id", "student_name", "title", "lo_route", "lo_title", "content", "filename"]) {
      expect(payload, `payload must not carry ${leaky}`).not.toHaveProperty(leaky);
    }
  });

  it("rejects a payload that re-adds an identifying field", async () => {
    await publishNotice(hub, ping());
    const leaked = { ...(sent[0].payload as object), student_id: "octocat" };
    expect(validateAgainstSchema(leaked, GistCreatedEventSchema).valid).toBe(false);
  });

  it("stamps a unique id and a numeric sentAt on every send", async () => {
    await publishNotice(hub, ping());
    await publishNotice(hub, ping());
    const [a, b] = sent.map((s) => s.payload as { id: string; sentAt: number });
    expect(a.id).not.toBe(b.id);
    expect(typeof a.sentAt).toBe("number");
    expect(a.sentAt).toBeGreaterThan(0);
  });

  it("returns false and emits nothing when the server has no realtime hub (anonymous mode)", async () => {
    expect(await publishNotice(null, ping())).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("returns false for a missing courseId", async () => {
    expect(await publishNotice(hub, ping(""))).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("rejects a wrong or missing type discriminator", async () => {
    await publishNotice(hub, ping());
    const valid = sent[0].payload as Record<string, unknown>;
    expect(validateAgainstSchema({ ...valid, type: "course:broadcast" }, GistCreatedEventSchema).valid).toBe(false);
    const noType = { ...valid };
    delete noType.type;
    expect(validateAgainstSchema(noType, GistCreatedEventSchema).valid).toBe(false);
  });

  it("requires a non-empty id and courseId", async () => {
    await publishNotice(hub, ping());
    const valid = sent[0].payload as Record<string, unknown>;
    expect(validateAgainstSchema({ ...valid, id: "" }, GistCreatedEventSchema).valid).toBe(false);
    expect(validateAgainstSchema({ ...valid, courseId: "" }, GistCreatedEventSchema).valid).toBe(false);
  });

  it("requires sentAt to be a number (ms)", async () => {
    await publishNotice(hub, ping());
    const valid = sent[0].payload as Record<string, unknown>;
    expect(validateAgainstSchema({ ...valid, sentAt: "now" }, GistCreatedEventSchema).valid).toBe(false);
    const noSentAt = { ...valid };
    delete noSentAt.sentAt;
    expect(validateAgainstSchema(noSentAt, GistCreatedEventSchema).valid).toBe(false);
  });
});

describe("gist-created receiving guard", () => {
  it("accepts what the publisher emits, for the course it names", async () => {
    await publishNotice(hub, ping());
    expect(isCourseNotice(sent[0].payload, COURSE, "gist-created")).toBe(true);
  });

  it("rejects an event addressed to a different course, a wrong type, or junk", async () => {
    await publishNotice(hub, ping());
    const valid = sent[0].payload as Record<string, unknown>;
    expect(isCourseNotice({ ...valid, courseId: "other-course" }, COURSE, "gist-created")).toBe(false);
    expect(isCourseNotice({ ...valid, type: "course:broadcast" }, COURSE, "gist-created")).toBe(false);
    expect(isCourseNotice(null, COURSE, "gist-created")).toBe(false);
    expect(isCourseNotice({ ...valid, id: "" }, COURSE, "gist-created")).toBe(false);
  });
});
