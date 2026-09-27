import {
  IconAudioFileFilled,
  IconImageFilled,
  IconVideoFileFilled,
  IconFolderZipFilled,
  IconDraftFilled,
} from "@/components/icons";
import { ComponentProps } from "solid-js";

const IconFileMap = {
  "image/": IconImageFilled,
  "video/": IconVideoFileFilled,
  "audio/": IconAudioFileFilled,
  "application/zip": IconFolderZipFilled,
};

export const IconFile = (
  props: {
    mimetype?: string;
    class?: string;
  } & ComponentProps<"svg">,
) => {
  const Icon =
    IconFileMap[
      Object.keys(IconFileMap).find((key) =>
        props.mimetype?.startsWith(key),
      ) as keyof typeof IconFileMap
    ] ?? IconDraftFilled;
  return <Icon {...props} />;
};
