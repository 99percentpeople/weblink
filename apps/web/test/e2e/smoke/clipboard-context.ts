import type { AppStateContextProps } from "@/libs/state/app-state-context";
const unexpected = async (): Promise<never> => {
  throw new Error(
    "Unexpected clipboard operation in fixture",
  );
};
export const clipboardFixture: AppStateContextProps["remoteClipboard"] =
  {
    copy: unexpected,
    paste: unexpected,
    watch: () => () => {},
  };
