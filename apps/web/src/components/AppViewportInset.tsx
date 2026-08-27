import type { ComponentProps } from "react";

import { cn } from "../lib/utils";
import { SidebarInset } from "./ui/sidebar";

/**
 * Keep mobile browser chrome changes from resizing the whole application shell.
 * Android browsers can change `dvh` while their address bar or keyboard moves,
 * including at wide landscape and tablet widths. The shell therefore uses the
 * stable viewport at every width. Desktop browsers resolve `svh` to their
 * ordinary viewport and still track normal window resizing. Children inherit
 * that one resolved height instead of starting a second sizing context.
 */
export const APP_SHELL_VIEWPORT_HEIGHT_CLASS = "h-svh! min-h-0!";

export function AppViewportInset({ className, ...props }: ComponentProps<typeof SidebarInset>) {
  return (
    <SidebarInset
      className={cn(
        "h-full min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground",
        className,
      )}
      {...props}
    />
  );
}
