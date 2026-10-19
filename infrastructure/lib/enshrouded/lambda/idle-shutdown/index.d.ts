export interface Probe {
  a2sOk: boolean;
  players: number | null;
  logOk: boolean;
  mCount: number | null;
  udpRate: number | null;
  cpuRate: number | null;
}
export const UDP_RATE_THRESHOLD: number;
export const CPU_RATE_THRESHOLD: number;
export function normalizeProbe(raw: unknown): Probe | null;
export function classify(probe: Probe | null): 'ACTIVE' | 'IDLE' | 'INDETERMINATE';
export function handler(): Promise<{ action: string; classification?: string }>;
