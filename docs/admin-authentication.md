# Admin token storage

## Startup and login

On a fresh installation, set `ADMIN_TOKEN` to a long randomly generated bearer secret before starting the gateway. Use at least 32 random bytes, for example the output of `openssl rand -hex 32`. Keep the original token in a password manager. This is not a human-password login system: SHA-256 is suitable for high-entropy random tokens, not weak user-chosen passwords.

At startup the gateway:

1. Hashes the supplied `ADMIN_TOKEN` once using SHA-256.
2. Atomically replaces `DATA_DIR/admin.token.sha256` with the hexadecimal hash, using owner-only file permissions (`0600`). The data directory is private (`0700`). No plaintext admin token is written.
3. Removes a legacy `DATA_DIR/admin.token` only after the hash replacement succeeds.
4. Retains only the hash for request verification. The standalone server deletes `process.env.ADMIN_TOKEN` after successful initialization; this also prevents normal inheritance by future child processes.

Each `/api/admin/*` request still sends `Authorization: Bearer <original-token>`. The gateway hashes that candidate and compares the fixed-length binary digests using `timingSafeEqual`. Supplying the stored hash instead of the original token does not authenticate. Missing and invalid credentials return 401 as before. Member and session credentials are unchanged.

## Restart, rotation, and migration

- **Environment token present:** it is authoritative and replaces any previous hash. A blank or whitespace-only value fails startup rather than silently falling back. The token's actual bytes are hashed without trimming.
- **Environment token absent:** load the existing hash. It must contain exactly 64 lowercase hexadecimal characters (a trailing newline is allowed).
- **No hash, but a legacy `admin.token` exists:** read it using the previous whitespace-trimming behavior, persist its hash, and remove the old file. The existing login still works. Copy your original token into a password manager before upgrading; hashes are not reversible.
- **Neither credential source exists:** fail startup with instructions to set `ADMIN_TOKEN`. A new plaintext token is no longer automatically generated or printed.
- **Corrupt hash:** fail closed; explicitly setting `ADMIN_TOKEN` repairs/replaces it. A leftover legacy file never overrides an existing hash.

To rotate or recover access, set a new random `ADMIN_TOKEN` and restart/redeploy. Once startup succeeds, the old token stops authenticating. Removing the variable without restarting does not change the running process. On Railway, do not leave an old variable configured: it would restore the old token on the next deployment. A hash file requires persistent storage to survive replacement of the container.

## Railway

Set the service variable `ADMIN_TOKEN` to a random secret. For a Railway template, `${{secret(64)}}` generates a separate value for each installation. Users log in with that original value, not the file contents. The application stores only its hash in the data directory.

Railway still stores the original variable in its own configuration. If you remove it after a successful startup, future starts can use the persisted hash, **provided your `DATA_DIR` is on a working persistent volume**. Keep your own copy of the token first. If you retain the variable, Railway will inject it again on every deployment and the gateway will hash it again.

## Security boundaries

Hashing reduces exposure from accidentally reading the admin credential file; it does not make a compromised server safe. Someone able to write the data directory can replace the hash and take over the gateway. A weak token can be guessed offline from its SHA-256 digest.

Deleting a JavaScript variable or `process.env` entry does not guarantee erasure from process memory, the operating system's original environment area, crash dumps, logs created elsewhere, deployment metadata, backups, or Railway's variable store. Existing backups may still contain the old plaintext `admin.token`. Node.js strings cannot be reliably zeroized. Library callers of `createGateway({ adminToken })` must manage any copies they retain themselves; the library does not mutate their process environment.

Always use HTTPS. The raw token is sent with each authenticated request and exists in request/browser memory while used. This change does not add password sessions, rate limiting, or automatic admin-token expiry.
