export type BuiltinIntegrationId =
  | "soil-display"
  | "mcp-bridge"
  | "foreign-plugin-bridge"
  | "interactive-automation";

export type BuiltinIntegrationKind = "display" | "bridge" | "automation";

export type BuiltinIntegrationStatus = "available" | "disabled";

export interface BuiltinIntegrationDescriptor {
  id: BuiltinIntegrationId;
  kind: BuiltinIntegrationKind;
  title: string;
  description: string;
  source: "builtin";
  status: BuiltinIntegrationStatus;
  capabilities: string[];
}
