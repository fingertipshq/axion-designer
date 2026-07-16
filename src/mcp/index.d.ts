import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface AxionMcpOptions {
  root?: string;
  timeoutMs?: number;
  maxResourceBytes?: number;
  maxToolBytes?: number;
  allowRemoteProof?: boolean;
  /** Expose only stateless offline intelligence; useful for a plugin-bundled MCP with no project authority. */
  intelligenceOnly?: boolean;
}

export const AXION_MCP_RESOURCE_LIMIT: number;
export const AXION_MCP_TOOL_LIMIT: number;
export const AXION_MCP_TIMEOUT_MS: number;
export function createAxionMcpServer(options?: AxionMcpOptions): McpServer;
export function startAxionMcpStdio(options?: AxionMcpOptions): Promise<McpServer>;
