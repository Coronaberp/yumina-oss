import { Hono, type MiddlewareHandler } from "hono";
import { resolve } from "node:path";
import { env, AUTH_MODE } from "../lib/env.js";
import { authMiddleware } from "../middleware/auth.js";
import { adminMiddleware } from "../middleware/admin.js";
import { githubAuthConfigInput, readGitHubAuthConfig, saveGitHubAuthConfig } from "../lib/github-auth-config.js";
import type { AppEnv } from "../lib/types.js";

export function createLocalAdminRoutes(options: {file?:string;publicOrigin?:string;adminAccountId?:string;authenticate?:MiddlewareHandler<AppEnv>;resolveIdentity?:(login:string)=>Promise<{id:number;login:string}>}={}) {
  const routes=new Hono<AppEnv>();
  const file=options.file||resolve("../../.env");
  const publicOrigin=new URL(options.publicOrigin||env.APP_URL).origin;
  routes.use("*",options.authenticate||authMiddleware,adminMiddleware);
  routes.get("/authentication",c=>{
    c.header("Cache-Control","no-store");
    const saved=readGitHubAuthConfig(file);
    return c.json({data:{...saved,callbackUrl:new URL("/api/auth/callback/github",publicOrigin).href,
      authMode:AUTH_MODE,signInMethod:env.YUMINA_SIGN_IN_METHOD,activeGitHubConfigured:!!env.GITHUB_CLIENT_ID&&!!env.GITHUB_CLIENT_SECRET}});
  });
  routes.patch("/authentication",async c=>{
    const origin=c.req.header("Origin");
    if (!origin || ![publicOrigin,new URL(env.BETTER_AUTH_URL).origin].includes(origin)) return c.json({error:"Untrusted request origin"},403);
    let input;
    try {input=githubAuthConfigInput.parse(await c.req.json());}catch{return c.json({error:"Enter a valid GitHub client ID, secret, and admin username."},400);}
    try {
      const saved=await saveGitHubAuthConfig(file,input,{adminAccountId:options.adminAccountId||env.YUMINA_ADMIN_ACCOUNT_ID||c.get("user").id,publicOrigin,resolveIdentity:options.resolveIdentity});
      return c.json({data:{...saved,restartRequired:true}});
    }catch{return c.json({error:"GitHub configuration could not be saved. Check the admin username and client secret."},400);}
  });
  return routes;
}

export const localAdminRoutes=createLocalAdminRoutes();
