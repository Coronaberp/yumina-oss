import { useState } from "react";
import { Github } from "lucide-react";
import { signIn, signOut } from "@/lib/auth-client";
import { readSafeAuthReturnTo } from "@/lib/auth-return";
import { getLandingRoute } from "@/edition/routes";
import { Button } from "@/components/ui/button";

export function GitHubSignIn({ready}:{ready:boolean}) {
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState(()=>new URLSearchParams(window.location.search).has("error")?"GitHub sign-in could not be completed. Please try again.":"");
  const login=async()=>{
    setBusy(true);setError("");
    try {
      await signOut();
      const result=await signIn.social({provider:"github",callbackURL:readSafeAuthReturnTo(window.location.search)||getLandingRoute()});
      if (result.error) setError("GitHub sign-in could not be started. Please try again.");
    }catch{setError("GitHub sign-in could not be started. Please try again.");}
    finally{setBusy(false);}
  };
  return <div className="space-y-6 rounded-2xl border border-border bg-card/90 p-6 text-center shadow-2xl backdrop-blur-xl">
    <Github className="mx-auto h-10 w-10 text-gold" aria-hidden="true" />
    <div><h1 className="text-2xl font-semibold text-main">Sign in with GitHub</h1><p className="mt-2 text-sm text-sub">Use your GitHub account to access your stories and personas.</p></div>
    <Button className="w-full" size="lg" disabled={!ready||busy} onClick={login}><Github aria-hidden="true" />{busy?"Connecting…":"Sign in with GitHub"}</Button>
    {!ready&&<p className="text-sm text-sub" role="status">GitHub sign-in is being configured by the administrator.</p>}
    {error&&<p className="text-sm text-red-400" role="alert">{error}</p>}
  </div>;
}
