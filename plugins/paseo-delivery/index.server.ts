import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runnerControl, workspaceCommand, workspaceSetup, workspaceStatus } from "./server/backend";
import { runnerControlRpc, workspaceCommandRpc, workspaceSetupRpc, workspaceStatusRpc } from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  server.handle(workspaceStatusRpc, workspaceStatus);
  server.handle(workspaceSetupRpc, workspaceSetup);
  server.handle(runnerControlRpc, runnerControl);
  server.handle(workspaceCommandRpc, workspaceCommand);
  return () => {};
}
