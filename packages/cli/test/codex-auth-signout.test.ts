// rig auth sign-out: the selected login's matching copies in auth.json and auth-profiles/*.json leave the Codex home; other
// people's and accounts' logins, other homes and files it can't check stay; anything unchecked or not removed reads
// incomplete; no token value reaches a result or output. Fake logins only.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { authCommand } from "../src/commands/auth.js";
import { resolveCodexHome, authSignOut, SIGN_OUT_NOTE } from "../src/lib/codex-auth.js";

const SENTINEL = "SENTINEL_TOKEN_SIGNOUT_MUST_NEVER_APPEAR";
/** A JWT shaped as Codex keeps id_token in auth.json; only the payload's claims are fake-but-real JSON. */
const jwt = (claims: unknown) => `${SENTINEL}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${SENTINEL}-sig`;
const person = (account: string, user: string) => jwt({ "https://api.openai.com/auth": { chatgpt_user_id: user, chatgpt_account_id: account } });
/** A ChatGPT login as Codex writes auth.json: the workspace (account id), the person in its id_token, tokens (refresh
 *  variant r), last refresh. One person per workspace unless named. */
const login = (account: string, r: string, idToken = person(account, `user-${account}`)) => JSON.stringify({ auth_mode: "chatgpt",
  last_refresh: "2026-11-28T07:49:33Z",
  tokens: { id_token: idToken, access_token: `${SENTINEL}-access-${r}`, refresh_token: `${SENTINEL}-refresh-${r}`, account_id: account } });

let root: string;
let paths: ReturnType<typeof resolveCodexHome>;
let other: ReturnType<typeof resolveCodexHome>;
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, text, { mode: 0o600 }); };
const profile = (p: ReturnType<typeof resolveCodexHome>, name: string) => path.join(p.profileDir, `${name}.json`);
const names = (p: ReturnType<typeof resolveCodexHome>) => fs.existsSync(p.profileDir) ? fs.readdirSync(p.profileDir).sort() : [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "codexauth-signout-"));
  paths = resolveCodexHome({ CODEX_HOME: path.join(root, "agents") });
  other = resolveCodexHome({ CODEX_HOME: path.join(root, "other") });
  write(profile(paths, "codex-aaaaaaaaaaaa"), login("acct-A", "r2"));            // a sign-in page's pool copy
  write(profile(paths, "before-switch-20261128T075000.123Z"), login("acct-A", "r1")); // a provider switch's older copy
  write(profile(paths, "codex-bbbbbbbbbbbb"), login("acct-B", "r1"));            // another account
  write(profile(paths, "work"), login("acct-B", "r3"));                          // another account, saved by name
  write(profile(other, "codex-aaaaaaaaaaaa"), login("acct-A", "r2"));            // the same account in another home
});
afterEach(() => { vi.restoreAllMocks(); try { fs.chmodSync(paths.profileDir, 0o700); } catch { /* ignore */ } fs.rmSync(root, { recursive: true, force: true }); });

async function run(args: string[]): Promise<{ out: string; exitCode: number | undefined }> {
  const chunks: string[] = [], log = console.log, err = console.error, code = process.exitCode;
  console.log = (...a: unknown[]) => void chunks.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void chunks.push(a.map(String).join(" "));
  process.exitCode = undefined;
  try {
    await authCommand({ env: { CODEX_HOME: paths.codexHome, HOME: root } }).parseAsync(["sign-out", ...args], { from: "user" });
    return { out: chunks.join("\n"), exitCode: process.exitCode };
  } finally { console.log = log; console.error = err; process.exitCode = code; }
}

describe("authSignOut: the selected login's copies in auth.json and auth-profiles, and nothing else", () => {
  it("the reported failure, then the repair: with the active auth file removed, the saved copies stay; sign-out removes the matching copies of that login", () => {
    write(paths.activeAuth, login("acct-A", "r2"));
    fs.rmSync(paths.activeAuth);   // the reported state after a logout: auth.json gone, the saved copies still there
    expect(names(paths)).toContain("codex-aaaaaaaaaaaa.json");
    const r = authSignOut(paths, "codex-aaaaaaaaaaaa");
    expect(r).toEqual({ ok: true, target: "profile", outcome: "signed_out", removedActive: false,
      removedProfiles: ["before-switch-20261128T075000.123Z", "codex-aaaaaaaaaaaa"], notRemoved: [], keptProfiles: 2, unchecked: [], note: SIGN_OUT_NOTE });
    expect(names(paths)).toEqual(["codex-bbbbbbbbbbbb.json", "work.json"]);
    expect(names(other)).toEqual(["codex-aaaaaaaaaaaa.json"]);   // another home is never touched
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
  });

  it("with no profile named, signs out the active login (a newer refresh) and every saved copy of it", () => {
    write(paths.activeAuth, login("acct-A", "r9"));
    const r = authSignOut(paths);
    expect(r).toMatchObject({ ok: true, target: "active", removedActive: true, removedProfiles: ["before-switch-20261128T075000.123Z", "codex-aaaaaaaaaaaa"], keptProfiles: 2 });
    expect(fs.existsSync(paths.activeAuth)).toBe(false);
  });

  it("keeps the active login when it is another account's", () => {
    write(paths.activeAuth, login("acct-B", "r4"));
    expect(authSignOut(paths, "codex-aaaaaaaaaaaa")).toMatchObject({ ok: true, removedActive: false, keptProfiles: 2 });
    expect(fs.existsSync(paths.activeAuth)).toBe(true);
  });

  it("a repeated sign-out says nothing is left, and changes nothing; the saved profiles it didn't compare aren't called another login", () => {
    authSignOut(paths, "codex-aaaaaaaaaaaa");
    expect(authSignOut(paths, "codex-aaaaaaaaaaaa")).toMatchObject({ ok: true, target: "absent", outcome: "absent", removedActive: false,
      removedProfiles: [], keptProfiles: 0, savedProfiles: 2 });
    expect(authSignOut(paths)).toMatchObject({ ok: true, target: "absent", removedProfiles: [] });
    expect(names(paths)).toEqual(["codex-bbbbbbbbbbbb.json", "work.json"]);
  });

  it("an API-key login, which names no account, matches only byte-identical copies", () => {
    write(paths.activeAuth, JSON.stringify({ OPENAI_API_KEY: `${SENTINEL}-key-1` }));
    write(profile(paths, "key-copy"), JSON.stringify({ OPENAI_API_KEY: `${SENTINEL}-key-1` }));
    write(profile(paths, "key-other"), JSON.stringify({ OPENAI_API_KEY: `${SENTINEL}-key-2` }));
    const r = authSignOut(paths);
    expect(r).toMatchObject({ ok: true, removedActive: true, removedProfiles: ["key-copy"], keptProfiles: 5 });
    expect(names(paths)).toContain("key-other.json");
  });

  it("a linked or unreadable profile is kept and named, never followed; a linked profile folder is named, never read through", () => {
    const outside = path.join(root, "outside.json"), linkedOnly = path.join(root, "linked-only.json");
    write(outside, login("acct-A", "r2"));
    write(linkedOnly, login("acct-A", "r2"));   // the symlink's own single-link file, so only the no-follow guard can stop it
    fs.symlinkSync(linkedOnly, profile(paths, "codex-cccccccccccc"));
    fs.linkSync(outside, profile(paths, "hardlinked"));
    write(profile(paths, "torn"), `{"tokens": {"refresh_token": "${SENTINEL}"`);
    const r = authSignOut(paths, "codex-aaaaaaaaaaaa");
    expect(r).toMatchObject({ ok: true, outcome: "incomplete", removedProfiles: ["before-switch-20261128T075000.123Z", "codex-aaaaaaaaaaaa"],
      unchecked: ["auth-profiles/codex-cccccccccccc.json", "auth-profiles/hardlinked.json", "auth-profiles/torn.json"] });
    expect(fs.lstatSync(profile(paths, "codex-cccccccccccc")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(outside, "utf8")).toContain("acct-A");
    expect(fs.readFileSync(linkedOnly, "utf8")).toContain("acct-A");
    expect(JSON.stringify(r)).not.toContain(SENTINEL);

    const linked = resolveCodexHome({ CODEX_HOME: path.join(root, "linked") });
    fs.mkdirSync(linked.codexHome);
    fs.symlinkSync(paths.profileDir, linked.profileDir);
    expect(authSignOut(linked, "work")).toMatchObject({ ok: true, target: "unchecked", outcome: "incomplete", removedProfiles: [], unchecked: ["auth-profiles/"] });
    expect(names(paths)).toContain("work.json");
  });

  it("refuses a profile name outside the whitelist", () => {
    expect(authSignOut(paths, "../agents/auth")).toEqual({ ok: false, reason: "invalid_profile" });
  });

  it.skipIf(process.getuid?.() === 0)("names a copy it couldn't remove", () => {
    fs.chmodSync(paths.profileDir, 0o500);
    const r = authSignOut(paths, "codex-aaaaaaaaaaaa");
    expect(r).toMatchObject({ ok: true, outcome: "incomplete", removedProfiles: [],
      notRemoved: ["auth-profiles/before-switch-20261128T075000.123Z.json", "auth-profiles/codex-aaaaaaaaaaaa.json"] });
  });
});

describe("rig auth sign-out", () => {
  it("prints what it removed, what it kept and that it didn't revoke; again, that nothing is left; never a token", async () => {
    const first = await run(["--profile", "codex-aaaaaaaaaaaa"]);
    expect(first.exitCode).toBeUndefined();
    expect(first.out).toContain("signed_out: the login saved in codex-aaaaaaaaaaaa");
    expect(first.out).toContain("removed_profiles: before-switch-20261128T075000.123Z, codex-aaaaaaaaaaaa");
    expect(first.out).toContain("kept_profiles: 2");
    expect(first.out).toContain("doesn't revoke the login at OpenAI");
    const again = await run(["--profile", "codex-aaaaaaaaaaaa"]);
    expect(again.exitCode).toBeUndefined();
    expect(again.out).toContain("signed_out: nothing (no profile named codex-aaaaaaaaaaaa in this home)");
    expect(again.out).toContain("removed_profiles: none");
    expect(again.out).toContain("saved_profiles: 2 (not checked; name one with --profile");
    expect(again.out).not.toContain("kept_profiles");
    expect(`${first.out}${again.out}`).not.toContain(SENTINEL);
  });

  it("--json gives a program the same result: names and counts, never a token", async () => {
    const r = await run(["--profile", "codex-aaaaaaaaaaaa", "--json"]);
    expect(r.exitCode).toBeUndefined();
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, target: "profile", outcome: "signed_out",
      removedProfiles: ["before-switch-20261128T075000.123Z", "codex-aaaaaaaaaaaa"], keptProfiles: 2, notRemoved: [] });
    const again = await run(["--profile", "codex-aaaaaaaaaaaa", "--json"]);
    expect(again.exitCode).toBeUndefined();
    expect(JSON.parse(again.out)).toMatchObject({ ok: true, target: "absent", outcome: "absent", removedProfiles: [], keptProfiles: 0, savedProfiles: 2 });
    expect(JSON.parse((await run(["--profile", "../x", "--json"])).out)).toEqual({ ok: false, reason: "invalid_profile" });
    expect(r.out).not.toContain(SENTINEL);
  });

  it.skipIf(process.getuid?.() === 0)("exits 1 when a copy couldn't be removed", async () => {
    fs.chmodSync(paths.profileDir, 0o500);
    const r = await run(["--profile", "codex-aaaaaaaaaaaa"]);
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("incomplete: the login saved in codex-aaaaaaaaaaaa (see not_removed)");
    expect(r.out).not.toContain("signed_out:");
    expect(r.out).toContain("not_removed: auth-profiles/before-switch-20261128T075000.123Z.json, auth-profiles/codex-aaaaaaaaaaaa.json");
  });
});


describe("sign-out reports files it cannot check without removing them", () => {
  it.each(["active", "profile"] as const)("keeps a malformed selected %s file and its identical copy", async selected => {
    const file=selected==="active"?paths.activeAuth:profile(paths,"torn");
    const raw="{not complete JSON";
    write(file,raw);write(profile(paths,"same-torn"),raw);
    const r=await run([...(selected==="profile"?["--profile","torn"]:[]),"--json"]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({target:"unchecked",outcome:"incomplete",removedActive:false,removedProfiles:[],unchecked:[selected==="active"?"auth.json":"auth-profiles/torn.json"]});
    expect(fs.readFileSync(file,"utf8")).toBe(raw);expect(fs.readFileSync(profile(paths,"same-torn"),"utf8")).toBe(raw);
  });
  it.each(["null", "{}", '{"tokens":{}}'])("does not interpret non-login JSON %s as an API-key login", raw=>{
    write(paths.activeAuth,raw);write(profile(paths,"not-login"),raw);
    expect(authSignOut(paths)).toMatchObject({target:"unchecked",outcome:"incomplete",removedActive:false,removedProfiles:[],unchecked:["auth.json"]});
    expect(fs.existsSync(paths.activeAuth)).toBe(true);expect(fs.existsSync(profile(paths,"not-login"))).toBe(true);
  });
  for (const kind of ["symlink", "hardlink", "unreadable"]) it.skipIf(kind === "unreadable" && process.getuid?.() === 0)(`keeps and names a selected ${kind} without claiming sign-out`,async()=>{
    const outside=path.join(root,"kept.json");write(outside,login("acct-A","r9"));
    const selected=profile(paths,"selected");
    if(kind==="symlink")fs.symlinkSync(outside,selected);
    else if(kind==="hardlink")fs.linkSync(outside,selected);
    else {write(selected,login("acct-A","r9"));fs.chmodSync(selected,0);}
    const r=await run(["--profile","selected","--json"]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({target:"unchecked",outcome:"incomplete",removedProfiles:[],unchecked:["auth-profiles/selected.json"]});
    expect(fs.lstatSync(selected)).toBeTruthy();expect(fs.existsSync(outside)).toBe(true);
    const text=await run(["--profile","selected"]);expect(text.exitCode).toBe(1);
    expect(text.out).toContain("incomplete: nothing removed (the login saved in selected could not be checked)");
    expect(text.out).not.toContain("signed_out:");
  });
  it.skipIf(process.getuid?.() === 0)("reports an unreadable profile directory while removing the checked active login",()=>{
    write(paths.activeAuth,login("acct-A","r9"));fs.chmodSync(paths.profileDir,0);
    const r=authSignOut(paths);
    expect(r).toMatchObject({ok:true,outcome:"incomplete",removedActive:true,removedProfiles:[],unchecked:["auth-profiles/"]});
  });
  it("keeps a non-regular profile without waiting for a writer",()=>{
    write(paths.activeAuth,login("acct-A","r9"));
    expect(spawnSync("mkfifo",[profile(paths,"pipe")]).status).toBe(0);
    const script='import {authSignOut,resolveCodexHome} from "@openrig/daemon/codex-auth";console.log(JSON.stringify(authSignOut(resolveCodexHome({CODEX_HOME:process.argv[1]}))));';
    const child=spawnSync(process.execPath,["--input-type=module","-e",script,paths.codexHome],{encoding:"utf8",timeout:3000});
    expect(child.error?.message).toBeUndefined();expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({unchecked:["auth-profiles/pipe.json"]});
    expect(fs.lstatSync(profile(paths,"pipe")).isFIFO()).toBe(true);
  });
  it("names a selected file replaced after its initial read and exits 1",async()=>{
    const selected=profile(paths,"codex-aaaaaaaaaaaa");
    const replacement=profile(paths,"replacement");write(replacement,login("acct-B","r8"));
    const read=fs.readFileSync;let swapped=false;
    vi.spyOn(fs,"readFileSync").mockImplementation(((file: Parameters<typeof fs.readFileSync>[0],...args: unknown[])=>{
      const out=(read as Function)(file,...args);
      if(!swapped&&typeof file==="number") {swapped=true;fs.renameSync(replacement,selected);}
      return out;
    }) as typeof fs.readFileSync);
    const r=await run(["--profile","codex-aaaaaaaaaaaa","--json"]);
    expect(r.exitCode).toBe(1);expect(JSON.parse(r.out).notRemoved).toContain("auth-profiles/codex-aaaaaaaaaaaa.json");
    expect(fs.readFileSync(selected,"utf8")).toContain("acct-B");
  });
  it("names a candidate replaced between its read and removal and exits 1",async()=>{
    const selected=profile(paths,"before-switch-20261128T075000.123Z");
    const replacement=profile(paths,"replacement");write(replacement,login("acct-B","r8"));
    const stat=fs.lstatSync, read=fs.readFileSync, inode=stat(selected).ino;let swapped=false, candidateRead=false;
    vi.spyOn(fs,"readFileSync").mockImplementation(((file: Parameters<typeof fs.readFileSync>[0],...args:unknown[])=>{
      const out=(read as Function)(file,...args);
      if(typeof file==="number"&&fs.fstatSync(file).ino===inode) candidateRead=true;
      return out;
    }) as typeof fs.readFileSync);
    vi.spyOn(fs,"lstatSync").mockImplementation(((file:fs.PathLike,...args:unknown[])=>{
      if(candidateRead&&!swapped&&String(file)===selected){swapped=true;fs.renameSync(replacement,selected);}
      return (stat as Function)(file,...args);
    }) as typeof fs.lstatSync);
    const r=await run(["--profile","codex-aaaaaaaaaaaa","--json"]);
    expect(r.exitCode).toBe(1);expect(JSON.parse(r.out).notRemoved).toContain("auth-profiles/before-switch-20261128T075000.123Z.json");
    expect(fs.readFileSync(selected,"utf8")).toContain("acct-B");
  });
  it("the JSON note names the checked locations and does not imply a scan elsewhere",async()=>{
    const r=await run(["--profile","codex-aaaaaaaaaaaa","--json"]);
    const note=JSON.parse(r.out).note;
    expect(note).toContain("auth.json");expect(note).toContain("auth-profiles/*.json");expect(note).toContain("Other locations are not scanned");
  });
  it("never follows a profile link, even one that passes the first look", () => {
    // The no-follow open is the guard behind the first lstat: make that lstat see a plain file where a link is.
    const outside = path.join(root, "linked-only.json"), linked = profile(paths, "linked");
    write(outside, login("acct-A", "r2"));
    fs.symlinkSync(outside, linked);
    const lstat = fs.lstatSync;
    vi.spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) =>
      String(file) === linked ? lstat(outside) : (lstat as Function)(file, ...args)) as typeof fs.lstatSync);
    const r = authSignOut(paths, "codex-aaaaaaaaaaaa");
    expect(r).toMatchObject({ outcome: "incomplete", removedProfiles: ["before-switch-20261128T075000.123Z", "codex-aaaaaaaaaaaa"], unchecked: ["auth-profiles/linked.json"] });
    expect(lstat(linked).isSymbolicLink()).toBe(true);
  });
});

describe("the same login is the same person in the same workspace", () => {
  it("signs out one person in a shared workspace: their refreshed copies go, a colleague's saved login stays", async () => {
    write(paths.activeAuth, login("acct-T", "r9", person("acct-T", "person-1")));
    write(profile(paths, "me-pool"), login("acct-T", "r2", person("acct-T", "person-1")));
    write(profile(paths, "me-before-switch"), login("acct-T", "r1", person("acct-T", "person-1")));
    write(profile(paths, "colleague"), login("acct-T", "r5", person("acct-T", "person-2")));
    write(profile(other, "me-pool"), login("acct-T", "r2", person("acct-T", "person-1")));
    const r = await run(["--json"]);
    expect(r.exitCode).toBeUndefined();
    expect(JSON.parse(r.out)).toMatchObject({ outcome: "signed_out", removedActive: true, removedProfiles: ["me-before-switch", "me-pool"],
      keptProfiles: 5, unchecked: [] });
    expect(names(paths)).toContain("colleague.json");
    expect(names(other)).toContain("me-pool.json");   // another home is never touched
    expect(r.out).not.toContain(SENTINEL);
    expect(r.out).not.toContain("person-");           // the person id is read, never printed
  });

  it("reads the person the way Codex does: chatgpt_user_id, else the older user_id claim", () => {
    const older = (user: string) => jwt({ "https://api.openai.com/auth": { user_id: user, chatgpt_account_id: "acct-T" } });
    write(profile(paths, "me-old"), login("acct-T", "r1", older("person-1")));
    write(profile(paths, "me-new"), login("acct-T", "r2", person("acct-T", "person-1")));
    write(profile(paths, "colleague-old"), login("acct-T", "r3", older("person-2")));
    expect(authSignOut(paths, "me-old")).toMatchObject({ outcome: "signed_out", removedProfiles: ["me-new", "me-old"], keptProfiles: 5, unchecked: [] });
    expect(names(paths)).toContain("colleague-old.json");
  });

  it("an older login with no person to compare: removes the selected file and its identical copy, keeps and names the rest of that workspace, exits 1", async () => {
    const noPerson = login("acct-T", "r1", jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-T" } }));
    write(paths.activeAuth, noPerson);
    write(profile(paths, "same-bytes"), noPerson);
    write(profile(paths, "me-refreshed"), login("acct-T", "r2", person("acct-T", "person-1")));
    write(profile(paths, "colleague"), login("acct-T", "r3", person("acct-T", "person-2")));
    const r = await run(["--json"]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ outcome: "incomplete", removedActive: true, removedProfiles: ["same-bytes"],
      unchecked: ["auth-profiles/colleague.json", "auth-profiles/me-refreshed.json"], keptProfiles: 4, notRemoved: [] });
    expect(names(paths)).toEqual(expect.arrayContaining(["colleague.json", "me-refreshed.json"]));
  });

  it("a same-workspace copy whose id_token doesn't decode is kept and named, and the sign-out reads incomplete", async () => {
    write(paths.activeAuth, login("acct-T", "r9", person("acct-T", "person-1")));
    write(profile(paths, "mine"), login("acct-T", "r5", person("acct-T", "person-1")));
    write(profile(paths, "garbled"), login("acct-T", "r4", `${SENTINEL}.not-base64-json.${SENTINEL}`));
    write(profile(paths, "two-part"), login("acct-T", "r6", `${SENTINEL}.${SENTINEL}`));
    const r = await run([]);
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("incomplete: the active login (see unchecked)");
    expect(r.out).toContain("removed_profiles: mine");
    expect(r.out).toContain("unchecked (kept; couldn't check whose login): auth-profiles/garbled.json, auth-profiles/two-part.json");
    expect(r.out).not.toContain("signed_out:");
    expect(r.out).not.toContain(SENTINEL);
    expect(names(paths)).toEqual(expect.arrayContaining(["garbled.json", "two-part.json"]));
  });

  for (const damage of ["character", "padding", "trailing-bits", "length-one-mod-four"]) it.each(["selected", "candidate"])(`a base64url payload with ${damage} on the %s side is not treated as an identified person`, async (side) => {
    const valid = person("acct-T", "person-1");
    const parts = valid.split(".");
    // Codex's URL_SAFE_NO_PAD rejects these. Buffer's forgiving decoder accepts the first three; the last is a control.
    if (damage === "character") parts[1] = `!${parts[1]}`;
    else if (damage === "padding") parts[1] += "=";
    else if (damage === "length-one-mod-four") parts[1] += "A".repeat((5 - parts[1]!.length % 4) % 4);
    else {
      let raw = Buffer.from(parts[1]!, "base64url").toString("utf8");
      while (Buffer.byteLength(raw) % 3 !== 1) raw += " ";
      const encoded = Buffer.from(raw).toString("base64url");
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      parts[1] = encoded.slice(0, -1) + alphabet[alphabet.indexOf(encoded.at(-1)!) + 1];
    }
    const damaged = parts.join(".");
    write(paths.activeAuth, login("acct-T", "r1", side === "selected" ? damaged : valid));
    write(profile(paths, "ambiguous"), login("acct-T", "r2", side === "candidate" ? damaged : valid));
    const r = await run(["--json"]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ outcome: "incomplete", removedActive: true, removedProfiles: [], unchecked: ["auth-profiles/ambiguous.json"] });
    expect(fs.existsSync(profile(paths, "ambiguous"))).toBe(true);
    expect(r.out).not.toContain(SENTINEL);
  });

  // Codex stores account_id as null when the login's id_token had no chatgpt_account_id; it is still a ChatGPT login.
  const nullWorkspace = (idToken: string) => JSON.stringify({ auth_mode: "chatgpt",
    tokens: { id_token: idToken, access_token: `${SENTINEL}-access-n`, refresh_token: `${SENTINEL}-refresh-n`, account_id: null } });

  it("a login stored with account_id null takes its workspace from the id_token's chatgpt_account_id, as Codex fills it", async () => {
    write(paths.activeAuth, nullWorkspace(person("acct-T", "person-1")));
    write(profile(paths, "me-pool"), login("acct-T", "r2", person("acct-T", "person-1")));
    write(profile(paths, "colleague"), login("acct-T", "r5", person("acct-T", "person-2")));
    const r = await run(["--json"]);
    expect(r.exitCode).toBeUndefined();
    expect(JSON.parse(r.out)).toMatchObject({ outcome: "signed_out", removedActive: true, removedProfiles: ["me-pool"], keptProfiles: 5, unchecked: [] });
    expect(names(paths)).toContain("colleague.json");
  });

  it("a copy of the same person with no workspace anywhere can't be told apart from a fully known login: kept, named, incomplete", () => {
    write(paths.activeAuth, login("acct-T", "r9", person("acct-T", "person-1")));
    write(profile(paths, "no-workspace"), nullWorkspace(jwt({ "https://api.openai.com/auth": { chatgpt_user_id: "person-1" } })));
    // Neither "the same login" (removed) nor "another login" (kept with a complete result): it can't be told apart.
    expect(authSignOut(paths)).toMatchObject({ outcome: "incomplete", removedActive: true, removedProfiles: [],
      unchecked: ["auth-profiles/no-workspace.json"], keptProfiles: 4 });
    expect(fs.existsSync(profile(paths, "no-workspace"))).toBe(true);
  });

  it("a login with no workspace anywhere: the selected file and its identical copy go, the logins it can't tell apart are named, incomplete", async () => {
    const noWorkspace = nullWorkspace(jwt({ "https://api.openai.com/auth": { chatgpt_user_id: "person-1" } }));
    write(paths.activeAuth, noWorkspace);
    write(profile(paths, "same-bytes"), noWorkspace);
    write(profile(paths, "me-in-a-workspace"), login("acct-T", "r2", person("acct-T", "person-1")));   // the same person, workspace unknown
    write(profile(paths, "colleague"), login("acct-T", "r5", person("acct-T", "person-2")));          // another person: another login
    const r = await run(["--json"]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ outcome: "incomplete", removedActive: true, removedProfiles: ["same-bytes"],
      unchecked: ["auth-profiles/me-in-a-workspace.json"], keptProfiles: 5 });
    expect(names(paths)).toEqual(expect.arrayContaining(["colleague.json", "me-in-a-workspace.json"]));
    expect(r.out).not.toContain(SENTINEL);
  });
});

describe("the profile folder and the selected file, by what they are on disk", () => {
  it("names both the unchecked profile folder and an active file it cannot read", async () => {
    const elsewhere = path.join(paths.codexHome, "moved-profiles");
    fs.renameSync(paths.profileDir, elsewhere);
    fs.symlinkSync(elsewhere, paths.profileDir);
    fs.symlinkSync(profile(other, "codex-aaaaaaaaaaaa"), paths.activeAuth);
    const r = await run(["--json"]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.out)).toMatchObject({ target: "unchecked", outcome: "incomplete", removedActive: false,
      removedProfiles: [], unchecked: ["auth-profiles/", "auth.json"] });
    expect(fs.lstatSync(paths.activeAuth).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(elsewhere)).toHaveLength(4);
    expect(r.out).not.toContain(SENTINEL);
  });

  for (const location of ["inside", "outside"] as const) for (const timing of ["active read", "selected read", "candidate read"] as const) {
    it(`keeps a profile folder changed to an ${location} link after the ${timing}`, async () => {
      write(paths.activeAuth, login("acct-A", "r9"));
      const elsewhere = path.join(location === "inside" ? paths.codexHome : root, "moved-profiles");
      const kept = fs.readdirSync(paths.profileDir).sort();
      const trigger = timing === "active read" ? paths.activeAuth
        : profile(paths, timing === "selected read" ? "codex-aaaaaaaaaaaa" : "before-switch-20261128T075000.123Z");
      const inode = fs.lstatSync(trigger).ino;
      const read = fs.readFileSync;
      let swapped = false;
      const followed: string[] = [];
      for (const name of ["readdirSync", "openSync", "unlinkSync"] as const) {
        const original = fs[name] as unknown as (...args: unknown[]) => unknown;
        vi.spyOn(fs, name).mockImplementation(((p: unknown, ...args: unknown[]) => {
          if (swapped && (String(p) === paths.profileDir || String(p).startsWith(paths.profileDir + path.sep))) followed.push(name);
          return original(p, ...args);
        }) as never);
      }
      vi.spyOn(fs, "readFileSync").mockImplementation(((file: Parameters<typeof fs.readFileSync>[0], ...args: unknown[]) => {
        const out = (read as Function)(file, ...args);
        if (!swapped && typeof file === "number" && fs.fstatSync(file).ino === inode) {
          fs.renameSync(paths.profileDir, elsewhere);
          fs.symlinkSync(elsewhere, paths.profileDir);
          swapped = true;
        }
        return out;
      }) as typeof fs.readFileSync);
      const r = await run([...(timing === "selected read" ? ["--profile", "codex-aaaaaaaaaaaa"] : []), "--json"]);
      expect(swapped).toBe(true);
      expect(followed).toEqual([]);
      expect(r.exitCode).toBe(1);
      expect(JSON.parse(r.out)).toMatchObject({ outcome: "incomplete", removedProfiles: [], unchecked: ["auth-profiles/"] });
      expect(fs.readdirSync(elsewhere).sort()).toEqual(kept);
      expect(r.out).not.toContain(SENTINEL);
    });
  }

  it("a profile folder linked to another folder inside the home is never read or removed through", async () => {
    const elsewhere = path.join(paths.codexHome, "elsewhere", "auth-profiles");
    fs.mkdirSync(path.dirname(elsewhere), { mode: 0o700 });
    fs.renameSync(paths.profileDir, elsewhere);
    fs.symlinkSync(elsewhere, paths.profileDir);
    const kept = fs.readdirSync(elsewhere).sort();
    write(paths.activeAuth, login("acct-A", "r9"));
    const active = await run(["--json"]);   // the active login is still signed out; the linked folder is named
    expect(active.exitCode).toBe(1);
    expect(JSON.parse(active.out)).toMatchObject({ outcome: "incomplete", removedActive: true, removedProfiles: [], unchecked: ["auth-profiles/"] });
    const named = await run(["--profile", "codex-aaaaaaaaaaaa", "--json"]);
    expect(named.exitCode).toBe(1);
    expect(JSON.parse(named.out)).toMatchObject({ target: "unchecked", outcome: "incomplete", removedProfiles: [], unchecked: ["auth-profiles/"] });
    const again = await run([]);   // absent: no count read through the link either
    expect(again.exitCode).toBeUndefined();
    expect(again.out).toContain("signed_out: nothing (no active login in this home)");
    expect(again.out).toContain("unchecked (kept; couldn't check whose login): auth-profiles/");
    expect(again.out).not.toContain("saved_profiles");
    expect(again.out).not.toContain("kept_profiles");
    expect(fs.readdirSync(elsewhere).sort()).toEqual(kept);
  });

  it("another spelling of the selected profile that names the same file is checked once (a case-insensitive volume, simulated)", async () => {
    const real = profile(paths, "codex-aaaaaaaaaaaa"), typed = path.join(paths.profileDir, "CODEX-AAAAAAAAAAAA.json");
    const spelling = (p: unknown) => (String(p) === typed ? real : p);
    for (const name of ["lstatSync", "openSync", "unlinkSync"] as const) {
      const original = fs[name] as unknown as (...args: unknown[]) => unknown;
      vi.spyOn(fs, name).mockImplementation(((p: unknown, ...args: unknown[]) => original(spelling(p), ...args)) as never);
    }
    const r = await run(["--profile", "CODEX-AAAAAAAAAAAA", "--json"]);
    expect(r.exitCode).toBeUndefined();
    expect(JSON.parse(r.out)).toMatchObject({ outcome: "signed_out", removedProfiles: ["before-switch-20261128T075000.123Z", "codex-aaaaaaaaaaaa"], notRemoved: [] });
  });

  const caseInsensitive = (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codexauth-case-"));
    try { fs.writeFileSync(path.join(dir, "a"), ""); return fs.existsSync(path.join(dir, "A")); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  })();
  it.skipIf(!caseInsensitive)("on a case-insensitive volume, --profile in another spelling signs out that file once", async () => {
    const r = await run(["--profile", "CODEX-AAAAAAAAAAAA", "--json"]);
    expect(r.exitCode).toBeUndefined();
    expect(JSON.parse(r.out)).toMatchObject({ outcome: "signed_out", removedProfiles: ["before-switch-20261128T075000.123Z", "codex-aaaaaaaaaaaa"], notRemoved: [] });
  });
});
