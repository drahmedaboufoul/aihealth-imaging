import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-lg text-sm font-semibold ring-offset-background transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]",
  {
    variants: {
      variant: {
        default: "bg-gradient-to-r from-primary to-primary/90 text-primary-foreground shadow-md shadow-primary/25 hover:shadow-lg hover:shadow-primary/30 hover:from-primary/95 hover:to-primary/85",
        destructive:
          "bg-gradient-to-r from-destructive to-destructive/90 text-destructive-foreground shadow-md shadow-destructive/25 hover:shadow-lg hover:shadow-destructive/30 hover:from-destructive/95 hover:to-destructive/85",
        outline:
          "border-2 border-input bg-background/50 backdrop-blur-sm hover:bg-accent hover:text-accent-foreground hover:border-primary/50 hover:shadow-md",
        secondary:
          "bg-gradient-to-r from-secondary to-secondary/90 text-secondary-foreground shadow-sm hover:shadow-md hover:from-secondary/95 hover:to-secondary/85",
        ghost: "hover:bg-accent/80 hover:text-accent-foreground hover:shadow-sm",
        link: "text-primary underline-offset-4 hover:underline hover:text-primary/80",
        success: "bg-gradient-to-r from-success to-success/90 text-success-foreground shadow-md shadow-success/25 hover:shadow-lg hover:shadow-success/30 hover:from-success/95 hover:to-success/85",
        warning: "bg-gradient-to-r from-warning to-warning/90 text-warning-foreground shadow-md shadow-warning/25 hover:shadow-lg hover:shadow-warning/30 hover:from-warning/95 hover:to-warning/85",
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
