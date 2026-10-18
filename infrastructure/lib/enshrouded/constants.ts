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
