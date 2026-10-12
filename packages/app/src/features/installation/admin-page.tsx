import { useEffect, useState } from "react";
import { Github, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface GitHubSettings {clientId:string;secretConfigured:boolean;ownerLogin:string;ownerGitHubId:string;callbackUrl:string;authMode:string;signInMethod:string;activeGitHubConfigured:boolean;restartRequired?:boolean}
export function LocalAdminPage() {
  const [settings,setSettings]=useState<GitHubSettings|null>(null),[error,setError]=useState(""),[notice,setNotice]=useState(""),[saving,setSaving]=useState(false);
  const [clientId,setClientId]=useState(""),[secret,setSecret]=useState(""),[owner,setOwner]=useState("");
  useEffect(()=>{let active=true;void(async()=>{try{const response=await fetch("/api/admin/authentication",{credentials:"include"});if(!response.ok)throw new Error(response.status===403?"Administrator access is required.":"Could not load authentication settings.");const {data}=await response.json() as {data:GitHubSettings};if(active){setSettings(data);setClientId(data.clientId);setOwner(data.ownerLogin);}}catch(e){if(active)setError(e instanceof Error?e.message:"Could not load authentication settings.");}})();return()=>{active=false;};},[]);
  const save=async(event:React.FormEvent)=>{
    event.preventDefault();setSaving(true);setError("");setNotice("");
    try {
      const response=await fetch("/api/admin/authentication",{method:"PATCH",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({clientId,clientSecret:secret,adminGitHubLogin:owner})});
      const body=await response.json() as {data?:GitHubSettings;error?:string};
      if(!response.ok||!body.data)throw new Error(body.error||"Could not save GitHub settings.");
      setSettings(previous=>({...previous!,...body.data!}));setSecret("");setOwner(body.data.ownerLogin);setNotice("Saved. Restart Yumina to apply the GitHub sign-in configuration.");
    }catch(e){setError(e instanceof Error?e.message:"Could not save GitHub settings.");}finally{setSaving(false);}
  };
  return <div data-scroll-restoration-id="local-admin" className="h-full overflow-y-auto">
    <div className="mx-auto w-full max-w-[1000px] space-y-6 px-4 py-8 pb-20 sm:px-8 sm:py-10 sm:pb-20">
      <header className="mb-8"><div className="flex items-center gap-3"><ShieldCheck className="h-7 w-7 shrink-0 text-gold" aria-hidden="true" /><h1 className="text-3xl font-black tracking-tight text-main sm:text-4xl">Administration</h1></div><p className="mt-2 text-sm text-sub">Manage sign-in for this Yumina installation.</p></header>
      {error&&<p role="alert" className="rounded-lg border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-300">{error}</p>}
      {notice&&<p role="status" className="rounded-lg border border-gold/30 bg-gold/10 p-3 text-sm text-gold">{notice}</p>}
      {!settings&&!error&&<p role="status" className="text-sub">Loading authentication settings…</p>}
      {settings&&<section aria-labelledby="admin-github-heading">
        <div className="mb-4 flex items-center gap-2"><div className="h-4 w-1 rounded-full bg-gold" aria-hidden="true" /><Github className="h-4 w-4 text-gold" aria-hidden="true" /><h2 id="admin-github-heading" className="text-lg font-bold text-main">GitHub sign-in</h2></div>
        <div className="clouded-glass-panel rounded-2xl">
        <p className="border-b border-white/[0.06] px-5 py-4 text-sm text-sub sm:px-6">{settings.activeGitHubConfigured?"GitHub is configured.":"Configure GitHub to enable separate user accounts."} Password sign-in is disabled in GitHub mode.</p>
        <form onSubmit={save} className="space-y-5 p-5 sm:p-6">
          <label className="block space-y-2 text-sm"><span>GitHub Client ID</span><Input value={clientId} onChange={e=>setClientId(e.target.value)} required autoComplete="off" className="profile-overview-input-surface border-white/10" /></label>
          <label className="block space-y-2 text-sm"><span>GitHub Client Secret</span><Input type="password" value={secret} onChange={e=>setSecret(e.target.value)} required={!settings.secretConfigured} autoComplete="new-password" className="profile-overview-input-surface border-white/10" placeholder={settings.secretConfigured?"Leave blank to keep the saved secret":"Enter the OAuth app client secret"} /><span className="block text-xs text-sub">{settings.secretConfigured?"A secret is saved on the server.":"The secret is stored on the server and is never returned to the browser."}</span></label>
          <label className="block space-y-2 text-sm"><span>Admin GitHub username</span><Input value={owner} onChange={e=>setOwner(e.target.value)} required autoComplete="off" className="profile-overview-input-surface border-white/10" /><span className="block text-xs text-sub">This GitHub account signs into the existing admin account and retains its stories, personas, and settings.</span></label>
          <label className="block space-y-2 text-sm"><span>Authorization callback URL</span><Input value={settings.callbackUrl} readOnly className="profile-overview-input-surface border-white/10 font-mono text-xs" /><span className="block text-xs text-sub">Use this URL in your GitHub OAuth app settings.</span></label>
          <Button type="submit" disabled={saving}>{saving?"Saving…":"Save GitHub configuration"}</Button>
        </form>
        </div>
      </section>}
    </div>
  </div>;
}
