import { useEffect, useState } from 'react';
import { recordingState } from '@/lib/storage';
import { IDLE_RECORDING_STATE, type RecordingState } from '@/lib/recording/types';

/**
 * Live recording state, reactive across contexts. Reads from storage.session and
 * watches for changes so popup/side panel stay in sync while recording runs.
 */
export function useRecordingState(): RecordingState {
  const [state, setState] = useState<RecordingState>(IDLE_RECORDING_STATE);

  useEffect(() => {
    let active = true;
    recordingState.getValue().then((v) => active && setState(v));
    const unwatch = recordingState.watch((v) => setState(v ?? IDLE_RECORDING_STATE));
    return () => {
      active = false;
      unwatch();
    };
  }, []);

  return state;
}
