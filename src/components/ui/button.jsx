import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils"

/**
 * Button — token-styled variants (audit #23/W6): gradient variants and
 * colored shadows stripped; transitions specify exact properties
 * (animation.md — no `transition-all`).
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-lg text-sm font-semibold transition-[color,background-color,border-color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-accent-hover",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-status-danger-hover",
        outline:
          "border border-input bg-transparent text-labels-primary hover:bg-fills-f1",
        secondary:
          "bg-fills-f1 text-labels-primary hover:bg-fills-f2",
        ghost: "text-labels-primary hover:bg-fills-f1",
        link: "text-accent underline-offset-4 hover:underline",
        success: "bg-success text-success-foreground hover:bg-status-success-hover",
        warning: "bg-warning text-warning-foreground hover:opacity-90",
      },
      size: {
        default: "h-11 px-5 py-2.5",
        sm: "h-9 rounded-md px-4 text-xs",
        lg: "h-12 rounded-lg px-8 text-base",
        icon: "h-11 w-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

const Button = React.forwardRef(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "button"
  return (
    (<Comp
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props} />)
  );
})
Button.displayName = "Button"

export { Button, buttonVariants }
