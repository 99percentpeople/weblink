import { Button } from "@/components/ui/button";
import { createDialog } from "../dialogs/dialog";

export const createComfirmDialog = () => {
  const { open, close, submit, Component } = createDialog({
    title: "Delete Clients",
    description:
      "This operation will delete the client and messages",
    content: () =>
      "Are you really sure you want to delete this client",

    confirm: (
      <Button
        variant="destructive"
        onClick={() => submit(true)}
      >
        Confirm
      </Button>
    ),
    cancel: <Button onClick={() => close()}>Cancel</Button>,
  });

  return { open, Component };
};
