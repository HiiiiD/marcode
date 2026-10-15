import { useRenderer } from '@opentui/react';
import { useEffect } from 'react';
import type { SessionSummary } from '../../protocol/messages';
import { programStatus, programStatusKey } from '../view/program-status';

/** Mirrors fleet state to the terminal's own chrome (OSC 7501); unsupporting terminals ignore it. */
export function useProgramStatus(sessions: readonly SessionSummary[]): void {
  const renderer = useRenderer();
  const report = programStatus(sessions);
  const key = programStatusKey(report);
  useEffect(() => {
    try { renderer.setProgramStatus(report); } catch { /* status is cosmetic */ }
  }, [renderer, key]);
  useEffect(() => () => {
    try { renderer.setProgramStatus({ state: 'clear' }); } catch { /* renderer may already be destroyed */ }
  }, [renderer]);
}
