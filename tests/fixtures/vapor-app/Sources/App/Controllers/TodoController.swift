import Vapor

/// The to-do list's requests.
struct TodoController: RouteCollection {
    func boot(routes: RoutesBuilder) throws {
        let todos = routes.grouped("todos")
        todos.get(use: index)
        todos.post(use: create)
        todos.group(":todoID") { todo in
            todo.on(.PATCH, use: update)
        }
    }
    func index(req: Request) async throws -> [String] { [] }
    func create(req: Request) async throws -> String { "" }
    func update(req: Request) async throws -> String { "" }
}
