# J23 - Self-Serve Onboarding

## Goal

Allow a GitHub-authenticated engineer with no existing Quorum membership to
create the first project without an administrator invitation, while preserving
namespace ownership and public-project write boundaries.

## Scenarios

### S-23.1 Cold-Start Onboarding

1. Exchange a valid GitHub token without `project_id`.
2. Receive a slim JWT with `project: null` and `member_found: false`.
3. Upload a net-new config where the JWT subject is a listed
   `principal_architect`.
4. Read the newly synchronized config through project-scoped authentication.
5. Repeat the bootstrap upload and receive `409 already_onboarded`.

### S-23.2 Public Project Boundary

1. Use a valid JWT for an identity outside the public project membership.
2. Read project knowledge successfully.
3. Attempt a knowledge write and receive `403 not_a_member`.

### S-23.3 Dashboard Welcome

1. Inject a valid authenticated session with no active project and no
   memberships.
2. Open the dashboard root.
3. See the projectless welcome state and `quorum config_upload` guidance.
4. Confirm the browser is not redirected to `/login`.

## Implementation

- API: `tests/e2e/scenarios/23-self-serve-onboarding.spec.js`
- Browser: `quorum-dash/tests/e2e/scenarios/23-self-serve-onboarding.spec.js`
- Unit coverage: auth issuance, admin seed, membership guard, final-admin guard,
  and config namespace rejection.

## Verification Status

The scenarios compile and are discoverable by Playwright. Live Docker and
browser execution was blocked on June 13, 2026 by the local command-approval
service usage limit; do not treat S-23 as runtime-green until those commands run.
