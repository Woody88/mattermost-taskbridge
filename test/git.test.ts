import { BunServices } from "@effect/platform-bun"
import { expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { ProjectConfig } from "../src/config/ProjectConfig.ts"
import { Git } from "../src/services/Git.ts"

// Regression for obsidian-mcp-server-ktp: prior to the fix, Git.run used
// spawner.string() which reads stdout only and never consults the exit code,
// so a failing `git clone` resolved as success and ensureRepo silently
// returned a path to an empty directory. This test points ensureRepo at a
// definitely-nonexistent local repo URL and asserts we get a GitError.
test("ensureRepo fails with GitError when clone target does not exist", async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tb-git-"))
  try {
    const fakeRepo = path.join(tmpRoot, "definitely-not-a-real-repo.git")

    const project = Schema.decodeUnknownSync(ProjectConfig)({
      key: "ktp-fixture",
      repo: fakeRepo,
      branch: "main",
      display_name: "fixture",
      color: "#000000"
    })

    const program = Effect.gen(function*() {
      const git = yield* Git
      return yield* git.ensureRepo(project, tmpRoot)
    }).pipe(
      Effect.provide(Layer.provide(Git.layer, BunServices.layer))
    )

    const exit = await Effect.runPromiseExit(program)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = exit.cause.toString()
      expect(error).toContain("GitError")
    }

    // And the directory must NOT have been left as a half-cloned shell.
    const cloneTarget = path.join(tmpRoot, "ktp-fixture", ".git")
    const exists = await Bun.file(`${cloneTarget}/HEAD`).exists()
    expect(exists).toBe(false)
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true })
  }
})
