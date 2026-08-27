import { recallService } from "./service";

/** Public Recall surface for consuming projects. */
export const ExuluRecall = {
  /**
   * Fresh signed URL for a recording's mixed MP4, or null. Resolve at point
   * of use — the URL expires after six hours.
   */
  getRecordingVideoUrl: (recordingId: string): Promise<string | null> =>
    recallService.getRecordingVideoUrl(recordingId),
};
