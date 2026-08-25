export type InstallStatus =
  'awaiting_secret' | 'installing' | 'completed' | 'failed' | 'interrupted';

/** Error code set when a waiting install outlives its secure-action link TTL. */
export const SECURE_ACTION_EXPIRED = 'secure_action_expired';

export function isInstallPending(status: InstallStatus): boolean {
  return status === 'awaiting_secret' || status === 'installing';
}

export function isInstallRunning(status: InstallStatus): boolean {
  return status === 'installing';
}

export function isInstallSuccessful(status: InstallStatus): boolean {
  return status === 'completed';
}
