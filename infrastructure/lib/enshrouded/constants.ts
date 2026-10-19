/**
 * Single source of truth for where the Enshrouded server lives (ARCHITECTURE §6.3.1).
 *
 * EBS volumes are AZ-bound: the retained world volume (WP-04) can only attach to an
 * instance in the same AZ. Both the instance (server.ts) and the volume (world-storage.ts)
 * import these constants, so they cannot diverge. Changing the AZ is a deliberate edit
 * and MUST be accompanied by a volume migration (snapshot -> restore into the new AZ).
 */
export const ENSHROUDED_AZ = 'us-east-2a';

/** Default-VPC public subnet in ENSHROUDED_AZ. */
export const ENSHROUDED_SUBNET_ID = 'subnet-0362ac5390834c32e';

/**
 * GitHub OIDC subject claims (ARCHITECTURE §6.2).
 *
 * GitHub issues subjects with IMMUTABLE NUMERIC IDS embedded:
 *   repo:<owner>@<owner_id>/<repo>@<repo_id>:<context>
 * not the `repo:<owner>/<repo>:<context>` form the AWS docs and virtually every
 * guide still show. Confirmed from CloudTrail on a real failed
 * AssumeRoleWithWebIdentity from this repo:
 *   repo:pinkcognito@7524041/enshroudedproj@1424007989:pull_request
 * A trust policy written only against the documented form fails with the
 * unhelpful "Not authorized to perform sts:AssumeRoleWithWebIdentity".
 *
 * EVERY role assumed by GitHub Actions must use this helper. It exists because
 * two stacks previously built this string independently; the ID fix landed in
 * one and the other silently kept failing.
 */
export const GITHUB_REPO_BY_NAME = 'pinkcognito/enshroudedproj';
export const GITHUB_REPO_BY_ID = 'pinkcognito@7524041/enshroudedproj@1424007989';

/** Both accepted subject spellings for a GitHub context, as a StringLike list (an OR). */
export const githubOidcSubs = (context: string): string[] => [
  `repo:${GITHUB_REPO_BY_ID}:${context}`,
  `repo:${GITHUB_REPO_BY_NAME}:${context}`,
];
