#!/usr/bin/env bash
set -euo pipefail
: "${FLY_API_TOKEN:?Set the FLY_API_TOKEN GitHub environment secret}"
: "${FLY_APP:?Missing app name}"
: "${FLY_REGION:?Missing region}"
: "${FLY_ORG:?Missing organization}"
[[ "$FLY_APP" =~ ^[a-z][a-z0-9-]{2,62}$ ]] || { echo 'Invalid app name'; exit 1; }
[[ "$FLY_REGION" =~ ^[a-z]{3}$ ]] || { echo 'Invalid region'; exit 1; }
[[ "$FLY_ORG" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo 'Invalid organization'; exit 1; }

# Only create when the account's app listing confirms it is absent. An API
# failure must not be mistaken for a missing app.
apps=$(flyctl apps list --org "$FLY_ORG" --json)
exists=$(python3 -c 'import json,sys; print(int(any(a["Name"] == sys.argv[1] for a in json.load(sys.stdin))))' "$FLY_APP" <<< "$apps")
if [[ "$exists" == 0 ]]; then
  flyctl apps create "$FLY_APP" --org "$FLY_ORG"
fi
volumes=$(flyctl volumes list --app "$FLY_APP" --json)
count=$(python3 -c 'import json,sys; print(sum(v["name"] == "gateway_data" for v in json.load(sys.stdin)))' <<< "$volumes")
regional=$(python3 -c 'import json,sys; print(int(any(v["name"] == "gateway_data" and v["region"] == sys.argv[1] for v in json.load(sys.stdin))))' "$FLY_REGION" <<< "$volumes")
if [[ "$count" == 0 ]]; then
  flyctl volumes create gateway_data --app "$FLY_APP" --region "$FLY_REGION" --size 1 --yes
elif [[ "$count" != 1 || "$regional" != 1 ]]; then
  echo 'Expected exactly one gateway_data volume in the requested region. Refusing deployment.'
  exit 1
fi
# Allocate only missing public addresses; Fly terminates HTTPS on these.
ips=$(flyctl ips list --app "$FLY_APP" --json)
v6=$(python3 -c 'import json,sys; print(int(any(v["Type"] == "v6" for v in json.load(sys.stdin))))' <<< "$ips")
v4=$(python3 -c 'import json,sys; print(int(any(v["Type"] in ("shared_v4", "v4") for v in json.load(sys.stdin))))' <<< "$ips")
if [[ "$v6" == 0 ]]; then
  flyctl ips allocate-v6 --app "$FLY_APP"
fi
if [[ "$v4" == 0 ]]; then
  flyctl ips allocate-v4 --shared --app "$FLY_APP"
fi
# SQLite, encryption keys, sessions, and policy are local to one volume.
# Never create a standby machine with an independent database.
flyctl deploy --app "$FLY_APP" --primary-region "$FLY_REGION" \
  --config fly.toml --remote-only --ha=false --strategy immediate \
  --env "PUBLIC_URL=https://${FLY_APP}.fly.dev"
printf 'Deployed: https://%s.fly.dev\n' "$FLY_APP"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf 'Gateway: https://%s.fly.dev\n\nRetrieve the admin token privately with Fly SSH; see docs/fly-deployment.md.\n' "$FLY_APP" >> "$GITHUB_STEP_SUMMARY"
fi
