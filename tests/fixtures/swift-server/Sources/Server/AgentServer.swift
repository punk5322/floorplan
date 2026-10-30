import Foundation
import Network

/// A tiny HTTP server for AI agents, on an NWListener: a guide page, sign-in, and one MCP address.
final class AgentServer {
    private var listener: NWListener?

    func respond(_ r: Request) -> Response {
        switch (r.method, r.path) {
        case ("OPTIONS", _): return Response(status: 204)
        case ("GET", "/"), ("GET", "/guide.md"): return .text("Hello")
        case ("GET", let p) where p.hasPrefix("/.well-known/oauth-protected-resource"):
            return .json(["resource": "/mcp", "token_endpoint": "/token"])
        case ("POST", "/token"): return token(r)
        case ("POST", "/mcp"): return mcp(r)
        case (_, "/mcp"): return Response(status: 405)
        default: return Response(status: 404)
        }
    }

    func legacy(_ path: String) -> Response {
        switch path {
        case "/ping", "/health": return .text("ok")
        default: return Response(status: 404)
        }
    }

    func mcp(_ r: Request) -> Response {
        switch r.rpcMethod {
        case "tools/list": return .json(["tools": AgentTools.all.map(\.name)])
        case "initialize": return .json([:])
        default: return Response(status: 400)
        }
    }

    func token(_ r: Request) -> Response {
        if r.path == "/token/refresh" && r.method == "POST" { return .text("refreshed") }
        return .text("token")
    }
}
