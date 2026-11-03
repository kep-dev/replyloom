import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { listSessionGroups } from "../session-groups";

function fixture() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`
    CREATE TABLE groups (workspace_id TEXT, wa_session_id TEXT, jid TEXT, name TEXT, participant_count INTEGER);
    CREATE UNIQUE INDEX groups_session_jid_idx ON groups (wa_session_id, jid);
    INSERT INTO groups VALUES ('w1', 's1', '100@g.us', 'First', 2),
      ('w1', 's1', '200@g.us', 'Second', 3), ('w1', 's1', '300@g.us', NULL, 4),
      ('w2', 's2', '150@g.us', 'Other workspace', 5), ('w1', 's3', '250@g.us', 'Other session', 6);
  `);
  const db = {
    prepare(query: string) {
      return {
        bind(...params: Array<string | number>) {
          return { async all() { return { results: raw.prepare(query).all(...params) }; } };
        },
      };
    },
  } as unknown as D1Database;
  return { raw, db };
}

describe("integration session groups", () => {
  it("paginates in JID order and isolates both workspace and session", async () => {
    const { raw, db } = fixture();
    try {
      const firstResponse = await listSessionGroups(db, "w1", "s1", new URLSearchParams("limit=2"));
      expect(firstResponse.headers.get("cache-control")).toBe("no-store");
      const first = await firstResponse.json<{ data: Array<{ id: string }>; nextCursor: string }>();
      expect(first.data.map(g => g.id)).toEqual(["100@g.us", "200@g.us"]);
      expect(first.nextCursor).toBe("200@g.us");
      const secondResponse = await listSessionGroups(db, "w1", "s1", new URLSearchParams({ limit: "2", cursor: first.nextCursor }));
      expect(await secondResponse.json()).toEqual({ ok: true, data: [{ id: "300@g.us", name: "300@g.us", participantCount: 4 }], nextCursor: null });
      const mismatch = await listSessionGroups(db, "w2", "s1", new URLSearchParams());
      expect(await mismatch.json()).toEqual({ ok: true, data: [], nextCursor: null });
    } finally {
      raw.close();
    }
  });

  it.each(["limit=0", "limit=101", "limit=no", `cursor=${"x".repeat(201)}`])("rejects invalid pagination: %s", async query => {
    const { raw, db } = fixture();
    try {
      expect((await listSessionGroups(db, "w1", "s1", new URLSearchParams(query))).status).toBe(400);
    } finally {
      raw.close();
    }
  });
});
