import Foundation

/// One MCP tool, as tools/list sends it.
struct AgentTool { let name: String; let title: String; let description: String; let input: [String: Any] }

enum AgentTools {
    private static func t(_ name: String, _ title: String, _ description: String, _ input: [String: Any], ro: Bool = false) -> AgentTool {
        AgentTool(name: name, title: title, description: description, input: input)
    }

    /// Every tool the server offers.
    static let all: [AgentTool] = [
        t("get_context", "See everything",
          "The one orientation call: who you are and what's on today. Call it first.",
          ["type": "object"], ro: true),
        t("search", "Search", "Finds items whose name contains the words.", ["type": "object", "properties": ["q": ["type": "string"]]], ro: true),
        t("create_items", "Add items", "Adds one or more items to the list.", ["type": "object"]),
    ]

    /// Not tools: the screens a person can open.
    static let screens = [label("home_screen"), label("settings_screen")]
    static func label(_ s: String) -> String { s }
}
