import { createFileRoute, redirect } from "@tanstack/react-router";
import { LocalAdminPage } from "@/features/installation/admin-page";
import { getSessionSafe } from "@/lib/auth-client";

export const Route=createFileRoute("/app/admin")({beforeLoad:async()=>{if(!(await getSessionSafe()).data)throw redirect({to:"/login"});},component:LocalAdminPage});
