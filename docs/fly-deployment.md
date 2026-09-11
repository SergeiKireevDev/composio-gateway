# Deploy to Fly.io

## Browser deployment (recommended)

[![Deploy to Fly.io](https://img.shields.io/badge/Deploy%20to-Fly.io-7B36ED?style=for-the-badge&logo=flydotio&logoColor=white)](https://fly.io/dashboard/personal/new)

This opens **Fly.io's native app launcher**, like the DigitalOcean button in Oyster opens DigitalOcean's launcher. It does not open GitHub Actions, ask you to send a Fly API token to the gateway, or require a local CLI. Fly supports launching public GitHub repositories, including repositories you do not own.

**What the button does not do:** a supported repository-prefill URL has not been verified. You must select/paste the repository yourself. Account setup, billing, resource review, and deployment confirmation also remain necessary. This is a guided provider-hosted deployment, not an instant anonymous installation.

### Launch and log in

1. Click the button, sign in to Fly.io, enable billing, and choose the organization that should own/pay for the app. The link initially targets the personal organization; change organizations if needed.
2. Choose a **public GitHub repository** and paste:

   ```text
   https://github.com/SergeiKireevDev/composio-gateway
   ```

   Until the deployment PR is merged, select `feat/fly-deployment`; afterward select `main`. If Fly's current UI does not let you select that branch, wait for the PR to merge rather than deploy the unconfigured main branch.
3. Use the repository root as the working directory and `fly.toml` as the configuration. Keep the supplied `Dockerfile.fly`; do not replace it with an auto-generated Dockerfile.
4. Review the plan before approving billable resources:
   - **One machine**, shared CPU, 512 MB RAM. Disable any high-availability/second-machine option.
   - **One persistent volume**, named `gateway_data`, mounted at `/data`, initially 1 GB, in the same region as the machine.
   - Internal HTTP port **8788**, HTTPS enabled, `/health` health check.
   - No Postgres, Redis, or other database add-on: the gateway uses SQLite on its volume.

   The repository config requests these settings, but verify the launcher preserves them. Do not deploy without the volume or with multiple machines. If the UI cannot represent this configuration, use the optional workflow below instead.
5. Deploy. After the app exists, use its Fly dashboard **Secrets** page to add `ADMIN_TOKEN` with a long, randomly generated value from your password manager (at least 32 random bytes / about 43 base64url characters). Save the value in your password manager. Use **Deploy Secrets** to apply it. If the launch form offers secrets, you can set it there instead. Until this is set, a random token on the private volume protects the app; there is no unauthenticated first-user claim screen.
6. Open `https://YOUR_APP.fly.dev` and log in with that `ADMIN_TOKEN`. Configure your Composio key and members in the gateway UI.

No `FLY_API_TOKEN` GitHub secret is needed for this path. The app automatically derives its public URL from Fly's `FLY_APP_NAME`; an explicit `PUBLIC_URL` overrides it for custom domains. It does not trust client-supplied Host headers.

The existing random bearer-token authentication is unchanged. `ADMIN_TOKEN` is a Fly-managed secret, but the application receives its plaintext value at runtime; **this is not hashed-at-rest password authentication**. Never put admin or Fly tokens in repository files, URL parameters, workflow inputs, or logs.

### Updates

Use Fly's app deployment UI to redeploy the connected repository after reviewing changes. Keep the same app, region, and volume. If Fly offers a PR containing app-specific launch configuration, put that configuration in your own fork, not the shared upstream template. Use your own fork for custom changes or independent release control.

## Optional: GitHub Actions deployment

This is an alternative for maintainers who prefer GitHub-driven provisioning. It is **not** what the README button opens.

1. Fork the repository or use a repository where you can configure Actions environments/secrets.
2. Install [flyctl](https://fly.io/docs/flyctl/install/), run `fly auth login`, and find your organization with `fly orgs list`.
3. Create an organization-scoped token using `fly tokens create org --org YOUR_ORG` with a suitable expiry. Provisioning apps, volumes, and IPs requires broader permissions than an app-only deploy token. Treat it as a powerful secret.
4. In GitHub **Settings → Environments**, create `fly-production` and add `FLY_API_TOKEN` as an environment secret. Consider deployment approvals and a default-branch restriction.
5. Open **Actions → Deploy to Fly.io → Run workflow**, enter a unique app name, organization slug, and region. The workflow appears once merged to the default branch.
6. Set `ADMIN_TOKEN` through Fly's Secrets UI as above, or privately retrieve the generated token from your own terminal:

   ```sh
   fly ssh console --app YOUR_APP --command 'cat /data/admin.token'
   ```

   Never run that command in Actions: it would expose the token in logs. Keep the file; it supplies the token on restarts when `ADMIN_TOKEN` is absent.

Rerun with identical inputs for updates. The script reuses existing resources and rejects ambiguous or wrong-region volumes. Only target a new app or one previously created by this workflow, not an unrelated existing app.

## Storage, costs, and removal

The gateway uses **one machine and one volume** for SQLite, encryption keys, and admin credentials. Do not horizontally scale it: separate volumes have separate state. Immediate deployments can cause brief downtime. Automatic stopping is disabled, so compute runs continuously. Volumes and other resources may also incur charges; review [Fly pricing](https://fly.io/docs/about/pricing/) before deploying.

The Fly-specific entrypoint sets the mounted directory's permissions as root, then runs Node as the unprivileged `node` user. The original Dockerfile remains unchanged.

Back up the **entire `/data` directory**, including `encryption.key`. For consistent backups, stop writes or use SQLite's backup mechanism. Volume snapshots do not replace independently tested backups. Never change the encryption key on an existing database.

- Inspect health and logs in the Fly dashboard, or run `fly status --app YOUR_APP` and `fly logs --app YOUR_APP`.
- Failed launches can leave billable resources. Inspect existing apps, volumes, and IPs before retrying or deleting anything.
- If multiple `gateway_data` volumes exist, identify the live database before removing unused volumes.
- To remove the deployment, destroy the app in Fly's dashboard or use `fly apps destroy YOUR_APP`. This destroys data: export backups first. Verify remaining resources and revoke unused tokens.

## Verification scope

The Docker image and local persistent-volume restart path have been tested. Native Fly account login, plan customization, billing, and a live deployment require your authenticated account and have not been exercised here. UI wording may change. The button uses the provider's published launcher URL without speculative query parameters.

References: [Fly's browser launcher announcement](https://community.fly.io/t/we-are-building-a-github-launch-ui-in-public/21159), [current launcher and public repository support](https://community.fly.io/t/launch-your-app-from-the-dashboard-better-ui-heck-yeah/26838), [dashboard secrets deployment](https://community.fly.io/t/26286), [Fly configuration](https://fly.io/docs/reference/configuration/), [runtime environment](https://fly.io/docs/machines/runtime-environment/), [API tokens](https://fly.io/docs/security/tokens/).
