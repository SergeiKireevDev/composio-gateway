// Existing execution/transport tests must explicitly perform admin approval.
// Approval security itself is tested against the raw endpoints in approvals.test.mjs.
export async function issueSession(req, credential, tools) {
  const pending = await req("/api/sessions", "POST", { tools }, credential);
  if (pending.status !== 202) return pending;
  const approved = await req(
    `/api/admin/session-requests/${pending.data.request_id}/approve`,
    "POST",
  );
  if (approved.status !== 200) return approved;
  return req(
    "/api/sessions",
    "POST",
    { request_id: pending.data.request_id },
    credential,
  );
}
