export type McpServerScope = 'user' | 'local';

export type McpServerTransport = 'stdio' | 'http' | 'sse';

export type McpServerConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  transport?: string;
};

export type McpServerRecord = {
  id: string;
  name: string;
  scope: McpServerScope | string;
  type: McpServerTransport | string;
  projectPath?: string;
  status?: string;
  description?: string;
  config: McpServerConfig;
  raw?: Record<string, unknown>;
  // New fields for SDK implementation
  isActive?: boolean;
  isTrusted?: boolean;
  trustedAt?: number;
  disabledTools?: string[];
  disabledAutoApproveTools?: string[];
  installSource?: 'builtin' | 'manual' | 'protocol' | 'unknown';
  createdAt?: number;
  updatedAt?: number;
};

export type McpServerList = {
  servers: McpServerRecord[];
};

export type McpServerInput = {
  name: string;
  scope?: 'user' | 'local';
  type: McpServerTransport;
  projectPath?: string | null;
  config: McpServerConfig;
  // Legacy fields (kept for compatibility)
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
};

export type McpServerJsonInput = {
  json: string;
  scope?: 'user' | 'local';
  projectPath?: string | null;
};

export type McpServerRemoveInput = {
  id?: string;
  name?: string;
  scope?: 'user' | 'local';
  projectPath?: string | null;
};

export type McpActionResult = {
  success: boolean;
  message?: string;
  output?: string;
};

export type McpTestResult = {
  success: boolean;
  message: string;
  details?: string[];
  status?: string;
  description?: string;
};

export type McpToolInfo = {
  name: string;
  description?: string;
};

export type McpDiscoverResult = {
  success: boolean;
  message?: string;
  tools: McpToolInfo[];
  resources: McpToolInfo[];
  prompts: McpToolInfo[];
  rawOutput?: string;
};

/**
 * MCP mode controls how MCP servers are used in chat sessions
 * - disabled: MCP is completely disabled
 * - auto: Automatically use all active MCP servers
 * - manual: User manually selects which servers to use
 */
export type McpMode = 'disabled' | 'auto' | 'manual';

/**
 * MCP configuration for a chat session
 */
export type McpSessionConfig = {
  /** MCP usage mode */
  mode: McpMode;
  /** Server IDs selected in manual mode */
  selectedServers?: string[];
};

/**
 * Default MCP session configuration
 */
export const DEFAULT_MCP_SESSION_CONFIG: McpSessionConfig = {
  mode: 'auto',
  selectedServers: []
};

/**
 * MCP Tool definition
 */
export type MCPTool = {
  id: string;                    // Unique tool ID (e.g., mcp__serverName__toolName)
  serverId: string;              // MCP server ID
  serverName: string;            // MCP server name
  name: string;                  // Tool name
  description?: string;          // Tool description
  inputSchema: Record<string, any>;  // JSON Schema for input parameters
  outputSchema?: Record<string, any>; // JSON Schema for output (optional)
  type: 'mcp';                   // Tool type
  isBuiltIn?: boolean;           // Whether this is a built-in tool
};

/**
 * MCP Tool call response content item
 */
export type MCPToolResponseContent = {
  type: 'text' | 'image' | 'audio';
  text?: string;
  mimeType?: string;
  data?: string;  // Base64 encoded for image/audio
};

/**
 * MCP Tool call response
 */
export type MCPCallToolResponse = {
  isError: boolean;
  content: MCPToolResponseContent[];
};
