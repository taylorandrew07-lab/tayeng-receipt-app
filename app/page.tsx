import { redirect } from "next/navigation";

export default function Home() {
  // Proxy sends unauthenticated users to /login; authenticated to dashboard.
  redirect("/dashboard");
}
