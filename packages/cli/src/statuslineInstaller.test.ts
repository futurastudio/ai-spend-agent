import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  StatuslineInstallerError,
  buildAibillStatusLineSetting,
  installClaudeStatusline,
  manualStatuslineConfigSnippet,
  refreshOwnedStatuslineRunner,
  resolveStatuslinePaths,
  uninstallClaudeStatusline
} from "./statuslineInstaller.js";

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aibill-statusline-installer-"));
  const homeDir = join(root, "home");
  const cwd = join(root, "workspace");
  const claudeDir = join(homeDir, ".claude");
  const runnerSourcePath = join(root, "statusline-source.mjs");
  await mkdir(claudeDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(runnerSourcePath, "#!/usr/bin/env node\nconsole.log('aibill');\n", "utf8");
  return {
    root,
    homeDir,
    cwd,
    claudeDir,
    settingsPath: join(claudeDir, "settings.json"),
    runnerSourcePath
  };
}

async function writeSettings(test: Fixture, value: unknown, raw?: string) {
  await writeFile(test.settingsPath, raw ?? `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function expectInstallerError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error("expected statusline installer failure");
  } catch (error) {
    expect(error).toBeInstanceOf(StatuslineInstallerError);
    expect((error as StatuslineInstallerError).code).toBe(code);
  }
}

describe("Claude statusline installer", () => {
  it("installs the exact command atomically while preserving unknown settings", async () => {
    const test = await fixture();
    const original = '{\n  "theme": "dark",\n  "futureSetting": { "enabled": true }\n}\n';
    await writeSettings(test, {}, original);

    const result = await installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerSourcePath: test.runnerSourcePath,
      now: new Date("2026-08-10T15:00:00.000Z")
    });

    expect(result.action).toBe("installed");
    expect(JSON.parse(await readFile(test.settingsPath, "utf8"))).toEqual({
      theme: "dark",
      futureSetting: { enabled: true },
      statusLine: {
        type: "command",
        command: "node ~/.aibill/bin/statusline.mjs",
        refreshInterval: 30
      }
    });
    expect(await readFile(result.backupPath!, "utf8")).toBe(original);
    expect(await readFile(result.runnerPath, "utf8")).toContain("console.log('aibill')");

    if (process.platform !== "win32") {
      expect((await stat(test.settingsPath)).mode & 0o777).toBe(0o644);
      expect((await stat(result.runnerPath)).mode & 0o777).toBe(0o600);
      expect((await stat(result.receiptPath)).mode & 0o777).toBe(0o600);
      expect((await stat(join(test.homeDir, ".aibill"))).mode & 0o777).toBe(0o700);
    }
  });

  it.each([
    [
      "without a prior statusLine",
      '{\r\n\t"theme":"dark",\r\n\t"futureSetting": {"enabled":true}\r\n}',
      false
    ],
    [
      "with a replaced prior statusLine",
      '{"statusLine":{"command":"~/.claude/custom.sh","type":"command","padding":4},"theme":"light"}  \n\n',
      true
    ]
  ])("restores untouched settings byte-for-byte %s", async (_case, original, replace) => {
    const test = await fixture();
    await writeFile(test.settingsPath, original, "utf8");

    await installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerSourcePath: test.runnerSourcePath,
      replace
    });
    expect(await readFile(test.settingsPath, "utf8")).not.toBe(original);

    await uninstallClaudeStatusline({ homeDir: test.homeDir, cwd: test.cwd });

    expect(await readFile(test.settingsPath)).toEqual(Buffer.from(original));
  });

  it("backs up the absent settings state and creates strict JSON", async () => {
    const test = await fixture();
    const result = await installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerSourcePath: test.runnerSourcePath
    });
    expect(await readFile(result.backupPath!, "utf8")).toBe("");
    expect(JSON.parse(await readFile(test.settingsPath, "utf8"))).toEqual({ statusLine: buildAibillStatusLineSetting() });

    await uninstallClaudeStatusline({ homeDir: test.homeDir, cwd: test.cwd });
    await expect(lstat(test.settingsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not mistake the user settings file for project shadowing when launched from home", async () => {
    const test = await fixture();
    await writeSettings(test, { theme: "dark" });
    const first = await installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.homeDir,
      runnerSourcePath: test.runnerSourcePath
    });
    expect(first.action).toBe("installed");
    expect((await installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.homeDir,
      runnerSourcePath: test.runnerSourcePath
    })).action).toBe("unchanged");
  });

  it("accepts exact packaged runner bytes across the renderer boundary", async () => {
    const test = await fixture();
    const result = await installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerContents: "#!/usr/bin/env node\nconsole.log('runner bytes');\n"
    });
    expect(await readFile(result.runnerPath, "utf8")).toContain("runner bytes");
  });

  it("is an exact no-op when the owned setting and runner are unchanged", async () => {
    const test = await fixture();
    const first = await installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerSourcePath: test.runnerSourcePath,
      now: new Date("2026-08-10T15:00:00.000Z")
    });
    const settingsBefore = await readFile(test.settingsPath, "utf8");
    const backupsBefore = await readdir(join(test.homeDir, ".aibill", "backups"));

    const second = await installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerSourcePath: test.runnerSourcePath,
      now: new Date("2026-08-10T16:00:00.000Z")
    });

    expect(second.action).toBe("unchanged");
    expect(second.backupPath).toBe(first.backupPath);
    expect(await readFile(test.settingsPath, "utf8")).toBe(settingsBefore);
    expect(await readdir(join(test.homeDir, ".aibill", "backups"))).toEqual(backupsBefore);
  });

  it("rejects invalid JSON and non-object JSON without changing it", async () => {
    for (const raw of ["{ trailing", "[]\n", "null\n"]) {
      const test = await fixture();
      await writeFile(test.settingsPath, raw, "utf8");
      await expectInstallerError(installClaudeStatusline({
        homeDir: test.homeDir,
        cwd: test.cwd,
        runnerSourcePath: test.runnerSourcePath
      }), "invalid-settings-json");
      expect(await readFile(test.settingsPath, "utf8")).toBe(raw);
    }
  });

  it("rejects a symbolic-link settings file", async () => {
    const test = await fixture();
    const target = join(test.root, "outside.json");
    await writeFile(target, "{}\n", "utf8");
    await import("node:fs/promises").then(({ symlink }) => symlink(target, test.settingsPath));
    await expectInstallerError(installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerSourcePath: test.runnerSourcePath
    }), "unsafe-settings-file");
    expect(await readFile(target, "utf8")).toBe("{}\n");
  });

  it("refuses a symbolic-link private state directory", async () => {
    const test = await fixture();
    const outside = join(test.root, "outside-state");
    await mkdir(outside);
    await import("node:fs/promises").then(({ symlink }) => symlink(outside, join(test.homeDir, ".aibill")));
    await expectInstallerError(installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerSourcePath: test.runnerSourcePath
    }), "unsafe-settings-file");
    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses a non-aibill statusLine unless replacement is explicit", async () => {
    const test = await fixture();
    const previous = { type: "command", command: "~/.claude/my-line.sh", padding: 2 };
    await writeSettings(test, { theme: "dark", statusLine: previous });

    await expectInstallerError(installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerSourcePath: test.runnerSourcePath
    }), "statusline-conflict");

    const installed = await installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerSourcePath: test.runnerSourcePath,
      replace: true
    });
    expect(installed.action).toBe("installed");

    await writeSettings(test, {
      ...JSON.parse(await readFile(test.settingsPath, "utf8")),
      unrelatedAfterInstall: "keep"
    });
    const removed = await uninstallClaudeStatusline({ homeDir: test.homeDir, cwd: test.cwd });
    expect(removed.runnerRemoved).toBe(true);
    expect(removed.runnerAction).toBe("removed");
    expect(removed.statusLineAction).toBe("restored-prior");
    expect(JSON.parse(await readFile(test.settingsPath, "utf8"))).toEqual({
      theme: "dark",
      statusLine: previous,
      unrelatedAfterInstall: "keep"
    });
  });

  it("never adopts an exact-looking but unowned aibill setting implicitly", async () => {
    const test = await fixture();
    await writeSettings(test, { theme: "dark", statusLine: buildAibillStatusLineSetting() });
    await expectInstallerError(installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerSourcePath: test.runnerSourcePath
    }), "statusline-conflict");
    expect((await installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerSourcePath: test.runnerSourcePath,
      replace: true
    })).action).toBe("installed");
    await uninstallClaudeStatusline({ homeDir: test.homeDir, cwd: test.cwd });
    expect(JSON.parse(await readFile(test.settingsPath, "utf8"))).toEqual({
      theme: "dark",
      statusLine: buildAibillStatusLineSetting()
    });
  });

  it("requires explicit replacement for an unowned runner and restores its exact bytes and mode", async () => {
    const test = await fixture();
    const paths = resolveStatuslinePaths(test.homeDir, test.cwd);
    const prior = Buffer.from([0, 1, 2, 250, 255]);
    await mkdir(join(test.homeDir, ".aibill", "bin"), { recursive: true });
    await writeFile(paths.runnerPath, prior);
    await chmod(paths.runnerPath, 0o640);
    await expectInstallerError(installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerSourcePath: test.runnerSourcePath
    }), "statusline-conflict");

    await installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerSourcePath: test.runnerSourcePath,
      replace: true,
      now: new Date("2026-08-10T15:01:00.000Z")
    });
    const removed = await uninstallClaudeStatusline({ homeDir: test.homeDir, cwd: test.cwd });
    expect(removed.runnerAction).toBe("restored");
    expect(await readFile(paths.runnerPath)).toEqual(prior);
    if (process.platform !== "win32") expect((await stat(paths.runnerPath)).mode & 0o777).toBe(0o640);
  });

  it.each([
    ["project", "settings.json"],
    ["local", "settings.local.json"]
  ])("refuses %s settings that shadow the user statusLine", async (_scope, filename) => {
    const test = await fixture();
    const projectClaude = join(test.cwd, ".claude");
    await mkdir(projectClaude, { recursive: true });
    await writeFile(join(projectClaude, filename), JSON.stringify({ statusLine: { type: "command", command: "other" } }));
    await expectInstallerError(installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerSourcePath: test.runnerSourcePath
    }), "settings-shadowed");
  });

  it("finds project and local shadows when launched from a nested repository directory", async () => {
    for (const filename of ["settings.json", "settings.local.json"]) {
      const test = await fixture();
      const repository = join(test.cwd, "repository");
      const nested = join(repository, "packages", "app", "src");
      await mkdir(join(repository, ".git"), { recursive: true });
      await mkdir(join(repository, ".claude"), { recursive: true });
      await mkdir(nested, { recursive: true });
      await writeFile(join(repository, ".claude", filename), JSON.stringify({
        statusLine: { type: "command", command: "repository-owned" }
      }));
      await expectInstallerError(installClaudeStatusline({
        homeDir: test.homeDir,
        cwd: nested,
        runnerSourcePath: test.runnerSourcePath
      }), "settings-shadowed");
    }
  });

  it("refuses managed settings that shadow the user statusLine", async () => {
    const test = await fixture();
    const managed = join(test.root, "managed-settings.json");
    await writeFile(managed, JSON.stringify({ statusLine: { type: "command", command: "managed" } }));
    await expectInstallerError(installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerSourcePath: test.runnerSourcePath,
      managedSettingsPaths: [managed]
    }), "settings-shadowed");
  });

  it("uses narrow project and local path overrides for isolated host checks", async () => {
    const test = await fixture();
    const isolatedProjectSettings = join(test.root, "isolated-project.json");
    const isolatedLocalSettings = join(test.root, "isolated-local.json");
    await writeFile(isolatedProjectSettings, "{}\n");
    await writeFile(isolatedLocalSettings, JSON.stringify({ statusLine: { type: "command", command: "shadow" } }));
    await expectInstallerError(installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerSourcePath: test.runnerSourcePath,
      pathOverrides: {
        projectSettingsPath: isolatedProjectSettings,
        localSettingsPath: isolatedLocalSettings
      }
    }), "settings-shadowed");
  });

  it("refuses effective disableAllHooks and respects closer-scope false", async () => {
    const blocked = await fixture();
    await writeSettings(blocked, { disableAllHooks: true });
    await expectInstallerError(installClaudeStatusline({
      homeDir: blocked.homeDir,
      cwd: blocked.cwd,
      runnerSourcePath: blocked.runnerSourcePath
    }), "hooks-disabled");

    const allowed = await fixture();
    await writeSettings(allowed, { disableAllHooks: true });
    await mkdir(join(allowed.cwd, ".claude"), { recursive: true });
    await writeFile(join(allowed.cwd, ".claude", "settings.json"), JSON.stringify({ disableAllHooks: false }));
    expect((await installClaudeStatusline({
      homeDir: allowed.homeDir,
      cwd: allowed.cwd,
      runnerSourcePath: allowed.runnerSourcePath
    })).action).toBe("installed");
  });

  it("refuses a concurrent install edit and preserves the newer settings", async () => {
    const test = await fixture();
    await writeSettings(test, { theme: "dark" });
    await expectInstallerError(installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerSourcePath: test.runnerSourcePath,
      beforeSettingsCommit: async () => {
        await writeSettings(test, { theme: "light", concurrent: true });
      }
    }), "concurrent-edit");
    expect(JSON.parse(await readFile(test.settingsPath, "utf8"))).toEqual({ theme: "light", concurrent: true });
    await expect(readFile(join(test.homeDir, ".aibill", "bin", "statusline.mjs"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects a same-byte settings identity swap after replacements are prepared", async () => {
    const test = await fixture();
    const original = '{"theme":"dark"}\n';
    await writeFile(test.settingsPath, original);
    await expectInstallerError(installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerSourcePath: test.runnerSourcePath,
      afterPrepare: async () => {
        const replacement = join(test.root, "same-settings.json");
        await writeFile(replacement, original);
        await rename(replacement, test.settingsPath);
      }
    }), "concurrent-edit");
    expect(await readFile(test.settingsPath, "utf8")).toBe(original);
    await expect(readFile(join(test.homeDir, ".aibill", "bin", "statusline.mjs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("detects a prepared-file mode change and rolls back the earlier runner commit", async () => {
    if (process.platform === "win32") return;
    const test = await fixture();
    const original = '{"theme":"dark"}\n';
    await writeFile(test.settingsPath, original);
    await expectInstallerError(installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerSourcePath: test.runnerSourcePath,
      afterPrepare: async () => {
        const temporary = (await readdir(test.claudeDir)).find((name) => name.startsWith("settings.json.tmp-"));
        expect(temporary).toBeDefined();
        await chmod(join(test.claudeDir, temporary!), 0o600);
      }
    }), "concurrent-edit");
    expect(await readFile(test.settingsPath, "utf8")).toBe(original);
    await expect(lstat(join(test.homeDir, ".aibill", "bin", "statusline.mjs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls runner and settings back exactly when the final receipt destination races", async () => {
    const test = await fixture();
    const original = '{\n  "theme": "dark"\n}\n';
    await writeFile(test.settingsPath, original);
    const receiptPath = join(test.homeDir, ".aibill", "statusline-install-receipt.json");
    await expectInstallerError(installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerSourcePath: test.runnerSourcePath,
      afterPrepare: async () => {
        await writeFile(receiptPath, "concurrent owner\n");
      }
    }), "concurrent-edit");
    expect(await readFile(test.settingsPath, "utf8")).toBe(original);
    await expect(readFile(join(test.homeDir, ".aibill", "bin", "statusline.mjs"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(receiptPath, "utf8")).toBe("concurrent owner\n");
  });

  it("keeps dependencies and recovery backups when the final settings race makes rollback incomplete", async () => {
    const test = await fixture();
    const original = '{\n  "theme": "dark"\n}\n';
    await writeFile(test.settingsPath, original);
    const receiptPath = join(test.homeDir, ".aibill", "statusline-install-receipt.json");
    await expectInstallerError(installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerSourcePath: test.runnerSourcePath,
      now: new Date("2026-08-10T15:02:00.000Z"),
      afterMutationCommit: async (path) => {
        if (path !== receiptPath) return;
        await writeSettings(test, {
          theme: "concurrent",
          statusLine: buildAibillStatusLineSetting()
        });
        await writeFile(receiptPath, "concurrent receipt owner\n");
      }
    }), "concurrent-edit");

    const concurrentSettings = JSON.parse(await readFile(test.settingsPath, "utf8"));
    expect(concurrentSettings.statusLine).toEqual(buildAibillStatusLineSetting());
    const runnerPath = join(test.homeDir, ".aibill", "bin", "statusline.mjs");
    expect(await readFile(runnerPath, "utf8")).toContain("console.log('aibill')");
    expect(await readFile(receiptPath, "utf8")).toBe("concurrent receipt owner\n");
    const backups = await readdir(join(test.homeDir, ".aibill", "backups"));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(test.homeDir, ".aibill", "backups", backups[0]), "utf8")).toBe(original);
  });

  it("refuses a concurrent uninstall edit and leaves ownership intact", async () => {
    const test = await fixture();
    await installClaudeStatusline({ homeDir: test.homeDir, cwd: test.cwd, runnerSourcePath: test.runnerSourcePath });
    await expectInstallerError(uninstallClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      beforeSettingsCommit: async () => {
        const current = JSON.parse(await readFile(test.settingsPath, "utf8"));
        current.concurrent = true;
        await writeSettings(test, current);
      }
    }), "concurrent-edit");
    expect(JSON.parse(await readFile(test.settingsPath, "utf8"))).toMatchObject({ concurrent: true, statusLine: buildAibillStatusLineSetting() });
    expect(await readFile(join(test.homeDir, ".aibill", "statusline-install-receipt.json"), "utf8")).toContain("aibill.statusline_install_receipt");
  });

  it("refuses a same-byte identity replacement after uninstall files are prepared", async () => {
    const test = await fixture();
    await writeSettings(test, { theme: "dark" });
    const installed = await installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerSourcePath: test.runnerSourcePath
    });
    const installedSettings = await readFile(test.settingsPath);
    await expectInstallerError(uninstallClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      afterPrepare: async () => {
        const replacement = join(test.root, "same-installed-settings.json");
        await writeFile(replacement, installedSettings);
        await chmod(replacement, (await stat(test.settingsPath)).mode & 0o777);
        await rename(replacement, test.settingsPath);
      }
    }), "concurrent-edit");
    expect(await readFile(test.settingsPath)).toEqual(installedSettings);
    expect(await readFile(installed.receiptPath, "utf8")).toContain("aibill.statusline_install_receipt");
    expect(await readFile(installed.runnerPath, "utf8")).toContain("console.log('aibill')");
  });

  it("uninstalls only the owned digest and refuses a user-modified statusLine", async () => {
    const test = await fixture();
    await writeSettings(test, { theme: "dark" });
    await installClaudeStatusline({ homeDir: test.homeDir, cwd: test.cwd, runnerSourcePath: test.runnerSourcePath });
    const settings = JSON.parse(await readFile(test.settingsPath, "utf8"));
    settings.statusLine.command = "node ~/.claude/new-user-line.mjs";
    await writeSettings(test, settings);

    await expectInstallerError(uninstallClaudeStatusline({ homeDir: test.homeDir, cwd: test.cwd }), "ownership-mismatch");
    expect(JSON.parse(await readFile(test.settingsPath, "utf8")).statusLine.command).toContain("new-user-line");
  });

  it("removes its key without rolling back unrelated settings", async () => {
    const test = await fixture();
    await writeSettings(test, { theme: "dark", permissions: { allow: ["Read"] } });
    await installClaudeStatusline({ homeDir: test.homeDir, cwd: test.cwd, runnerSourcePath: test.runnerSourcePath });
    const changed = JSON.parse(await readFile(test.settingsPath, "utf8"));
    changed.theme = "light";
    changed.permissions.allow.push("Glob");
    await writeSettings(test, changed);

    await uninstallClaudeStatusline({ homeDir: test.homeDir, cwd: test.cwd });
    expect(JSON.parse(await readFile(test.settingsPath, "utf8"))).toEqual({
      theme: "light",
      permissions: { allow: ["Read", "Glob"] }
    });
  });

  it("preserves a modified runner during uninstall", async () => {
    const test = await fixture();
    const installed = await installClaudeStatusline({ homeDir: test.homeDir, cwd: test.cwd, runnerSourcePath: test.runnerSourcePath });
    await writeFile(installed.runnerPath, "// user changed this\n", "utf8");
    const removed = await uninstallClaudeStatusline({ homeDir: test.homeDir, cwd: test.cwd });
    expect(removed.runnerRemoved).toBe(false);
    expect(removed.runnerAction).toBe("preserved-modified");
    expect(removed.statusLineAction).toBe("removed");
    expect(removed.warnings).toHaveLength(1);
    expect(await readFile(installed.runnerPath, "utf8")).toContain("user changed");
  });

  it("reports an already-missing runner without pretending it removed one", async () => {
    const test = await fixture();
    const installed = await installClaudeStatusline({ homeDir: test.homeDir, cwd: test.cwd, runnerSourcePath: test.runnerSourcePath });
    await rm(installed.runnerPath);
    const removed = await uninstallClaudeStatusline({ homeDir: test.homeDir, cwd: test.cwd });
    expect(removed.runnerRemoved).toBe(false);
    expect(removed.runnerAction).toBe("already-missing");
    expect(removed.warnings).toContain("The installed runner is missing; no runner file was removed.");
  });

  it("refuses an owned update when either the runner or settings ownership changed", async () => {
    const runnerChanged = await fixture();
    const installed = await installClaudeStatusline({
      homeDir: runnerChanged.homeDir,
      cwd: runnerChanged.cwd,
      runnerSourcePath: runnerChanged.runnerSourcePath
    });
    await writeFile(installed.runnerPath, "// modified\n");
    await expectInstallerError(installClaudeStatusline({
      homeDir: runnerChanged.homeDir,
      cwd: runnerChanged.cwd,
      runnerContents: "// new release\n"
    }), "ownership-mismatch");

    const settingsChanged = await fixture();
    await installClaudeStatusline({
      homeDir: settingsChanged.homeDir,
      cwd: settingsChanged.cwd,
      runnerSourcePath: settingsChanged.runnerSourcePath
    });
    await expectInstallerError(installClaudeStatusline({
      homeDir: settingsChanged.homeDir,
      cwd: settingsChanged.cwd,
      runnerContents: "// new release\n",
      afterPrepare: async () => {
        const current = JSON.parse(await readFile(settingsChanged.settingsPath, "utf8"));
        current.concurrent = true;
        await writeSettings(settingsChanged, current);
      }
    }), "ownership-mismatch");
    expect(await readFile(join(settingsChanged.homeDir, ".aibill", "bin", "statusline.mjs"), "utf8")).toContain("console.log('aibill')");
  });

  it("repairs a missing owned runner but never a different one", async () => {
    const test = await fixture();
    const installed = await installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerSourcePath: test.runnerSourcePath
    });
    await rm(installed.runnerPath);
    expect((await installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerSourcePath: test.runnerSourcePath
    })).action).toBe("installed");
    expect(await readFile(installed.runnerPath, "utf8")).toContain("console.log('aibill')");
  });

  it("requires a valid ownership receipt to uninstall", async () => {
    const missing = await fixture();
    await expectInstallerError(uninstallClaudeStatusline({ homeDir: missing.homeDir, cwd: missing.cwd }), "missing-ownership");

    const malformed = await fixture();
    await mkdir(join(malformed.homeDir, ".aibill"), { recursive: true });
    await writeFile(join(malformed.homeDir, ".aibill", "statusline-install-receipt.json"), "{}\n");
    await expectInstallerError(uninstallClaudeStatusline({ homeDir: malformed.homeDir, cwd: malformed.cwd }), "invalid-receipt");
  });

  it("rejects a receipt with an unexpected path, command, digest, or incoherent flags", async () => {
    for (const mutate of [
      (value: Record<string, unknown>) => { value.runnerPath = "/tmp/elsewhere"; },
      (value: Record<string, unknown>) => { value.backupPath = "/tmp/escaped-backup.json"; },
      (value: Record<string, unknown>) => { value.installedAt = "yesterday"; },
      (value: Record<string, any>) => { value.installedStatusLine.command = "node /tmp/other.mjs"; },
      (value: Record<string, unknown>) => { value.settingsBackupDigest = "0".repeat(64); },
      (value: Record<string, unknown>) => { value.priorFileExisted = false; value.priorHadStatusLine = true; value.priorStatusLine = {}; }
    ]) {
      const test = await fixture();
      const installed = await installClaudeStatusline({ homeDir: test.homeDir, cwd: test.cwd, runnerSourcePath: test.runnerSourcePath });
      const receipt = JSON.parse(await readFile(installed.receiptPath, "utf8"));
      mutate(receipt);
      await writeFile(installed.receiptPath, `${JSON.stringify(receipt)}\n`);
      await expectInstallerError(uninstallClaudeStatusline({ homeDir: test.homeDir, cwd: test.cwd }), "invalid-receipt");
    }
  });

  it("fails closed when an exact backup is missing or modified", async () => {
    for (const change of ["missing", "modified"] as const) {
      const test = await fixture();
      const installed = await installClaudeStatusline({ homeDir: test.homeDir, cwd: test.cwd, runnerSourcePath: test.runnerSourcePath });
      const receipt = JSON.parse(await readFile(installed.receiptPath, "utf8"));
      if (change === "missing") await rm(receipt.backupPath);
      else await writeFile(receipt.backupPath, "tampered\n");
      await expectInstallerError(uninstallClaudeStatusline({ homeDir: test.homeDir, cwd: test.cwd }), "invalid-receipt");
    }
  });

  it("refuses a concurrent installer lock", async () => {
    const test = await fixture();
    await mkdir(join(test.homeDir, ".aibill"), { recursive: true });
    await writeFile(join(test.homeDir, ".aibill", "statusline-install.lock"), "held\n");
    await expectInstallerError(installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerSourcePath: test.runnerSourcePath
    }), "installer-busy");
  });

  it("recovers only an old well-formed lock owned by a dead pid", async () => {
    const test = await fixture();
    const lockPath = join(test.homeDir, ".aibill", "statusline-install.lock");
    await mkdir(join(test.homeDir, ".aibill"), { recursive: true });
    await writeFile(lockPath, `${JSON.stringify({
      version: 1,
      pid: 2_147_483_647,
      createdAt: "2026-08-10T00:00:00.000Z",
      token: "a".repeat(48)
    }, null, 2)}\n`);
    expect((await installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerSourcePath: test.runnerSourcePath
    })).action).toBe("installed");
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not delete a lock path replaced by another owner before release", async () => {
    const test = await fixture();
    const lockPath = join(test.homeDir, ".aibill", "statusline-install.lock");
    await expectInstallerError(installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerSourcePath: test.runnerSourcePath,
      afterPrepare: async () => {
        await rm(lockPath);
        await writeFile(lockPath, "replacement owner\n");
      }
    }), "installer-busy");
    expect(await readFile(lockPath, "utf8")).toBe("replacement owner\n");
    await expect(lstat(join(test.homeDir, ".aibill", "bin", "statusline.mjs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an unsafe runner source", async () => {
    const test = await fixture();
    await chmod(test.runnerSourcePath, 0o600);
    const target = join(test.root, "runner-target.mjs");
    await writeFile(target, "console.log('target')\n");
    const link = join(test.root, "runner-link.mjs");
    await import("node:fs/promises").then(({ symlink }) => symlink(target, link));
    await expectInstallerError(installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerSourcePath: link
    }), "unsafe-runner-source");
  });

  it("rejects invalid UTF-8, non-finite JSON numbers, and excessive nesting", async () => {
    const invalidUtf8 = await fixture();
    const invalidBytes = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
    await writeFile(invalidUtf8.settingsPath, invalidBytes);
    await expectInstallerError(installClaudeStatusline({
      homeDir: invalidUtf8.homeDir,
      cwd: invalidUtf8.cwd,
      runnerSourcePath: invalidUtf8.runnerSourcePath
    }), "invalid-settings-json");
    expect(await readFile(invalidUtf8.settingsPath)).toEqual(invalidBytes);

    const infinite = await fixture();
    await writeFile(infinite.settingsPath, '{"value":1e999}\n');
    await expectInstallerError(installClaudeStatusline({
      homeDir: infinite.homeDir,
      cwd: infinite.cwd,
      runnerSourcePath: infinite.runnerSourcePath
    }), "invalid-settings-json");

    const deep = await fixture();
    await writeFile(deep.settingsPath, `${"[".repeat(102)}0${"]".repeat(102)}\n`);
    await expectInstallerError(installClaudeStatusline({
      homeDir: deep.homeDir,
      cwd: deep.cwd,
      runnerSourcePath: deep.runnerSourcePath
    }), "invalid-settings-json");
  });

  it("bounds the complete serialized settings before creating backups or mutating files", async () => {
    const test = await fixture();
    const raw = `{"padding":"${"x".repeat(1_048_530)}"}\n`;
    await writeFile(test.settingsPath, raw);
    await expectInstallerError(installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerSourcePath: test.runnerSourcePath
    }), "unsafe-settings-file");
    expect(await readFile(test.settingsPath, "utf8")).toBe(raw);
    await expect(lstat(join(test.homeDir, ".aibill", "backups"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("statusline path and config behavior", () => {
  it("resolves macOS, Linux, and Windows paths without repository paths", () => {
    const mac = resolveStatuslinePaths("/profile/alice", "/work/app", "darwin");
    expect(mac.settingsPath).toBe("/profile/alice/.claude/settings.json");
    expect(mac.runnerPath).toBe("/profile/alice/.aibill/bin/statusline.mjs");
    expect(mac.managedSettingsPath).toBe("/Library/Application Support/ClaudeCode/managed-settings.json");

    const linux = resolveStatuslinePaths("/home/testuser", "/work/app", "linux");
    expect(linux.settingsPath).toBe("/home/testuser/.claude/settings.json");
    expect(linux.managedSettingsPath).toBe("/etc/claude-code/managed-settings.json");

    const windows = resolveStatuslinePaths("C:\\profile\\alice", "D:\\work\\app", "win32");
    expect(windows.settingsPath).toBe("C:\\profile\\alice\\.claude\\settings.json");
    expect(windows.runnerPath).toBe("C:\\profile\\alice\\.aibill\\bin\\statusline.mjs");
    expect(windows.managedSettingsPath).toBe("C:\\Program Files\\ClaudeCode\\managed-settings.json");

    const nonSystemHome = resolveStatuslinePaths("D:\\profile\\alice", "D:\\work\\app", "win32");
    expect(nonSystemHome.managedSettingsPath).toBe("C:\\Program Files\\ClaudeCode\\managed-settings.json");
    const customProgramFiles = resolveStatuslinePaths("D:\\profile\\alice", "D:\\work\\app", "win32", {
      programFilesDir: "E:\\Apps"
    });
    expect(customProgramFiles.managedSettingsPath).toBe("E:\\Apps\\ClaudeCode\\managed-settings.json");
  });

  it("renders the exact cross-platform Claude setting and manual snippet", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(buildAibillStatusLineSetting(platform)).toEqual({
        type: "command",
        command: "node ~/.aibill/bin/statusline.mjs",
        refreshInterval: 30
      });
      expect(JSON.parse(manualStatuslineConfigSnippet(platform))).toEqual({
        statusLine: buildAibillStatusLineSetting(platform)
      });
    }
  });
});

/**
 * C-lane §2.1 (QA-12c): a cache-refreshing CLI run re-copies OUR OWN
 * previously installed runner — never creating an install the user did not
 * ask for.
 */
describe("refreshOwnedStatuslineRunner", () => {
  it("re-copies an owned installed runner when the packaged runtime changed", async () => {
    const test = await fixture();
    await writeSettings(test, {});
    await installClaudeStatusline({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerContents: "#!/usr/bin/env node\nconsole.log('v1 runner');\n",
      now: new Date("2026-08-10T15:00:00.000Z")
    });
    const runnerPath = join(test.homeDir, ".aibill", "bin", "statusline.mjs");
    expect(await readFile(runnerPath, "utf8")).toContain("v1 runner");

    const refreshed = await refreshOwnedStatuslineRunner({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerContents: "#!/usr/bin/env node\nconsole.log('v2 runner');\n",
      now: new Date("2026-08-17T15:00:00.000Z")
    });
    expect(refreshed).toBe("refreshed");
    expect(await readFile(runnerPath, "utf8")).toContain("v2 runner");

    const unchanged = await refreshOwnedStatuslineRunner({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerContents: "#!/usr/bin/env node\nconsole.log('v2 runner');\n"
    });
    expect(unchanged).toBe("unchanged");
  });

  it("does nothing without an ownership receipt — no consent, no install", async () => {
    const test = await fixture();
    await writeSettings(test, {});
    const result = await refreshOwnedStatuslineRunner({
      homeDir: test.homeDir,
      cwd: test.cwd,
      runnerContents: "#!/usr/bin/env node\nconsole.log('uninvited');\n"
    });
    expect(result).toBe("not-installed");
    await expect(readFile(join(test.homeDir, ".aibill", "bin", "statusline.mjs"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(test.settingsPath, "utf8"))).toEqual({});
  });
});
