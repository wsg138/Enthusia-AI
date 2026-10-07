export const MAX_VIDEO_DURATION_SECONDS = 120;
export const MAX_VIDEO_FRAMES = 3;
export const MAX_VIDEO_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_VIDEO_PIXELS = 2560 * 1440;
export const MAX_VIDEO_DIMENSION = 4096;
export const MAX_VIDEO_PROCESSING_MS = 30_000;

export class TicketVideoProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TicketVideoProcessingError';
  }
}
