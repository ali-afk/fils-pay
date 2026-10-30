# Admin login demo flow (hurl). Runs login -> OTP -> authed call in one shot.
#
# Install: Arch `pacman -S hurl`; elsewhere https://hurl.dev (also works via
# `docker run --rm -v $PWD:/work -w /work ghcr.io/orange-opensource/hurl
#   --variable base=http://localhost:3001 ... scripts/demo/admin-login.hurl`).
# Cookies are carried automatically between the requests in this file.
#
# Requirement: a dev-posture api so the login response exposes devOtpCode —
#   DATABASE_URL=... WEBHOOK_SECRET_ENCRYPTION_KEY=... NODE_ENV=development \
#   PORT=3001 SETTLEMENT_INTERNAL_TOKEN=dev-token npx tsx apps/api/src/index.ts
#
# Usage:
#   hurl --variable base=http://localhost:3001 \
#        --variable email=finance@filspay.test \
#        --variable password=FilsPayAdminSeed!2026 \
#        scripts/demo/admin-login.hurl
#   # other seeded roles: support@filspay.test, superadmin@filspay.test
#   # test mode (asserts enforced, exit code != 0 on failure): --test --verbose
#
# Credentials are the deterministic seed fixtures (db/seed/generate.ts:
# SEED_ADMIN_PASSWORD). Emails above are the three seeded admin roles.

POST {{base}}/v1/admin/auth/login
Content-Type: application/json
{
  "email": "{{email}}",
  "password": "{{password}}"
}

HTTP 200
[Captures]
otp: jsonpath "$.devOtpCode"
[Asserts]
jsonpath "$.otpRequired" == true

POST {{base}}/v1/admin/auth/otp/verify
Content-Type: application/json
{
  "code": "{{otp}}"
}

HTTP 200
[Captures]
role: jsonpath "$.role"
[Asserts]
jsonpath "$.authenticated" == true

GET {{base}}/v1/admin/merchants

HTTP 200
