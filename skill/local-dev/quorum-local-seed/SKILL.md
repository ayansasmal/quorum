---
name: quorum-local-seed
description: Re-seed LocalStack config state, knowledge data, global catalogs, or all local Quorum seed paths without a full restart.
---

# quorum-local-seed — re-seed local data without restart

Re-seeds local Quorum data paths while keeping the stack running.

## Usage
/quorum-local-seed [localstack|knowledge|catalogs|all]

- No args: same as `all`
- `localstack`: re-run LocalStack bucket/config/table bootstrap only
- `knowledge`: run `npm run seed`
- `catalogs`: run `npm run seed:catalogs`
- `all`: run all three in order

## Approval gate

State what seed paths will be re-run and get the user's go-ahead before writing any local data.

## Steps

1. First check the stack is running:
   ```bash
   npm run docker:ps
   ```
   If not running, stop and suggest `/quorum-local-start` first.
2. Run the selected seed path:
   - `localstack`: `./scripts/init-localstack.sh`
   - `knowledge`: `npm run seed`
   - `catalogs`: `npm run seed:catalogs`
   - `all`: run all three in that order
3. Verify health after seeding:
   ```bash
   curl -sf http://localhost:3001/health | jq .
   ```
4. Report which seed paths were run and whether health stayed green.

## Notes

- `./scripts/init-localstack.sh` is idempotent and safe to re-run against a running stack.
- If LocalStack is not responding, try `/quorum-local-status` to diagnose.
