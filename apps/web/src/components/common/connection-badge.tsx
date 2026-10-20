import { Component } from "solid-js";
import type { ClientInfo } from "@/libs/state/app-state";
import { Badge } from "@/components/ui/badge";
import { clientStatusLabel } from "./client-status-label";

export const ConnectionBadge: Component<{
  client?: ClientInfo;
}> = (props) => {
  return (
    <Badge class="text-xs" variant="secondary">
      <span>{clientStatusLabel(props.client)}</span>
    </Badge>
  );
};
