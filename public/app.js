const $ = (id) => document.getElementById(id);
let admin = "",
  catalog = [],
  catalogMembers = [],
  disabled = new Set(),
  saved = new Set(),
  page = 0,
  status = {},
  poll,
  toastTimer,
  busy = false;
const size = 40;
function notify(message, error = false) {
  $("message").textContent = message;
  $("message").classList.toggle("error", error);
  $("message").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => ($("message").hidden = true),
    error ? 12000 : 5000,
  );
}
async function api(path, { method = "GET", body, credential = admin } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${credential}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json();
  if (!res.ok)
    throw Object.assign(new Error(data.error || "Request failed"), {
      status: res.status,
    });
  return data;
}
function handle(fn) {
  return async (event) => {
    event?.preventDefault();
    try {
      await fn(event);
    } catch (e) {
      notify(e.message, true);
    }
  };
}
function tab(name) {
  document
    .querySelectorAll(".tab")
    .forEach((e) => (e.hidden = e.id !== `${name}-tab`));
  document
    .querySelectorAll(".nav")
    .forEach((e) => e.classList.toggle("active", e.dataset.tab === name));
  $("breadcrumb").textContent = {
    tools: "Tool permissions",
    members: "Members & sessions",
    settings: "Connection",
  }[name];
}
function dirty() {
  return (
    disabled.size !== saved.size || [...disabled].some((s) => !saved.has(s))
  );
}
function requireSavedPolicy() {
  if (dirty())
    throw new Error(
      "Save or discard your permission changes before syncing or changing members.",
    );
}
function memberCatalog() {
  const selected = $("catalog-member").value;
  if (!selected) return catalog;
  const kits = new Set(
    catalogMembers.find((m) => m.id === selected)?.toolkits || [],
  );
  return catalog.filter((t) => kits.has(t.toolkit));
}
function appOptions() {
  const selected = $("toolkit").value;
  $("toolkit").replaceChildren(new Option("All connected apps", ""));
  for (const kit of [...new Set(memberCatalog().map((t) => t.toolkit))].sort())
    $("toolkit").add(new Option(kit, kit));
  $("toolkit").value = [...$("toolkit").options].some(
    (o) => o.value === selected,
  )
    ? selected
    : "";
}
function filtered() {
  const q = $("search").value.toLowerCase(),
    kit = $("toolkit").value,
    filter = $("filter").value;
  return memberCatalog().filter(
    (t) =>
      (!kit || t.toolkit === kit) &&
      (!q ||
        `${t.name} ${t.slug} ${t.description}`.toLowerCase().includes(q)) &&
      (filter === "all" || (filter === "disabled") === disabled.has(t.slug)),
  );
}
function render() {
  const all = filtered();
  page = Math.max(0, Math.min(page, Math.ceil(all.length / size) - 1));
  const scoped = memberCatalog();
  $("total").textContent = scoped.length.toLocaleString();
  const n = scoped.filter((t) => disabled.has(t.slug)).length;
  $("disabled-count").textContent = n.toLocaleString();
  $("enabled-count").textContent = (scoped.length - n).toLocaleString();
  $("result-count").textContent = all.length.toLocaleString();
  $("showing").textContent =
    `${all.length.toLocaleString()} tools match your filters`;
  $("save-bar").hidden = !dirty();
  $("previous").disabled = page === 0;
  $("next").disabled = (page + 1) * size >= all.length;
  $("page-number").textContent =
    `Page ${page + 1} of ${Math.max(1, Math.ceil(all.length / size))}`;
  $("tools-list").replaceChildren();
  if (!all.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = status.scan?.running
      ? "Fetching tools for connected apps…"
      : !status.configured
        ? "Configure your Composio API key in Connection."
        : !catalogMembers.length
          ? "Add a member in Members & sessions to discover their connected apps."
          : !scoped.length
            ? "No connected-app tools at the last sync. Connect an app for this member, then Sync catalog."
            : "No tools match these filters.";
    $("tools-list").append(e);
  }
  for (const t of all.slice(page * size, (page + 1) * size)) {
    const row = document.createElement("div");
    row.className = "tool-row";
    const icon = document.createElement("div");
    icon.className = "app-icon";
    icon.textContent = t.toolkit.slice(0, 2).toUpperCase();
    const info = document.createElement("div");
    info.className = "tool-info";
    for (const [cls, text] of [
      ["tool-name", t.name],
      ["tool-slug", t.slug],
      ["tool-description", t.description],
    ]) {
      const el = document.createElement("div");
      el.className = cls;
      el.textContent = text;
      info.append(el);
    }
    const label = document.createElement("label");
    label.className = "toggle";
    const txt = document.createElement("span");
    txt.textContent = disabled.has(t.slug) ? "Disabled" : "Enabled";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !disabled.has(t.slug);
    input.disabled = busy || !!status.scan?.running;
    input.setAttribute("aria-label", `Enable ${t.slug}`);
    input.addEventListener("change", () => {
      input.checked ? disabled.delete(t.slug) : disabled.add(t.slug);
      render();
    });
    const track = document.createElement("span");
    track.className = "track";
    label.append(txt, input, track);
    row.append(icon, info, label);
    $("tools-list").append(row);
  }
}
async function loadCatalog() {
  const r = await api("/api/admin/tools");
  catalog = r.items;
  saved = new Set(status.disabled);
  disabled = new Set(saved);
  catalogMembers = r.members;
  const selected = $("catalog-member").value;
  $("catalog-member").replaceChildren(new Option("All active members", ""));
  for (const m of catalogMembers)
    $("catalog-member").add(new Option(m.name, m.id));
  $("catalog-member").value = catalogMembers.some((m) => m.id === selected)
    ? selected
    : "";
  appOptions();
  render();
}
async function refreshStatus() {
  const before = status.epoch;
  status = await api("/api/admin/status");
  const managed = status.keySource === "environment";
  $("key-form").hidden = managed;
  $("key-managed").hidden = !managed;
  $("connection").textContent = managed
    ? "Environment"
    : status.configured
      ? "Connected"
      : "Not set up";
  $("synced-at").textContent = status.syncedAt
    ? `Synced ${new Date(status.syncedAt).toLocaleString()}`
    : "Add your API key to begin";
  $("ttl").textContent = `${status.sessionTtl / 60} minutes`;
  $("refresh").disabled = !status.configured || status.scan.running;
  $("scan-status").hidden = !status.scan.running && !status.scan.error;
  $("scan-status").textContent = status.scan.running
    ? `Scanning connected apps · ${status.scan.count.toLocaleString()} tools fetched…`
    : status.scan.error || "";
  if (status.epoch !== before) await loadCatalog();
  if (status.scan.running) {
    clearTimeout(poll);
    poll = setTimeout(
      () => refreshStatus().catch((e) => notify(e.message, true)),
      1000,
    );
  } else {
    clearTimeout(poll);
  }
  render();
}
async function members() {
  const r = await api("/api/admin/members");
  $("members-list").replaceChildren();
  if (!r.items.length) {
    $("members-list").textContent =
      "No members yet. Add one to issue sessions.";
    return;
  }
  for (const m of r.items) {
    const row = document.createElement("div");
    row.className = "member-row";
    const info = document.createElement("div");
    info.textContent = m.name;
    const sub = document.createElement("small");
    sub.textContent = `${m.user_id} · ${m.active ? "Active" : "Revoked"}`;
    info.append(sub);
    row.append(info);
    for (const action of ["rotate", ...(m.active ? ["revoke"] : [])]) {
      const b = document.createElement("button");
      b.className = "secondary";
      b.textContent = action === "rotate" ? "New credential" : "Revoke";
      b.addEventListener(
        "click",
        handle(async () => {
          requireSavedPolicy();
          const r = await api(`/api/admin/members/${m.id}/${action}`, {
            method: "POST",
          });
          if (r.token) showSecret("New member credential", r.token);
          await members();
          await refreshStatus();
          await loadCatalog();
          notify(
            action === "rotate"
              ? "Credential rotated; prior sessions revoked."
              : "Member and sessions revoked.",
          );
        }),
      );
      row.append(b);
    }
    $("members-list").append(row);
  }
}
function showSecret(title, value) {
  $("credential-title").textContent = title;
  $("credential-output").textContent =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  $("credential-box").hidden = false;
}
$("login-form").addEventListener(
  "submit",
  handle(async () => {
    admin = $("admin-token").value.trim();
    await refreshStatus();
    await loadCatalog();
    await members();
    $("admin-token").value = "";
    $("login").hidden = true;
    $("workspace").hidden = false;
    tab(status.configured ? "tools" : "settings");
  }),
);
$("logout").addEventListener("click", () => {
  admin = "";
  clearTimeout(poll);
  $("workspace").hidden = true;
  $("login").hidden = false;
  $("credential-box").hidden = true;
  $("credential-output").textContent = "";
  $("member-token").value = "";
  $("api-key").value = "";
  catalog = [];
  catalogMembers = [];
  status = {};
});
for (const e of document.querySelectorAll(".nav"))
  e.addEventListener("click", () => tab(e.dataset.tab));
$("key-form").addEventListener(
  "submit",
  handle(async () => {
    await api("/api/admin/config", {
      method: "POST",
      body: { apiKey: $("api-key").value.trim() },
    });
    $("api-key").value = "";
    tab("tools");
    await refreshStatus();
    notify("Connection scan started.");
  }),
);
$("refresh").addEventListener(
  "click",
  handle(async () => {
    requireSavedPolicy();
    await api("/api/admin/refresh", { method: "POST" });
    await refreshStatus();
  }),
);
$("catalog-member").addEventListener("change", () => {
  page = 0;
  appOptions();
  render();
});
for (const id of ["search", "toolkit", "filter"])
  $(id).addEventListener(id === "search" ? "input" : "change", () => {
    page = 0;
    render();
  });
$("previous").addEventListener("click", () => {
  page--;
  render();
});
$("next").addEventListener("click", () => {
  page++;
  render();
});
$("enable-visible").addEventListener("click", () => {
  if (busy || status.scan?.running) return;
  for (const t of filtered()) disabled.delete(t.slug);
  render();
});
$("disable-visible").addEventListener("click", () => {
  if (busy || status.scan?.running) return;
  for (const t of filtered()) disabled.add(t.slug);
  render();
});
$("discard").addEventListener("click", () => {
  if (busy) return;
  disabled = new Set(saved);
  render();
});
$("save").addEventListener(
  "click",
  handle(async () => {
    if (busy || status.scan?.running) return;
    busy = true;
    $("save").disabled = true;
    const snapshot = [...disabled];
    render();
    try {
      await api("/api/admin/policy", {
        method: "PUT",
        body: { disabled: snapshot },
      });
      saved = new Set(snapshot);
      notify("Permissions saved. Existing sessions revoked.");
    } finally {
      busy = false;
      $("save").disabled = false;
      render();
    }
  }),
);
$("member-form").addEventListener(
  "submit",
  handle(async () => {
    requireSavedPolicy();
    const r = await api("/api/admin/members", {
      method: "POST",
      body: { name: $("member-name").value, userId: $("user-id").value },
    });
    showSecret("Member credential — copy before leaving", r.token);
    $("member-form").reset();
    await members();
    await refreshStatus();
    await loadCatalog();
  }),
);
$("session-form").addEventListener(
  "submit",
  handle(async () => {
    const r = await api("/api/sessions", {
      method: "POST",
      body: {},
      credential: $("member-token").value.trim(),
    }).catch(async (error) => {
      if (error.status === 409) await refreshStatus();
      throw error;
    });
    if (r.mcp.url.startsWith("/")) r.mcp.url = location.origin + r.mcp.url;
    showSecret("Session connection for Oyster", r);
    $("member-token").value = "";
  }),
);
$("copy-credential").addEventListener(
  "click",
  handle(async () => {
    await navigator.clipboard.writeText($("credential-output").textContent);
    notify("Copied.");
  }),
);
$("dismiss-credential").addEventListener("click", () => {
  $("credential-output").textContent = "";
  $("credential-box").hidden = true;
});
window.addEventListener("beforeunload", (e) => {
  if (dirty()) {
    e.preventDefault();
    e.returnValue = "";
  }
});
