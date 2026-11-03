/** Read-only group directory for workspace integrations such as ERP. */
export async function listSessionGroups(
  db: D1Database,
  workspaceId: string,
  sessionId: string,
  params: URLSearchParams,
): Promise<Response> {
  const rawLimit = params.get("limit") ?? "100";
  const cursor = params.get("cursor");
  if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100 || (cursor !== null && cursor.length > 200)) {
    return Response.json({ ok: false, error: "Invalid group limit or cursor" }, { status: 400 });
  }

  const limit = Number(rawLimit);
  // groups_session_jid_idx supports the session equality + JID range/order.
  // The workspace is resolved by the authenticated session route, never the client.
  const result = await db.prepare(`
    SELECT jid AS id, COALESCE(name, jid) AS name, participant_count AS participantCount
    FROM groups
    WHERE workspace_id = ? AND wa_session_id = ? AND jid > ?
    ORDER BY jid ASC
    LIMIT ?
  `).bind(workspaceId, sessionId, cursor ?? "", limit + 1).all<{ id: string; name: string; participantCount: number }>();
  const rows = result.results;
  const data = rows.slice(0, limit);

  return Response.json({
    ok: true,
    data,
    nextCursor: rows.length > limit ? data.at(-1)?.id ?? null : null,
  }, { headers: { "Cache-Control": "no-store" } });
}
