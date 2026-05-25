/**
 * Entity name normalization for deduplication.
 *
 * Problem: agents call the same project by different names:
 *   "CockpitMCP" / "Cockpit MCP" / "cockpit-mcp" / "Cockpit_MCP"
 *   "Linksee Memory" / "LinkseeMemory" / "linksee-memory"
 *   "Sake_Navi" / "Sake Navi"
 *
 * This module provides a single normalizeEntityName() that collapses
 * all these variants to one canonical form for matching.
 */

/**
 * Normalize an entity name for dedup matching.
 *
 * Rules applied (in order):
 *   1. CamelCase split:  "CockpitMCP"    → "Cockpit MCP"
 *   2. Separator → space: "linksee-memory" → "linksee memory"
 *   3. Lowercase:          "Linksee Memory" → "linksee memory"
 *   4. Collapse whitespace
 *   5. Trim
 *
 * The result is used for equality matching (WHERE normalized_name = ?),
 * NOT stored as the display name — the original name is preserved.
 */
export function normalizeEntityName(name: string): string {
  return name
    // CamelCase boundaries: insert space between lowercase→uppercase
    //   "CockpitMCP" → "Cockpit MCP"
    //   "LinkseeMemory" → "Linksee Memory"
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    // Uppercase run followed by uppercase+lowercase:
    //   "MCPServer" → "MCP Server"
    //   "KanseiLINK" → "Kansei LINK"
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    // All separators → space
    .replace(/[-_]/g, ' ')
    // Lowercase everything
    .toLowerCase()
    // Collapse multiple spaces
    .replace(/\s+/g, ' ')
    .trim();
}
