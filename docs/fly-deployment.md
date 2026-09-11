# Deploy to Fly.io

This repository offers a **Run workflow** deployment, not a zero-setup anonymous deploy button. You need a Fly.io account with billing enabled, a GitHub account, and a Fly API token. Running the workflow provisions billable resources; no Fly deployment is performed by opening or merging the PR.

## First deployment

1. Fork this repository (or use it directly if you have Actions and secrets permissions).
2. Install [flyctl](https://fly.io/docs/flyctl/install/), sign in with `fly auth login`, and find your organization slug using `fly orgs list`. Create an organization-scoped token with `fly tokens create org --org YOUR_ORG`. This workflow creates apps, volumes, and IPs, so an app-only deploy token is insufficient for first-time provisioning. Treat the token as a powerful secret and set a suitable expiry.
3. In GitHub **Settings → Environments**, create `fly-production`. Add an environment secret named `FLY_API_TOKEN`. Consider requiring deployment approval and restricting deployments to the default branch. Never put this token in a workflow input, repository file, or issue.
4. Open **Actions → Deploy to Fly.io → Run workflow**. Enter a globally unique app name, your organization slug, and a region (default `ams`). The workflow must be on the default branch to appear in Actions.
5. Visit `https://YOUR_APP.fly.dev` after the workflow succeeds. Fly supplies HTTPS. The workflow summary also links to the app.
6. Retrieve the generated admin token **privately from your own terminal**:

   ```sh
   fly ssh console --app YOUR_APP --command 'cat /data/admin.token'
   ```

   Paste it into the gateway login. Do not run that command in GitHub Actions: it would expose the token in logs. Keep `/data/admin.token`; it is needed on restarts. Configure Composio and members in the UI.

The admin token is a random bearer secret, stored on the private volume with owner-only permissions. This deployment does **not** introduce password login or hashed-at-rest admin credentials. It deliberately has no password workflow input. If password authentication is required, that is a separate authentication change.

## Updates and storage

Run the workflow again with the **same app, organization, and region**. It reuses the `gateway_data` volume and existing public IPs. Changing the app name creates a separate deployment. Changing regions is rejected when the existing volume is in another region.

The app uses exactly one machine and one 1 GB volume for SQLite, encryption keys, and admin credentials. Do not horizontally scale it: separate volumes would have different databases and keys. Deployments use an immediate replacement strategy, so brief downtime is expected. Automatic stopping is disabled; the machine incurs continuous compute charges. Fly volumes and any other billable resources also incur charges. See [Fly pricing](https://fly.io/docs/about/pricing/).

The Fly-specific entrypoint sets the mounted directory's permissions as root, then starts Node as the unprivileged `node` user. The original Dockerfile remains unchanged.

Back up the **entire `/data` directory**, including `encryption.key`; SQLite alone is insufficient. For consistent backups, stop application writes or use SQLite's backup mechanism. Fly volume snapshots are useful but are not a substitute for an independently tested backup/restore process. Do not change the encryption key on an existing database.

## Troubleshooting and removal

- Inspect `fly status --app YOUR_APP` and `fly logs --app YOUR_APP`; `/health` is the HTTP health check.
- An interrupted first deployment can leave an app, volume, or IP allocated. Rerun using the same inputs; inspect existing resources before deleting anything.
- If multiple `gateway_data` volumes exist, the workflow refuses to choose between them. Identify the volume holding the live database before removing unused resources.
- Only target a new app or an app previously created by this workflow, not an unrelated existing application.
- To remove the deployment, run `fly apps destroy YOUR_APP` and confirm deliberately. This destroys the app and its data; export backups first. Verify remaining resources in the Fly dashboard and revoke the API token when no longer needed.

References: [Fly GitHub Actions deployments](https://fly.io/docs/launch/continuous-deployment-with-github-actions/), [volumes](https://fly.io/docs/volumes/overview/), [API tokens](https://fly.io/docs/security/tokens/).
