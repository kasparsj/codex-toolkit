import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DeliveryWorkspacePanel } from "./client/dashboard";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addWorkspacePanel({ id: "delivery", title: "Delivery", icon: "GitPullRequestCreate", locations: ["workspace"], Component: DeliveryWorkspacePanel }),
    client.addSlashCommand({
      name: "delivery",
      description: "Open delivery for this repository",
      argumentHint: "",
      context: "workspace",
      onSubmit({ openPanel }) { openPanel("delivery"); },
    }),
  ];
  return () => { for (const cleanup of cleanups.reverse()) cleanup(); };
}
