import Vapor

/// Every address the server answers.
func routes(_ app: Application) throws {
    app.get { req async in "It works!" }
    app.get("hello", ":name") { req -> String in "Hello, \(req.parameters.get("name")!)" }
    let api = app.grouped("api", "v1")
    api.post("login") { req in "ok" }
    api.group("admin") { admin in
        admin.delete("users", ":id") { req in HTTPStatus.noContent }
    }
    try app.register(collection: TodoController())
}
