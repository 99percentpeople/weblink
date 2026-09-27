import { createDialog } from "@/components/dialogs/dialog";
import { t } from "@/i18n";
import {
  Accessor,
  createEffect,
  createSignal,
} from "solid-js";

export type CompressProgress = {
  total: number;
  current: number;
  path: string;
};

export const createChatFolderCompressDialog = () => {
  const [progress, setProgress] =
    createSignal<CompressProgress>();

  const {
    open: openDialog,
    close,
  } = createDialog({
    title: () => t("client.chat.compress_folder"),
    description: () => {
      const p = progress();
      if (!p) return "";
      return `${p.current}/${p.total} ${p.path}`;
    },
    content: () => <div>{progress()?.path}</div>,
  });

  const open = (
    progress: Accessor<CompressProgress | null>,
  ) => {
    createEffect(() => {
      const p = progress();
      if (p) {
        setProgress(p);
      } else {
        close();
      }
    });
    openDialog();
  };

  return {
    open: open,
  };
};
