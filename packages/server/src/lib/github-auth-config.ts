import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parse } from "dotenv";

export const githubAuthConfigInput = z.object({
  clientId:z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/),
  clientSecret:z.string().trim().max(256).regex(/^[A-Za-z0-9_.-]*$/).optional(),
  adminGitHubLogin:z.string().trim().min(1).max(39).regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/),
}).strict();
export type GitHubConfigInput = z.infer<typeof githubAuthConfigInput>;

function readAssignments(file:string): Record<string,string> {
  if (!existsSync(file)) return {};
  return parse(readFileSync(file,"utf8"));
}

/** Writes only named assignments. The auth/encryption secret never changes. */
function writeAssignments(file:string,values:Record<string,string>): void {
  const current=existsSync(file)?readFileSync(file,"utf8"):"";
  const remaining=new Set(Object.keys(values));
  const lines=current.split(/\r?\n/).map(line=>{
    const key=/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (!key || !Object.hasOwn(values,key)) return line;
    remaining.delete(key);return `${key}=${JSON.stringify(values[key])}`;
  });
  for (const key of remaining) lines.push(`${key}=${JSON.stringify(values[key])}`);
  const temp=`${file}.${randomUUID()}.tmp`;
  writeFileSync(temp,lines.join("\n").replace(/\n*$/,"\n"),{mode:0o600});
  chmodSync(temp,0o600);renameSync(temp,file);
}

export function readGitHubAuthConfig(file:string) {
  const data=readAssignments(file);
  return {clientId:data.GITHUB_CLIENT_ID||"",secretConfigured:!!data.GITHUB_CLIENT_SECRET,
    ownerLogin:data.YUMINA_ADMIN_GITHUB_LOGIN||"",ownerGitHubId:data.YUMINA_ADMIN_GITHUB_ID||"",
    callbackUrl:data.BETTER_AUTH_URL?new URL("/api/auth/callback/github",data.BETTER_AUTH_URL).href:"",
    adminAccountId:data.YUMINA_ADMIN_ACCOUNT_ID||""};
}

export async function resolveGitHubIdentity(login:string): Promise<{id:number;login:string}> {
  const response=await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`,{headers:{Accept:"application/vnd.github+json","User-Agent":"Yumina"},signal:AbortSignal.timeout(10_000)});
  if (!response.ok) throw new Error("GitHub account could not be found");
  const data=await response.json() as {id?:number;login?:string};
  if (!Number.isSafeInteger(data.id)||!data.login) throw new Error("GitHub returned an invalid account");
  return {id:data.id!,login:data.login};
}

export async function saveGitHubAuthConfig(file:string,input:GitHubConfigInput,options:{adminAccountId:string;publicOrigin:string;resolveIdentity?:(login:string)=>Promise<{id:number;login:string}>}) {
  const parsed=githubAuthConfigInput.parse(input),previous=readAssignments(file);
  const secret=parsed.clientSecret||previous.GITHUB_CLIENT_SECRET;
  if (!secret) throw new Error("A GitHub client secret is required");
  if (!options.adminAccountId) throw new Error("An admin account must be configured first");
  const origin=new URL(options.publicOrigin).origin;
  const identity=await (options.resolveIdentity||resolveGitHubIdentity)(parsed.adminGitHubLogin);
  if (!Number.isSafeInteger(identity.id) || identity.id<=0) throw new Error("GitHub returned an invalid account");
  writeAssignments(file,{GITHUB_CLIENT_ID:parsed.clientId,GITHUB_CLIENT_SECRET:secret,
    YUMINA_AUTH_MODE:"multi-user",YUMINA_SIGN_IN_METHOD:"github",
    YUMINA_ADMIN_ACCOUNT_ID:options.adminAccountId,YUMINA_ADMIN_GITHUB_ID:String(identity.id),YUMINA_ADMIN_GITHUB_LOGIN:identity.login,
    BETTER_AUTH_URL:origin,PUBLIC_ORIGIN:origin});
  return readGitHubAuthConfig(file);
}
