import {
  MkvOutputFormat,
  Mp4OutputFormat,
} from "mediabunny";

/** Keep the container stable without forcing a new audio/video encoding. */
export function recordingContainer(format: "mkv" | "mp4") {
  if (format === "mp4")
    return new Mp4OutputFormat({ fastStart: false });
  return new MkvOutputFormat();
}
