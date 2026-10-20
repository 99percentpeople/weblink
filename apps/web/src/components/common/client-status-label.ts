import { t } from "@/i18n";
import type { ClientInfo } from "@/libs/state/app-state";

export function clientStatusLabel(
  client: ClientInfo | undefined,
): string {
  if (!client) return t("common.status.leave");
  if (client.onlineStatus !== "online")
    return t(`common.status.${client.onlineStatus}`);
  if (!client.messageChannel)
    return t("common.status.connecting");
  if (client.trust && client.trust !== "trusted")
    return t(`device_trust.${client.trust}`);
  return t("common.status.online");
}
